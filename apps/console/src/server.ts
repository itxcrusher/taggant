/**
 * The console's HTTP server.
 *
 * A plain `node:http` server rendering HTML, the same shape as `services/resolver`, for
 * the reasons in D-018. Everything that matters happens on this side of the wire anyway:
 * the compiler is a native module and publishing is filesystem work.
 *
 * This server has no authentication and is not meant to be reachable from anywhere. It
 * binds to the loopback address unless told otherwise and says so loudly when it is told
 * otherwise, because everything it does, it does with the rights of whoever started it.
 */

import { randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { carriesItsDistance } from "@taggant/compiler";
import { manifestSchema } from "@taggant/manifest";
import { DEFAULT_SCAN_DISTANCE_MM, bundleDirFor, compile, publish, registerCode } from "./operations.js";
import { STYLESHEET } from "./style.js";
import {
  type Notice,
  type TargetView,
  describeProblem,
  errorPage,
  experiencePage,
  indexPage,
  page,
} from "./views.js";
import { type Experience, type Workspace, WorkspaceError, assertId, assertTargetId } from "./workspace.js";

/**
 * Largest request this will read.
 *
 * Artwork and video are uploaded through here, so it cannot be small; it is a bound rather
 * than a policy, and it exists because without one a single request decides how much
 * memory the process uses.
 */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/**
 * How many targets an experience may hold, and how many pieces of content a target may,
 * read out of the manifest schema rather than written here as well.
 *
 * The schema refuses more than this at the next save, which is correct and arrives as a
 * validation error naming a JSON path. An operator adding artwork through a form should
 * meet a sentence instead, before the upload is stored.
 */
const MOST_TARGETS = manifestSchema.properties.targets.maxItems;
const MOST_CONTENT = manifestSchema.$defs.target.properties.content.maxItems;

/**
 * The bound on a form that carries no file.
 *
 * The upload limit is sized for artwork and video and was being applied to a form with
 * three short fields in it. That branch decodes and parses the whole body synchronously,
 * so a 200 MB urlencoded post held the event loop for nine seconds and every other request
 * waited behind it. Nothing this console renders posts more than a few hundred bytes.
 */
const MAX_FORM_BYTES = 64 * 1024;

export interface ConsoleOptions {
  workspace: Workspace;
  /** Where published bundles are written. Each experience gets a folder named by its id. */
  publishRoot: string;
  /** The resolver's link table, written when a code is registered. */
  linkTablePath: string;
  /** Overridden by the tests so they bundle a known runtime build. */
  runtimeDir?: string;
  /** Any further host names it should accept, when it is behind something. */
  hosts?: readonly string[];
}

/**
 * A one-shot message shown after a redirect.
 *
 * Held here rather than put in the URL, because a message in a URL is a message anyone can
 * write: a link could be sent to an operator showing "published successfully" over an
 * experience that was never published. It is escaped either way, and it should still not
 * be possible to say.
 */
/**
 * How many unread notices are held at once.
 *
 * One per operator action that redirects, held for five minutes or until the redirect is
 * followed. A thousand is far more than a person generates and far less than a heap.
 */
const MOST_NOTICES = 1000;

class Notices {
  private readonly held = new Map<string, { notice: Notice; at: number }>();

  put(notice: Notice): string {
    this.sweep();
    const token = randomUUID();
    this.held.set(token, { notice, at: Date.now() });
    // A ceiling, because this was the one quantity in this file without one while every
    // other bound here is commented. A notice is held until its redirect is followed or
    // five minutes pass, and a client that never follows its redirects holds every one:
    // measured at about 1.4 KB per refusal, 4000 of them took the heap from 9.8 to 15.2
    // MB. Small, and only reachable from the same origin, which is local. Dropped oldest
    // first, which is insertion order for a Map, so the notice most likely to still be
    // wanted is the one kept.
    while (this.held.size > MOST_NOTICES) {
      const oldest = this.held.keys().next();
      if (oldest.done) break;
      this.held.delete(oldest.value);
    }
    return token;
  }

  take(token: string | null): Notice | undefined {
    if (!token) return undefined;
    const found = this.held.get(token);
    this.held.delete(token);
    return found?.notice;
  }

  private sweep(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [token, held] of this.held) {
      if (held.at < cutoff) this.held.delete(token);
    }
  }
}

/** The names a console is reached by when nobody has put anything in front of it. */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether the request was addressed to this console rather than to a name pointed at it.
 *
 * Without this, `Host` decides what same-origin means and `Host` is written by whoever is
 * asking. A page held on any name that resolves to the loopback address is same-origin
 * with the console by every other check it makes, so a browser could be walked into
 * rewriting the link table: `Host: evil.example:4000` with a matching `Origin` was
 * accepted, and pointed a printed GTIN at an attacker's URL.
 *
 * The port is taken from the socket the request actually arrived on rather than from
 * configuration, so this is right whatever port it was given, including none.
 */
function addressedToUs(request: IncomingMessage, extra: ReadonlySet<string>): boolean {
  const host = request.headers.host?.toLowerCase();
  if (host === undefined) return false;
  if (extra.has(host)) return true;
  const parts = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  const name = parts?.[1];
  if (name === undefined) return false;
  if (!LOOPBACK_NAMES.has(name) && !extra.has(name)) return false;
  const stated = parts?.[2] === undefined ? 80 : Number(parts[2]);
  const arrivedOn = request.socket.localPort;
  return arrivedOn === undefined || stated === arrivedOn;
}

/**
 * Whether a state-changing request came from this console's own pages.
 *
 * There is no session to steal, but there is a browser: a page on another origin can post
 * a form here, and the operator's browser will send it. `Sec-Fetch-Site` says so directly
 * in every current browser; `Origin` is the fallback and covers the rest. A request
 * carrying neither is not a browser form post, and is refused rather than guessed about.
 *
 * The `Host` check comes first, because everything below compares against it.
 */
function sameOrigin(request: IncomingMessage, extra: ReadonlySet<string>): boolean {
  if (!addressedToUs(request, extra)) return false;
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string") return site === "same-origin" || site === "none";
  const origin = request.headers.origin;
  if (typeof origin === "string") {
    try {
      return new URL(origin).host.toLowerCase() === request.headers.host?.toLowerCase();
    } catch {
      return false;
    }
  }
  return false;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  // Refused before a byte is read where the client said how much it was sending, so the
  // answer arrives instead of a reset. Reading it all and then refusing meant the socket
  // died while the client was still writing, and whoever uploaded a 300 MB video saw a
  // network error rather than the sentence saying there is a limit.
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new WorkspaceError(`that is ${describeSize(declared)} and the limit is ${describeSize(limit)}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > limit) {
        throw new WorkspaceError(`that is larger than the ${describeSize(limit)} limit`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    // A browser that navigated away, a cancelled upload, a laptop that closed. Anything
    // raised while reading a body is the client's circumstance rather than a fault, and
    // arrived as five lines of Node stack in the operator's terminal because it is not a
    // `WorkspaceError` and took the outer path. Nothing can be answered either way, since
    // there is nobody on the socket; what this changes is what gets written down.
    //
    // Unverified, and said so rather than counted. On Node 22 here a client that destroys
    // its socket leaves a request stream that simply ends, so nothing raises and the
    // sentence an operator sees comes from the multipart parser instead. Three shapes were
    // tried and none reached this branch, so it is a net under a path that exists in
    // somebody else's measurement and not in mine.
    throw new WorkspaceError(
      `that upload stopped before it finished, after ${describeSize(total)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return Buffer.concat(chunks);
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * The request's fields, whether it was a plain form or a file upload.
 *
 * Multipart is parsed by Node's own `Request.formData()`. The upload path is the largest
 * attack surface here and the platform's parser is a better one than any written for the
 * occasion.
 */
async function readForm(
  request: IncomingMessage,
  carries: "fields" | "a file" = "fields",
): Promise<FormData> {
  const type = request.headers["content-type"] ?? "";
  const multipart = type.startsWith("multipart/form-data");
  // The limit comes from the route, not from the request. It used to be picked by the
  // client's own Content-Type: anything that declared multipart was allowed 256 MB, so a
  // request to create an experience, which has two short fields in it, could hand this
  // process a quarter of a gigabyte to hold in memory by saying multipart and sending
  // form fields. Two routes take a file and say so; every other route is 64 KB whatever
  // the request calls itself. Multipart is still parsed either way, because a form with
  // no file in it may legally be posted that way.
  const body = await readBody(request, carries === "a file" ? MAX_BODY_BYTES : MAX_FORM_BYTES);
  if (multipart) {
    try {
      return await new Request("http://console.invalid/", {
        method: "POST",
        headers: { "content-type": type },
        body,
      }).formData();
    } catch (error) {
      // An upload that stopped half way is the ordinary case, not a crash. Without this
      // the parser's TypeError became a 500 with a stack trace in the log, which is what
      // a cancelled upload or a dropped connection looks like from a browser.
      throw new WorkspaceError(
        `that upload could not be read, which usually means it was interrupted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const form = new FormData();
  for (const [key, value] of new URLSearchParams(body.toString("utf8"))) form.append(key, value);
  return form;
}

/**
 * Percent-decoding that answers rather than throws.
 *
 * `decodeURIComponent` throws `URIError` on a lone `%`, and that is not a `WorkspaceError`,
 * so `/e/%/targets` was a 500 with a stack trace in the log. A malformed address is the
 * client's mistake and is answered as one.
 */
function decode(segment: string, what: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new WorkspaceError(`${what} is not a readable address: ${segment}`);
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // The console renders no third-party anything and loads nothing from anywhere else.
    "content-security-policy":
      "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  response.end(body);
}

const ROUTES = {
  experience: /^\/e\/([^/]+)$/,
  addTarget: /^\/e\/([^/]+)\/targets$/,
  compile: /^\/e\/([^/]+)\/targets\/([^/]+)\/compile$/,
  content: /^\/e\/([^/]+)\/targets\/([^/]+)\/content$/,
  publish: /^\/e\/([^/]+)\/publish$/,
  code: /^\/e\/([^/]+)\/code$/,
  anyExperience: /^\/e\/([^/]+)/,
} as const;

export function createConsole(options: ConsoleOptions): Server {
  const { workspace, publishRoot, linkTablePath } = options;
  const notices = new Notices();
  const allowed = new Set((options.hosts ?? []).map((name) => name.toLowerCase()));

  /** Everything the experience page needs, read from disk each time it is asked for. */
  const viewFor = async (experience: Experience): Promise<TargetView[]> => {
    const views: TargetView[] = [];
    for (const target of experience.manifest.targets) {
      const view: TargetView = {
        id: target.id,
        source: target.source,
        physicalWidthMm: target.physicalWidthMm,
        contentCount: target.content.length,
      };
      if (await workspace.hasTarget(experience.id, target.id)) {
        const compiled = (await workspace.readTarget(experience.id, target.id)) as {
          report?: TargetView["report"];
          scanDistanceMm?: number;
        };
        // Shown only when this build produced it. An older one holds a width about four
        // times too small, and the page presents that width as the instruction a printer
        // follows, so displaying it is worse than displaying nothing.
        if (compiled.report && !carriesItsDistance(compiled.report)) {
          view.staleReport = true;
        } else if (compiled.report) {
          view.report = compiled.report;
          const needed = compiled.report.minimumWidthMm;
          if (compiled.report.pass && needed !== null && target.physicalWidthMm < needed) {
            // The one thing a person can get wrong here that a press run makes permanent.
            view.tooSmall = `This target is set to print ${target.physicalWidthMm} mm wide and the compile says it needs at least ${needed} mm at that reading distance. Printed as it stands it will not be recognised.`;
          }
        }
      }
      views.push(view);
    }
    return views;
  };

  const showExperience = async (
    response: ServerResponse,
    id: string,
    notice: Notice | undefined,
  ): Promise<void> => {
    const experience = await workspace.read(id);
    html(
      response,
      200,
      page({
        title: `${experience.manifest.title ?? experience.id} - taggant console`,
        workspaceRoot: workspace.root,
        notice,
        body: experiencePage({
          id: experience.id,
          manifest: experience.manifest,
          problems: experience.problems,
          targets: await viewFor(experience),
        }),
      }),
    );
  };

  const redirect = (response: ServerResponse, to: string, notice?: Notice): void => {
    const token = notice ? notices.put(notice) : undefined;
    response.writeHead(303, { location: token ? `${to}?said=${token}` : to, "cache-control": "no-store" });
    response.end();
  };

  const notFound = (response: ServerResponse): void => {
    html(
      response,
      404,
      page({
        title: "Not found",
        workspaceRoot: workspace.root,
        body: errorPage(404, "There is nothing at that address."),
      }),
    );
  };

  async function post(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (path === "/experiences") {
      const form = await readForm(request);
      const id = assertId(field(form, "id"));
      const title = field(form, "title") || id;
      await workspace.create(id, title);
      redirect(response, `/e/${encodeURIComponent(id)}`, {
        tone: "good",
        message: `${title} is ready. Add the artwork that will be printed.`,
      });
      return;
    }

    const added = path.match(ROUTES.addTarget);
    if (added?.[1]) {
      const id = assertId(decode(added[1], "that experience"));
      const experience = await workspace.read(id);
      const form = await readForm(request, "a file");
      const targetId = assertTargetId(field(form, "targetId"));
      const width = Number(field(form, "physicalWidthMm"));
      // A floor of one millimetre rather than of zero. 0.001 was accepted, and a printed
      // width of one micron is not a mistake worth passing on to a compiler.
      if (!Number.isFinite(width) || width < 1 || width > 10000) {
        throw new WorkspaceError(
          `${field(form, "physicalWidthMm")} is not a printed width in millimetres: 1 to 10000`,
        );
      }
      const file = form.get("artwork");
      if (!(file instanceof File) || file.size === 0) throw new WorkspaceError("no artwork was uploaded");
      const source = await workspace.storeFile(
        id,
        "artwork",
        file.name,
        new Uint8Array(await file.arrayBuffer()),
      );
      // Everything from here either names the upload in the manifest or takes it away
      // again. A refusal inside the write is the case this exists for: two forms submitted
      // at the same moment both read a manifest with room, and the one that loses had
      // already stored its file. It left `artwork/<name>.png` named by nothing, while the
      // operator was told the ceiling had been reached, which is the opposite of the
      // property this handler claims. The duplicate-target-id refusal below had the same
      // hole and it is the older of the two.
      try {
        // Read, change and write in one turn. Read and save as separate calls lost three of
        // four targets added at the same moment, because each request had read the manifest
        // before any of the others wrote theirs.
        await workspace.update(id, (manifest) => {
          if (manifest.targets.some((target) => target.id === targetId)) {
            throw new WorkspaceError(`${id} already has a target called ${targetId}`);
          }
          // Inside the turn that writes, which is the only place a count can be trusted:
          // two forms submitted at the same moment both read a manifest with room, and
          // only this runs with the write. There was a second check before the upload was
          // stored, refusing the same thing a moment earlier, and it is gone: it made the
          // two indistinguishable to a test, and the cleanup around this is what actually
          // keeps the promise that a refusal leaves nothing on disk.
          if (manifest.targets.length >= MOST_TARGETS) {
            throw new WorkspaceError(
              `${id} already has ${manifest.targets.length} targets, which is as many as the manifest format allows`,
            );
          }
          return {
            ...manifest,
            targets: [...manifest.targets, { id: targetId, source, physicalWidthMm: width, content: [] }],
          };
        });
      } catch (error) {
        await workspace.forgetFile(id, source);
        throw error;
      }
      redirect(response, `/e/${encodeURIComponent(id)}`, {
        tone: "good",
        message: `${targetId} added. Compile it to find out whether it will track at ${width} mm.`,
      });
      return;
    }

    const compiling = path.match(ROUTES.compile);
    if (compiling?.[1] && compiling[2]) {
      const id = assertId(decode(compiling[1], "that experience"));
      const targetId = decode(compiling[2], "that target");
      const form = await readForm(request);
      const distance = Number(field(form, "scanDistanceMm") || DEFAULT_SCAN_DISTANCE_MM);
      const experience = await workspace.read(id);
      const outcome = await compile(workspace, experience, targetId, distance);
      redirect(response, `/e/${encodeURIComponent(id)}`, {
        tone: outcome.report.pass ? "good" : "warn",
        message: outcome.report.pass
          ? `${targetId} is ready for press.`
          : `${targetId} is not ready, and the reasons are below.`,
      });
      return;
    }

    const contenting = path.match(ROUTES.content);
    if (contenting?.[1] && contenting[2]) {
      const id = assertId(decode(contenting[1], "that experience"));
      const targetId = decode(contenting[2], "that target");
      const experience = await workspace.read(id);
      if (!experience.manifest.targets.some((target) => target.id === targetId)) {
        throw new WorkspaceError(`${id} has no target called ${targetId}`);
      }
      const form = await readForm(request, "a file");
      const type = field(form, "type");
      if (!["image", "video", "model", "audio"].includes(type)) {
        throw new WorkspaceError(`${type} is not a content type the manifest allows`);
      }
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) throw new WorkspaceError("no file was uploaded");
      const src = await workspace.storeFile(id, "media", file.name, new Uint8Array(await file.arrayBuffer()));
      try {
        await workspace.update(id, (manifest) => {
          // Inside the turn that writes, which is the only place a count can be trusted:
          // two forms submitted at the same moment both read a manifest with room, and
          // only this runs with the write. The refusal takes the upload back below.
          const holding = manifest.targets.find((candidate) => candidate.id === targetId);
          if (holding === undefined) {
            // The target existed when the request was checked and does not now. Saying so
            // is the point: the same manifest was rewritten by something else in between,
            // and the alternative, which this had, was to rewrite the manifest unchanged
            // and tell the operator their file was added.
            throw new WorkspaceError(`${id} no longer has a target called ${targetId}`);
          }
          if (holding.content.length >= MOST_CONTENT) {
            throw new WorkspaceError(
              `${targetId} already shows ${holding.content.length} pieces of content, which is as many as the manifest format allows`,
            );
          }
          return {
            ...manifest,
            targets: manifest.targets.map((target) =>
              target.id === targetId
                ? { ...target, content: [...target.content, { type: type as "image", src }] }
                : target,
            ),
          };
        });
      } catch (error) {
        await workspace.forgetFile(id, src);
        throw error;
      }
      redirect(response, `/e/${encodeURIComponent(id)}`, {
        tone: "good",
        message: `${file.name} added to ${targetId}.`,
      });
      return;
    }

    const publishing = path.match(ROUTES.publish);
    if (publishing?.[1]) {
      const id = assertId(decode(publishing[1], "that experience"));
      const experience = await workspace.read(id);
      // Said the way the page says it, rather than as the validator's JSON pointers.
      // `publishable` in the workspace refuses with the raw wording, which is right for a
      // caller that is not a browser, and this is the browser.
      if (experience.problems.length > 0) {
        throw new WorkspaceError(
          `${id} cannot be published yet: ${experience.problems
            .map((problem) => describeProblem(problem, experience.manifest))
            .join(" ")}`,
        );
      }
      const outDir = bundleDirFor(publishRoot, id);
      // Which targets the publish rebuilt, filled in as it goes, because a publish that
      // fails at the bundler has already written any rebuild it did and the operator is
      // owed that either way. The success path used to be the only one that mentioned it.
      const rebuilt: string[] = [];
      let result: Awaited<ReturnType<typeof publish>>;
      try {
        result = await publish(workspace, experience, outDir, {
          onRebuild: (targetId: string, at: number) => rebuilt.push(`${targetId} at ${at} mm`),
          ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
        });
      } catch (error) {
        // Anything rebuilt before the failure is already on disk under a reading distance
        // the operator did not type, and nothing was published, so the two facts have to
        // arrive together or the workspace has quietly changed under them.
        if (rebuilt.length === 0) throw error;
        const why = error instanceof Error ? error.message : String(error);
        throw new WorkspaceError(`${why}. On the way there, ${rebuilt.join(", ")} was compiled again.`);
      }
      // A publish can rebuild a target on the way past: one the runtime cannot read, or one
      // from a build whose print widths were wrong. Which ones, and at what distance, since
      // a distance recovered from an old report or fallen back to the default is a reading
      // distance the operator did not type. Saying so costs a sentence; not saying so was
      // the whole shape of the width defect, where a number went out under a distance
      // nobody named.
      redirect(response, `/e/${encodeURIComponent(id)}`, {
        tone: "good",
        message: `Published ${result.files.length} files.`,
        detail: rebuilt.length > 0 ? `${outDir} (compiled again on the way: ${rebuilt.join(", ")})` : outDir,
      });
      return;
    }

    const coding = path.match(ROUTES.code);
    if (coding?.[1]) {
      const id = assertId(decode(coding[1], "that experience"));
      const form = await readForm(request);
      const href = field(form, "href");
      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        throw new WorkspaceError(`${href} is not an address a code can point at`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new WorkspaceError(`a code can only point at http or https, and this is ${parsed.protocol}`);
      }
      const written = await registerCode(linkTablePath, {
        path: field(form, "path"),
        href,
        title: `Experience ${id}`,
      });
      redirect(response, `/e/${encodeURIComponent(id)}`, {
        tone: "good",
        message: [
          `${written.path} points here.`,
          written.replaced > 0
            ? `${written.replaced} product ${written.replaced === 1 ? "link" : "links"} of that kind ${written.replaced === 1 ? "was" : "were"} replaced.`
            : "",
          written.kept > 0
            ? `${written.kept} other ${written.kept === 1 ? "link" : "links"} on that code ${written.kept === 1 ? "was" : "were"} left alone.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      return;
    }

    notFound(response);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host;
    const url = new URL(request.url ?? "/", `http://${host ?? "console.invalid"}`);
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/console.css") {
      response.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      response.end(STYLESHEET);
      return;
    }

    if (method === "GET" && path === "/") {
      html(
        response,
        200,
        page({
          title: "taggant console",
          workspaceRoot: workspace.root,
          notice: notices.take(url.searchParams.get("said")),
          body: indexPage(await workspace.list()),
        }),
      );
      return;
    }

    const one = path.match(ROUTES.experience);
    if (method === "GET" && one?.[1]) {
      try {
        await showExperience(
          response,
          assertId(decode(one[1], "that experience")),
          notices.take(url.searchParams.get("said")),
        );
      } catch (error) {
        html(
          response,
          404,
          page({ title: "Not found", workspaceRoot: workspace.root, body: errorPage(404, reason(error)) }),
        );
      }
      return;
    }

    if (method !== "POST") {
      notFound(response);
      return;
    }

    if (!sameOrigin(request, allowed)) {
      html(
        response,
        403,
        page({
          title: "Refused",
          workspaceRoot: workspace.root,
          body: errorPage(403, "That request did not come from this console, so it was refused."),
        }),
      );
      return;
    }

    try {
      await post(request, response, path);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        // The operator's own mistake, said plainly, back where they were.
        const back = path.match(ROUTES.anyExperience);
        const id = back?.[1];
        redirect(response, id ? `/e/${id}` : "/", { tone: "bad", message: error.message });
        return;
      }
      throw error;
    }
  }

  return createServer((request, response) => {
    handle(request, response).catch((error) => {
      // Whatever went wrong goes to the log, not to the browser. A stack trace in a page
      // is how the resolver leaked its internals before an adversarial pass caught it.
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      if (response.headersSent) {
        response.end();
        return;
      }
      html(
        response,
        500,
        page({
          title: "Something failed",
          workspaceRoot: workspace.root,
          body: errorPage(500, "Something failed. The reason is in the console's own log."),
        }),
      );
    });
  });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

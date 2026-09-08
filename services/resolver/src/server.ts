import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { DigitalLinkError, SUPPORTED_PRIMARY_KEYS, parseDigitalLink } from "./digital-link.js";
import { Counters, type EventSink, jsonLines } from "./events.js";
import { type LinkTable, candidatesFor, chooseLink } from "./links.js";
import { CONTEXT, buildLinkset } from "./linkset.js";

export interface ResolverOptions {
  /**
   * The link table, or a way of asking for the current one.
   *
   * A function, because the table is mounted from outside the process and the operator is
   * told to edit it. Read once at startup, editing it did nothing and readiness went on
   * reporting the count it had at boot, including after the file had been replaced with
   * something that was not JSON at all.
   */
  table: LinkTable | (() => LinkTable);
  /** Where scan events go. Defaults to one JSON object per line on standard output. */
  events?: EventSink;
  /** Why the table in use is not the one on disk, when that is the case. */
  staleReason?: () => string | null;
  /**
   * The origin this resolver is reached at, used as the subject of the facts it presents.
   * Taken from the Host header when it is not given, which is right for development and
   * wrong behind a proxy, so a deployment should set it.
   */
  origin?: string;
}

const LINKSET_TYPE = "application/linkset+json";
const CONTEXT_PATH = "/.well-known/gs1resolver-context.jsonld";
const DESCRIPTION_PATH = "/.well-known/gs1resolver";
const HEALTH_PATH = "/healthz";
const READY_PATH = "/readyz";
const METRICS_PATH = "/metrics";

/**
 * A GS1 conformant resolver.
 *
 * Written against the conformance criteria GS1 publishes with its resolver test suite. The
 * criteria that are met are met deliberately and are checked one by one in the conformance
 * test; the ones that are not are named in the description file rather than left for
 * someone to discover. Compressed Digital Link URIs are the notable gap.
 */
export function createResolver(options: ResolverOptions): Server {
  const counters = new Counters();
  const sink = options.events ?? jsonLines();
  const emit: EventSink = (event) => {
    counters.record(event);
    sink(event);
  };
  return createServer((request, response) => {
    try {
      handle(request, response, options, emit, counters);
    } catch (error) {
      // Nothing below is expected to throw, so reaching here is this resolver's fault.
      // What went wrong goes to the log, not to whoever asked: an internal error message in
      // a response body tells a stranger about the inside of the process, and this one was
      // reachable from a crafted path.
      sink({
        type: "problem",
        at: new Date().toISOString(),
        reason: `unhandled: ${error instanceof Error ? error.message : String(error)}`,
        path: request.url ?? "",
        status: 500,
      });
      send(response, 500, { "content-type": "text/plain" }, "the resolver could not answer that\n");
    }
  });
}

function currentTable(options: ResolverOptions): LinkTable {
  return typeof options.table === "function" ? options.table() : options.table;
}

function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolverOptions,
  emit: EventSink,
  counters: Counters,
): void {
  const started = performance.now();
  const table = currentTable(options);
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const origin = options.origin ?? `http://${safeHost(request.headers.host)}`;

  // Every response carries these. A resolver that cannot be read from a browser page is
  // not much use to the browsers that scan the codes.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Accept, Accept-Language",
    "access-control-expose-headers": "Link, Location",
  };

  if (method === "OPTIONS") {
    send(response, 204, { ...cors, allow: "GET, HEAD, OPTIONS" }, "");
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    send(response, 405, { ...cors, allow: "GET, HEAD, OPTIONS" }, "method not allowed\n");
    return;
  }

  // Operational endpoints, before anything is parsed as an identifier. Liveness says the
  // process is up; readiness says it has a table worth asking about, which is the thing an
  // orchestrator should wait for before sending traffic.
  if (url.pathname === HEALTH_PATH) {
    send(response, 200, { ...cors, "content-type": "application/json" }, '{"status":"ok"}\n');
    return;
  }
  if (url.pathname === READY_PATH) {
    const identifiers = Object.keys(table.entries).length;
    // Not ready if the table on disk cannot be read, even though an older one is still
    // being served. Answering scans from a table nobody can reproduce, while reporting
    // ready, is how a resolver stays healthy right up until the restart that takes it down.
    const stale = options.staleReason?.() ?? null;
    const ready = identifiers > 0 && stale === null;
    send(
      response,
      ready ? 200 : 503,
      { ...cors, "content-type": "application/json" },
      `${JSON.stringify({
        status: ready ? "ready" : (stale ?? "no links loaded"),
        identifiers,
        ...(stale === null ? {} : { servingOlderTable: true }),
      })}\n`,
    );
    return;
  }
  if (url.pathname === METRICS_PATH) {
    // No cross origin header here on purpose. These counts are for whoever runs the
    // service, and a wildcard let any page on the internet read how much a printed code is
    // being scanned.
    send(response, 200, { "content-type": "text/plain; version=0.0.4" }, counters.render());
    return;
  }

  if (url.pathname === DESCRIPTION_PATH) {
    send(
      response,
      200,
      { ...cors, "content-type": "application/json" },
      JSON.stringify(describe(origin), null, 2),
    );
    return;
  }
  if (url.pathname === CONTEXT_PATH) {
    send(response, 200, { ...cors, "content-type": "application/ld+json" }, JSON.stringify(CONTEXT, null, 2));
    return;
  }

  let link: ReturnType<typeof parseDigitalLink>;
  try {
    link = parseDigitalLink(url.pathname);
  } catch (error) {
    // The standard is explicit that a syntactically invalid URI is a 400, and equally
    // explicit that an error is never dressed up as a 200.
    const message = error instanceof DigitalLinkError ? error.message : "the request could not be read";
    // Not a scan: nothing was identified, so there is nothing to count it against. It is
    // still worth recording, because it is usually a code printed wrong.
    emit({ type: "problem", at: new Date().toISOString(), reason: message, path: url.pathname, status: 400 });
    send(response, 400, { ...cors, "content-type": "text/plain" }, `${message}\n`);
    return;
  }

  const candidates = candidatesFor(table, link);
  const subject = `${origin}${link.stem}${link.canonicalPath}`;
  const linksetUrl = `${subject}?linkType=linkset`;
  const headers: Record<string, string> = {
    ...cors,
    // Pointed at even when redirecting, so a client can always find the whole picture.
    link: [
      `<${linksetUrl}>; rel="linkset"; type="${LINKSET_TYPE}"`,
      `<${origin}${CONTEXT_PATH}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`,
      `<${subject}>; rel="owl:sameAs"`,
    ].join(", "),
  };

  const wantsLinkset =
    url.searchParams.get("linkType") === "linkset" || accepts(request.headers.accept, LINKSET_TYPE);
  const took = (): number => Math.round((performance.now() - started) * 10) / 10;
  const language = request.headers["accept-language"];

  if (wantsLinkset) {
    const body = JSON.stringify(buildLinkset(candidates, `${origin}${link.stem}`), null, 2);
    emit({
      type: "scan",
      at: new Date().toISOString(),
      identifier: link.canonicalPath,
      // An empty linkset is a client learning that nothing is attached to that code, which
      // is the same fact as an unresolved redirect and belongs in the same count. Recording
      // it as a linkset contradicted the definition this file's events are written to.
      outcome: candidates.length === 0 ? "unresolved" : "linkset",
      tookMs: took(),
    });
    send(response, 200, { ...headers, "content-type": LINKSET_TYPE }, body, method === "HEAD");
    return;
  }

  if (candidates.length === 0) {
    // A scan, and the most useful one there is: somebody pointed a camera at a printed
    // thing that nothing was ever assigned to.
    emit({
      type: "scan",
      at: new Date().toISOString(),
      identifier: link.canonicalPath,
      outcome: "unresolved",
      tookMs: took(),
    });
    send(
      response,
      404,
      { ...headers, "content-type": "text/plain" },
      "nothing is linked to that identifier\n",
    );
    return;
  }

  const requested = url.searchParams.get("linkType") ?? undefined;
  const chosen = chooseLink(candidates, {
    linkType: requested,
    acceptLanguage: request.headers["accept-language"],
  });
  if (!chosen) {
    emit({
      type: "scan",
      at: new Date().toISOString(),
      identifier: link.canonicalPath,
      outcome: "unresolved",
      ...(requested === undefined ? {} : { requested }),
      tookMs: took(),
    });
    const reason = requested
      ? `no link of type ${requested} is available for that identifier\n`
      : "no default link is set for that identifier\n";
    send(response, 404, { ...headers, "content-type": "text/plain" }, reason);
    return;
  }

  // Whether the language actually chose: it did if there was more than one link it could
  // have gone to.
  const sameType = candidates.filter((candidate) => candidate.linkType === chosen.linkType);
  const decidedByLanguage = sameType.length > 1;
  const target = withPassedThroughQuery(chosen.href, url);
  emit({
    type: "scan",
    at: new Date().toISOString(),
    identifier: link.canonicalPath,
    outcome: "redirect",
    ...(requested === undefined ? {} : { requested }),
    target,
    // Recorded only when it chose between links, because a language that decided nothing
    // in a report of why a redirect went where it did is noise that reads as a reason.
    ...(language !== undefined && decidedByLanguage ? { language } : {}),
    tookMs: took(),
  });
  send(response, 307, { ...headers, location: target }, "", method === "HEAD");
}

/**
 * Carry the request's own query string on to the target.
 *
 * The standard requires it, and it is what makes a printed code able to carry a campaign
 * parameter without the resolver having to know anything about it. `linkType` is the one
 * thing dropped, because it was an instruction to the resolver rather than to the target.
 */
export function withPassedThroughQuery(href: string, url: URL): string {
  const target = new URL(href);
  for (const [key, value] of url.searchParams) {
    if (key === "linkType") continue;
    target.searchParams.append(key, value);
  }
  return target.toString();
}

function describe(origin: string): Record<string, unknown> {
  return {
    name: "taggant resolver",
    resolverRoot: origin,
    supportedPrimaryKeys: SUPPORTED_PRIMARY_KEYS,
    contextFile: `${origin}${CONTEXT_PATH}`,
    // Said plainly rather than left for a test suite to discover. A resolver that claims
    // conformance it does not have is worse than one that says where it stops.
    notSupported: [
      "compressed GS1 Digital Link URIs, which this resolver neither decompresses nor advertises",
      "HTTP over TLS, which this process does not terminate: it speaks plain HTTP and expects to be reached through something that does",
    ],
  };
}

function send(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
  headOnly = false,
): void {
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(status, { ...headers, "content-length": String(bytes.length) });
  // A HEAD carries the headers a GET would, and no body.
  response.end(headOnly ? undefined : bytes);
}

/**
 * A Host header, if it looks like one, and localhost otherwise.
 *
 * The origin is the subject of every fact this resolver presents, and with none configured
 * it comes from a header the caller sets. `Host: evil.example` anchored a whole linkset
 * there. A deployment should pass `--origin`; this is what stops the default being worse
 * than useless, by refusing anything that is not a plain host and port.
 */
function safeHost(host: string | undefined): string {
  if (host && /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) return host;
  return "localhost";
}

/**
 * Whether an Accept header actually asks for a media type.
 *
 * Matched by substring before, which meant `application/linkset+json;q=0`, whose whole
 * meaning is "not this", returned one, and so did the made up
 * `application/linkset+jsonwhatever`.
 */
export function accepts(header: string | undefined, type: string): boolean {
  if (!header) return false;
  for (const part of header.split(",")) {
    const [name = "", ...parameters] = part.trim().split(";");
    if (name.trim().toLowerCase() !== type) continue;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    return quality === undefined || Number(quality.trim().slice(2)) > 0;
  }
  return false;
}

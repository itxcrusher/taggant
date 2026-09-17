import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { DigitalLinkError, SUPPORTED_PRIMARY_KEYS, parseDigitalLink } from "./digital-link.js";
import { Counters, type EventSink, jsonLines } from "./events.js";
import {
  type LinkTable,
  candidatesFor,
  chooseLink,
  languageMatch,
  parseAcceptLanguage,
  sameLinkType,
} from "./links.js";
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

/**
 * The base the request target is parsed against, and nothing more.
 *
 * A name that cannot resolve, on a reserved top-level domain, so that anything which
 * escaped into a response would be unmistakable rather than plausible. Only the path and
 * the query are ever read from the result.
 */
const PARSE_BASE = "http://request.invalid";

/**
 * The origin used when a deployment configured none.
 *
 * It was the `Host` header, guarded by a pattern that admitted any plain host name, so
 * `Host: evil.example` published that host as the subject of every answer: the linkset
 * anchor, all three `Link` references including `owl:sameAs`, and `resolverRoot` in the
 * description file. The guard's own comment named that case and did not stop it, and the
 * test written for it could not fail, because `fetch` silently replaces a caller-set
 * `host`. So no header decides this now. A resolver that does not know its own name
 * publishes an obviously local one, and the command line refuses to start without being
 * told; an operator behind a proxy sets the origin rather than the resolver reading
 * `X-Forwarded-*`, which would hand the decision back to whoever sends the request.
 */
const LOCAL_ORIGIN = "http://localhost";

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
  // A fixed base, because the only things read from this are the path and the query.
  // It was `http://${request.headers.host}`, which put a caller's header into the
  // subject of every fact below and answered 500 for any Host that is not a URL
  // authority, since parsing threw before anything was validated.
  const url = new URL(request.url ?? "/", PARSE_BASE);
  const origin = options.origin ?? LOCAL_ORIGIN;

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
  // The subject is the origin and the identifier, and nothing else. It used to carry
  // `link.stem`, the part of the path the caller wrote in front of the identifier, so a
  // request for `/anything/i/like/01/09520123456788` published
  // `<origin>/anything/i/like/01/09520123456788` as that product's identity under
  // `owl:sameAs`, with `--origin` set and doing nothing about it. A resolver hosted
  // under a path prefix puts the prefix in its origin, where the operator writes it.
  const subject = `${origin}${link.canonicalPath}`;
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
  // The tags the header actually asks for, ranked, with `q=0` dropped: the same list the
  // choice is made from, so what is recorded cannot disagree with what decided.
  const acceptedTags = parseAcceptLanguage(language).map((tag) => tag.toLowerCase());

  if (wantsLinkset) {
    const body = JSON.stringify(buildLinkset(candidates, origin), null, 2);
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

  // The tag that chose, if one did. This was the raw `Accept-Language` header, recorded
  // whenever more than one link of the type existed, without ever asking whether the header
  // matched: `Accept-Language: de` against an English default and a French alternative
  // recorded `language: "de"` on a redirect to the English link, so a report attributed an
  // English scan to a German speaker. `fr;q=0, de` was recorded as a language although
  // `q=0` means "not acceptable", `*` was recorded as a language, and a four kilobyte
  // header became a four kilobyte field on that line of the operator's log. What is
  // recorded now is the matched tag off the chosen link, which is the only thing that can
  // have decided anything, and nothing is recorded when the choice was not the language's.
  const decided = acceptedTags.reduce<string | undefined>(
    (found, wanted) => found ?? languageMatch(chosen.hreflang, wanted),
    undefined,
  );
  const sameType = candidates.filter((candidate) => sameLinkType(candidate.linkType, chosen.linkType));
  // The table's own href, not the target. The target carries the caller's query string
  // through, which is what the standard asks for and is also whatever a stranger wrote:
  // `?email=alice@example.com&uid=99123` went verbatim into the event, in a log the
  // documents promise holds "nothing that identifies a person". Where a scan was sent, as
  // a report needs it, is the link the table chose.
  const target = withPassedThroughQuery(chosen.href, url);
  emit({
    type: "scan",
    at: new Date().toISOString(),
    identifier: link.canonicalPath,
    outcome: "redirect",
    ...(requested === undefined ? {} : { requested }),
    target: chosen.href,
    ...(decided !== undefined && sameType.length > 1 ? { language: decided } : {}),
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

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { DigitalLinkError, SUPPORTED_PRIMARY_KEYS, parseDigitalLink } from "./digital-link.js";
import { type LinkTable, candidatesFor, chooseLink } from "./links.js";
import { CONTEXT, buildLinkset } from "./linkset.js";

export interface ResolverOptions {
  table: LinkTable;
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

/**
 * A GS1 conformant resolver.
 *
 * Written against the conformance criteria GS1 publishes with its resolver test suite. The
 * criteria that are met are met deliberately and are checked one by one in the conformance
 * test; the ones that are not are named in the description file rather than left for
 * someone to discover. Compressed Digital Link URIs are the notable gap.
 */
export function createResolver(options: ResolverOptions): Server {
  return createServer((request, response) => {
    try {
      handle(request, response, options);
    } catch (error) {
      // Nothing below is expected to throw, so reaching here is this resolver's fault and
      // is reported as such rather than as a bad request.
      send(response, 500, { "content-type": "text/plain" }, `resolver error: ${String(error)}\n`);
    }
  });
}

function handle(request: IncomingMessage, response: ServerResponse, options: ResolverOptions): void {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const origin = options.origin ?? `http://${request.headers.host ?? "localhost"}`;

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
    send(response, 400, { ...cors, "content-type": "text/plain" }, `${message}\n`);
    return;
  }

  const candidates = candidatesFor(options.table, link);
  const linksetUrl = `${origin}${link.canonicalPath}?linkType=linkset`;
  const headers: Record<string, string> = {
    ...cors,
    // Pointed at even when redirecting, so a client can always find the whole picture.
    link: [
      `<${linksetUrl}>; rel="linkset"; type="${LINKSET_TYPE}"`,
      `<${origin}${CONTEXT_PATH}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`,
      `<${origin}${link.canonicalPath}>; rel="owl:sameAs"`,
    ].join(", "),
  };

  const wantsLinkset =
    url.searchParams.get("linkType") === "linkset" || (request.headers.accept ?? "").includes(LINKSET_TYPE);
  if (wantsLinkset) {
    const body = JSON.stringify(buildLinkset(candidates, origin), null, 2);
    send(response, 200, { ...headers, "content-type": LINKSET_TYPE }, body, method === "HEAD");
    return;
  }

  if (candidates.length === 0) {
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
    const reason = requested
      ? `no link of type ${requested} is available for that identifier\n`
      : "no default link is set for that identifier\n";
    send(response, 404, { ...headers, "content-type": "text/plain" }, reason);
    return;
  }

  send(
    response,
    307,
    { ...headers, location: withPassedThroughQuery(chosen.href, url) },
    "",
    method === "HEAD",
  );
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
    supportedLinkType: "all",
    contextFile: `${origin}${CONTEXT_PATH}`,
    // Said plainly rather than left for a test suite to discover. A resolver that claims
    // conformance it does not have is worse than one that says where it stops.
    notSupported: [
      "compressed GS1 Digital Link URIs, which this resolver neither decompresses nor advertises",
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

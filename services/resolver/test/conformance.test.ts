import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LinkTable, parseTable } from "../src/links.js";
import { createResolver } from "../src/server.js";

/**
 * Conformance, criterion by criterion.
 *
 * Each test is named with the requirement it checks, taken from the conformance criteria
 * GS1 publishes alongside its resolver test suite (`ConformantResolver1_0.txt` in
 * gs1/GS1DL-resolver-testsuite, Apache-2.0). That suite is a browser tool with a PHP
 * helper that runs against a deployed resolver, so it is not something a build can run;
 * these tests drive a real resolver over HTTP instead, which is reproducible and can fail
 * a pull request.
 *
 * Where a criterion is not met, there is a test saying so rather than a gap.
 */

const TABLE: LinkTable = parseTable({
  version: 1,
  entries: {
    "/01/09520123456788": [
      {
        href: "https://example.com/product",
        linkType: "gs1:pip",
        title: "Product information page",
        hreflang: ["en"],
        type: "text/html",
        default: true,
      },
      {
        href: "https://example.com/produit",
        linkType: "gs1:pip",
        title: "Page d'information produit",
        hreflang: ["fr"],
        type: "text/html",
      },
      {
        href: "https://example.com/recipes",
        linkType: "gs1:recipeInfo",
        title: "Recipes",
        hreflang: ["en"],
      },
    ],
    "/01/09520123456788/10/ABC": [
      {
        href: "https://example.com/batch/ABC",
        linkType: "gs1:certificationInfo",
        title: "Certification for batch ABC",
        hreflang: ["en"],
      },
    ],
  },
});

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createResolver({ table: TABLE });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Never follow a redirect: what the resolver said is the thing under test. */
function get(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
  return fetch(`${origin}${path}`, { method, headers, redirect: "manual" });
}

/** The shape of a linkset, as far as these tests need to read one. */
interface LinksetBody {
  linkset: Array<Record<string, unknown>>;
}

async function linkset(path: string, headers: Record<string, string> = {}): Promise<LinksetBody> {
  return (await get(path, headers)).json() as Promise<LinksetBody>;
}

async function description(): Promise<Record<string, unknown>> {
  return (await get("/.well-known/gs1resolver")).json() as Promise<Record<string, unknown>>;
}

describe("SHALL support HTTP 1.1 (or higher) GET, HEAD and OPTIONS requests", () => {
  it("answers GET", async () => {
    expect((await get("/01/09520123456788")).status).toBe(307);
  });

  it("answers HEAD with the headers of the GET and no body", async () => {
    const response = await get("/01/09520123456788", {}, "HEAD");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.com/product");
    expect(await response.text()).toBe("");
  });

  it("answers OPTIONS", async () => {
    const response = await get("/01/09520123456788", {}, "OPTIONS");
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toContain("OPTIONS");
  });
});

describe("SHALL support CORS", () => {
  it("allows any origin, on every response", async () => {
    for (const path of ["/01/09520123456788", "/01/bad", "/.well-known/gs1resolver"]) {
      const response = await get(path);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("exposes the headers a browser client needs to read", async () => {
    const exposed = (await get("/01/09520123456788")).headers.get("access-control-expose-headers") ?? "";
    expect(exposed).toContain("Link");
  });
});

describe("SHALL extract and syntactically validate the URI and report errors with 400", () => {
  it("refuses a wrong check digit", async () => {
    const response = await get("/01/09520123456789");
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/check digit/);
  });

  it("refuses a value of the wrong shape, and a qualifier that does not belong", async () => {
    expect((await get("/01/notagtin")).status).toBe(400);
    expect((await get("/01/09520123456788/8011/5")).status).toBe(400);
  });

  it("refuses a path with no identifier in it", async () => {
    expect((await get("/nothing/here")).status).toBe(400);
  });
});

describe("SHALL NOT use a 200 OK response code with a resource that indicates an error", () => {
  it("never answers 200 for anything that went wrong", async () => {
    for (const path of ["/01/09520123456789", "/01/notagtin", "/nothing/here", "/01/09520123456700"]) {
      expect((await get(path)).status).not.toBe(200);
    }
  });
});

describe("SHALL respond to linkType=linkset and to Accept: application/linkset+json", () => {
  it("answers the query parameter with a linkset", async () => {
    const response = await get("/01/09520123456788?linkType=linkset");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
    expect(((await response.json()) as LinksetBody).linkset).toBeInstanceOf(Array);
  });

  it("answers the Accept header the same way", async () => {
    const response = await get("/01/09520123456788", { accept: "application/linkset+json" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
  });
});

describe("Links at each level up to the primary key SHALL be included in the linkset", () => {
  it("includes the product's links when asked about a batch", async () => {
    const body = await linkset("/01/09520123456788/10/ABC?linkType=linkset");
    const anchors = body.linkset.map((entry) => entry.anchor);
    expect(anchors).toContain(`${origin}/01/09520123456788/10/ABC`);
    expect(anchors).toContain(`${origin}/01/09520123456788`);
  });
});

describe("The URI used as the subject of facts presented SHALL be the uncompressed version", () => {
  it("anchors on the canonical form even when asked in the alphabetic form", async () => {
    const body = await linkset("/gtin/09520123456788?linkType=linkset");
    expect(body.linkset[0]?.anchor).toBe(`${origin}/01/09520123456788`);
  });
});

describe("All links SHALL include the target URL, the link type and a link title", () => {
  it("carries all three on every link, and the language where there is one", async () => {
    const body = await linkset("/01/09520123456788?linkType=linkset");
    let checked = 0;
    for (const entry of body.linkset) {
      for (const [relation, targets] of Object.entries(entry)) {
        if (relation === "anchor") continue;
        // The relation name is the link type, and it is a full URI as RFC 9264 requires.
        expect(relation).toMatch(/^https?:\/\//);
        for (const target of targets as Array<Record<string, unknown>>) {
          checked++;
          expect(typeof target.href).toBe("string");
          expect(typeof target.title).toBe("string");
          expect((target.title as string).length).toBeGreaterThan(0);
        }
      }
    }
    // Three levels of loop and a `continue`: an empty linkset, an entry carrying only an
    // anchor, or an empty target array would each take this to green having read nothing.
    expect(checked, "the linkset carried no links, so none were checked").toBeGreaterThan(2);
  });

  it("uses the GS1 Web vocabulary namespace for GS1 link types", async () => {
    const body = await linkset("/01/09520123456788?linkType=linkset");
    expect(Object.keys(body.linkset[0] ?? {})).toContain("https://gs1.org/voc/pip");
  });
});

describe("The resolver SHALL redirect to the default link unless there is a better match", () => {
  it("redirects to the default with a plain request", async () => {
    const response = await get("/01/09520123456788");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.com/product");
  });

  it("uses Accept-Language to choose between links of the same type", async () => {
    const response = await get("/01/09520123456788", { "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" });
    expect(response.headers.get("location")).toBe("https://example.com/produit");
  });
});

describe("SHALL redirect to the requested type of link if available", () => {
  it("goes to the requested type rather than the default", async () => {
    const response = await get("/01/09520123456788?linkType=gs1:recipeInfo");
    expect(response.headers.get("location")).toBe("https://example.com/recipes");
  });

  it("accepts the same link type written as a full URI", async () => {
    const response = await get("/01/09520123456788?linkType=https%3A%2F%2Fgs1.org%2Fvoc%2FrecipeInfo");
    expect(response.headers.get("location")).toBe("https://example.com/recipes");
  });
});

describe("SHALL return 404 if a link of the requested type is not available", () => {
  it("says not found rather than falling back to the default", async () => {
    const response = await get("/01/09520123456788?linkType=gs1:whateverElse");
    expect(response.status).toBe(404);
  });

  it("says not found for an identifier nothing is linked to", async () => {
    expect((await get("/01/09520123456702")).status).toBe(404);
  });
});

describe("By default, SHALL pass on all key=value pairs in the query string when redirecting", () => {
  it("carries the request's own parameters through to the target", async () => {
    const response = await get("/01/09520123456788?utm_source=pack&batch=7");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("utm_source")).toBe("pack");
    expect(location.searchParams.get("batch")).toBe("7");
  });

  it("does not pass on linkType, which was an instruction to the resolver", async () => {
    const response = await get("/01/09520123456788?linkType=gs1:recipeInfo&ref=card");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("linkType")).toBeNull();
    expect(location.searchParams.get("ref")).toBe("card");
  });
});

describe("SHALL provide a resolver description file at /.well-known/gs1resolver", () => {
  it("serves it, and names the primary identifiers it supports", async () => {
    const response = await get("/.well-known/gs1resolver");
    expect(response.status).toBe(200);
    const body = await description();
    expect(body.supportedPrimaryKeys).toContain("01");
    expect(body.supportedPrimaryKeys).toContain("8006");
  });

  it("declares the context file, and serves it as JSON-LD", async () => {
    const body = await description();
    expect(typeof body.contextFile).toBe("string");
    const context = await fetch(String(body.contextFile));
    expect(context.headers.get("content-type")).toBe("application/ld+json");
    const parsed = (await context.json()) as { "@context": Record<string, string> };
    expect(parsed["@context"]?.gs1).toBe("https://gs1.org/voc/");
  });
});

describe("SHOULD expose link to the linkset in an HTTP Link header, even when redirecting", () => {
  it("carries it on a redirect and on a linkset response alike", async () => {
    for (const path of ["/01/09520123456788", "/01/09520123456788?linkType=linkset"]) {
      const header = (await get(path)).headers.get("link") ?? "";
      expect(header).toContain('rel="linkset"');
      expect(header).toContain("application/linkset+json");
    }
  });

  it("points at a JSON-LD context with the relation the standard names", async () => {
    const header = (await get("/01/09520123456788")).headers.get("link") ?? "";
    expect(header).toContain('rel="http://www.w3.org/ns/json-ld#context"');
  });
});

describe("SHOULD tolerate trailing slashes", () => {
  it("answers the same with one as without", async () => {
    const withSlash = await get("/01/09520123456788/");
    expect(withSlash.status).toBe(307);
    expect(withSlash.headers.get("location")).toBe("https://example.com/product");
  });
});

describe("what this resolver does not do", () => {
  it("says so in the description file rather than leaving it to be discovered", async () => {
    const body = await description();
    // Compressed Digital Link URIs are a SHALL in the standard and are not implemented.
    // The gap is declared where a client would look for it.
    expect((body.notSupported as string[]).join(" ")).toMatch(/compressed/i);
  });
});

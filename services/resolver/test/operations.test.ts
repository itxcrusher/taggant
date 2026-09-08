import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "../src/events.js";
import { type LinkTable, parseTable } from "../src/links.js";
import { createResolver } from "../src/server.js";

/**
 * The operational surface: what a scan is, and what an orchestrator can ask.
 *
 * The definition of a scan is the point of these tests. Everyone selling this kind of
 * system counts scans and almost nobody says what one is, which is how two reports of the
 * same week disagree by a factor of three. The definition lives in `events.ts`; these are
 * the cases that pin it.
 */

const TABLE: LinkTable = parseTable({
  version: 1,
  entries: {
    "/01/09520123456788": [
      {
        href: "https://example.com/product",
        linkType: "gs1:pip",
        title: "Product",
        hreflang: ["en"],
        default: true,
      },
      { href: "https://example.com/produit", linkType: "gs1:pip", title: "Produit", hreflang: ["fr"] },
    ],
  },
});

let server: Server;
let origin = "";
let events: Event[] = [];

beforeAll(async () => {
  server = createResolver({ table: TABLE, events: (event) => events.push(event) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  events = [];
});

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, { redirect: "manual", ...init });
}

const scans = (): Event[] => events.filter((event) => event.type === "scan");

describe("what counts as a scan", () => {
  it("counts a redirect, and records where it sent them", async () => {
    await get("/01/09520123456788");
    expect(scans().length).toBe(1);
    const [event] = scans();
    expect(event).toMatchObject({ outcome: "redirect", identifier: "/01/09520123456788" });
    expect(event && "target" in event && event.target).toBe("https://example.com/product");
  });

  it("counts a linkset, because that is also a client getting an answer", async () => {
    await get("/01/09520123456788?linkType=linkset");
    expect(scans()[0]).toMatchObject({ outcome: "linkset" });
  });

  it("counts an identifier nothing is linked to, which is the most useful number here", async () => {
    await get("/01/09520123456702");
    // A real person pointed a camera at a real printed thing. It is how a code that was
    // printed and never assigned gets found.
    expect(scans()[0]).toMatchObject({ outcome: "unresolved", identifier: "/01/09520123456702" });
  });

  it("counts a HEAD, because clients follow links with it", async () => {
    await get("/01/09520123456788", { method: "HEAD" });
    expect(scans().length).toBe(1);
  });

  it("does not count a request that never named an identifier", async () => {
    await get("/nothing/here");
    expect(scans()).toEqual([]);
    expect(events[0]).toMatchObject({ type: "problem", status: 400 });
  });

  it("does not count the description or the context file", async () => {
    await get("/.well-known/gs1resolver");
    await get("/.well-known/gs1resolver-context.jsonld");
    expect(events).toEqual([]);
  });

  it("keeps the language when it decided the choice, and nothing about the person", async () => {
    await get("/01/09520123456788", { headers: { "accept-language": "fr" } });
    const [event] = scans();
    expect(event && "language" in event && event.language).toBe("fr");
    // Nothing identifying anyone: no address, no user agent, no cookie.
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ["at", "identifier", "language", "outcome", "target", "tookMs", "type"].sort(),
    );
  });

  it("does not record a language that decided nothing", async () => {
    // Only one link of this type exists, so the header cannot have chosen between any.
    // Recording it anyway reads, in a report, as the reason the redirect went where it did.
    await get("/01/09520123456788?linkType=gs1:recipeInfo", { headers: { "accept-language": "fr" } });
    await get("/01/09520123456702", { headers: { "accept-language": "fr" } });
    for (const event of scans()) expect("language" in event).toBe(false);
  });
});

describe("what an orchestrator can ask", () => {
  it("answers liveness as long as the process is up", async () => {
    const response = await get("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers readiness only when there is a table worth asking about", async () => {
    const ready = await get("/readyz");
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { identifiers: number }).identifiers).toBe(1);

    const empty = createResolver({ table: { version: 1, entries: {} }, events: () => {} });
    await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve));
    const port = (empty.address() as AddressInfo).port;
    // Serving traffic with no links is answering every scan with a 404, so it is not ready.
    const notReady = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(notReady.status).toBe(503);
    await new Promise<void>((resolve) => empty.close(() => resolve()));
  });

  it("counts what it did, in the format a collector reads", async () => {
    await get("/01/09520123456788");
    await get("/01/09520123456702");
    await get("/nothing/here");
    const body = await (await get("/metrics")).text();
    expect(body).toContain("# TYPE taggant_scans_total counter");
    expect(body).toMatch(/taggant_scans_total\{outcome="redirect"\} [1-9]/);
    expect(body).toMatch(/taggant_scans_total\{outcome="unresolved"\} [1-9]/);
    expect(body).toMatch(/taggant_bad_requests_total [1-9]/);
  });

  it("does not count its own operational endpoints as traffic", async () => {
    await get("/metrics");
    await get("/healthz");
    expect(events).toEqual([]);
  });
});

describe("what a stranger can put in a header", () => {
  it("encodes the path prefix, which is the part the caller writes", async () => {
    // The identifier parts were always encoded; the prefix in front of them was not, and
    // it goes into a Link header and into the subject of every fact in a linkset.
    const response = await get("/%22%3E%3Cscript%3E/01/09520123456788");
    const header = response.headers.get("link") ?? "";
    expect(header).not.toContain('"><script>');
    expect(header).toContain("%22%3E%3Cscript%3E");
  });

  it("answers a path carrying a line break rather than failing on it", async () => {
    // Node refuses to write a header holding a carriage return, so this used to become a
    // 500 whose body carried the internal error text.
    const response = await get("/a%0d%0aX-Injected:%20yes/01/09520123456788");
    expect(response.status).toBe(307);
    expect(response.headers.get("x-injected")).toBeNull();
  });

  it("never puts an internal error message in a response", async () => {
    for (const path of ["/a%0d%0aX/01/09520123456788", "/01/09520123456788"]) {
      const body = await (await get(path)).text();
      expect(body).not.toMatch(/TypeError|ERR_|at Object\./);
    }
  });

  it("does not take a Host header that is not a host", async () => {
    const response = await get("/01/09520123456788?linkType=linkset", {
      headers: { host: "127.0.0.1:1" },
    });
    // A plausible host is used; the guard is on the shape, because nothing here can tell a
    // real Host from a forged one. What a deployment does about that is set --origin.
    expect(response.status).toBe(200);
  });
});

describe("a table that lives outside the process", () => {
  it("answers from whatever the table says now, not what it said at boot", async () => {
    let table = parseTable({
      version: 1,
      entries: {
        "/01/09520123456788": [
          { href: "https://first.example/", linkType: "gs1:pip", title: "T", default: true },
        ],
      },
    });
    const live = createResolver({ table: () => table, events: () => {} });
    await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;

    const before = await fetch(`${at}/01/09520123456788`, { redirect: "manual" });
    expect(before.headers.get("location")).toBe("https://first.example/");

    // The operator edits the mounted file, which is what the instructions tell them to do.
    table = parseTable({
      version: 1,
      entries: {
        "/01/09520123456788": [
          { href: "https://second.example/", linkType: "gs1:pip", title: "T", default: true },
        ],
      },
    });
    const after = await fetch(`${at}/01/09520123456788`, { redirect: "manual" });
    expect(after.headers.get("location")).toBe("https://second.example/");
    await new Promise<void>((resolve) => live.close(() => resolve()));
  });

  it("is not ready while the table on disk cannot be read, even though it still answers", async () => {
    const table = parseTable({
      version: 1,
      entries: {
        "/01/09520123456788": [
          { href: "https://a.example/", linkType: "gs1:pip", title: "T", default: true },
        ],
      },
    });
    const live = createResolver({
      table,
      staleReason: () => "the table on disk could not be read",
      events: () => {},
    });
    await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;

    const ready = await fetch(`${at}/readyz`);
    // Serving scans from a table nobody can reproduce while reporting ready is how a
    // resolver stays healthy right up until the restart that takes it down.
    expect(ready.status).toBe(503);
    expect((await ready.json()) as Record<string, unknown>).toMatchObject({ servingOlderTable: true });
    // The last table that worked keeps answering, rather than dropping every link.
    const scan = await fetch(`${at}/01/09520123456788`, { redirect: "manual" });
    expect(scan.status).toBe(307);
    await new Promise<void>((resolve) => live.close(() => resolve()));
  });
});

describe("a table an operator wrote by hand", () => {
  it("refuses keys that could never be reached, naming what to write instead", () => {
    const cases: Array<[string, RegExp]> = [
      ["/01/09520123456788/", /canonical form/],
      ["/gtin/09520123456788", /canonical form/],
      ["01/09520123456788", /not a Digital Link path|canonical form/],
      ["https://id.example.com/01/09520123456788", /canonical form/],
      ["/01/09520123456789", /check digit/],
    ];
    for (const [key, expected] of cases) {
      expect(
        () =>
          parseTable({
            version: 1,
            entries: { [key]: [{ href: "https://a.example/", linkType: "gs1:pip", title: "T" }] },
          }),
        key,
      ).toThrow(expected);
    }
  });

  it("accepts a GTIN written in the form actually printed, because it is the same key", () => {
    const table = parseTable({
      version: 1,
      entries: {
        "/01/09520123456788": [{ href: "https://a.example/", linkType: "gs1:pip", title: "T" }],
      },
    });
    expect(Object.keys(table.entries)).toEqual(["/01/09520123456788"]);
  });

  it("refuses an href that could never be a destination", () => {
    for (const href of ["/relative/path", "not a url", "javascript:alert(1)", "ftp://example.com/x"]) {
      expect(() =>
        parseTable({
          version: 1,
          entries: { "/01/09520123456788": [{ href, linkType: "gs1:pip", title: "T" }] },
        }),
      ).toThrow(/absolute address|not http or https/);
    }
  });
});

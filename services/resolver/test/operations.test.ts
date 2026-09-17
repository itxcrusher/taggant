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
    const events = scans();
    // Without this the test passes when scan recording has stopped entirely, which is the
    // regression it would most want to report.
    expect(events.length, "no scan was recorded, so nothing was inspected").toBe(2);
    for (const event of events) expect("language" in event).toBe(false);
  });
});

describe("what a scan event may not carry", () => {
  it("records the table's href, not the target the caller's query was appended to", async () => {
    // The query string is carried on to the target because the standard asks for it, and it
    // is also whatever a stranger wrote: `?email=alice@example.com&uid=99123&fbclid=...`
    // went verbatim into the event, in a log the security policy promises holds "nothing
    // that identifies a person". The `Location` still carries it, because a campaign
    // parameter on a printed code is the point; the event records where the table sent the
    // scan, which is what a report needs and is the operator's own data.
    const response = await get("/01/09520123456788?email=alice%40example.com&uid=99123&fbclid=IwAR9x");
    expect(response.headers.get("location")).toContain("email=alice%40example.com");
    const scan = events.find((event) => event.type === "scan");
    expect(scan, "no scan was recorded").toBeDefined();
    const line = JSON.stringify(scan);
    expect(line, `the event carried the caller's query: ${line}`).not.toMatch(/alice|99123|IwAR9x/);
    expect(scan?.type === "scan" ? scan.target : "").toBe("https://example.com/product");
  });

  it("records the language that chose, and only when the language chose", async () => {
    // The field was the raw `Accept-Language` header, recorded whenever more than one link
    // of the type existed, without asking whether the header matched anything: a German
    // header on a redirect to the English default recorded `language: "de"`, so a report
    // attributed an English scan to a German speaker. `fr;q=0` was recorded as a language
    // although q=0 means "not acceptable", and a four kilobyte header became a four
    // kilobyte field.
    const cases: [string, string, string | undefined][] = [
      // header, where it goes, what is recorded
      ["fr", "https://example.com/produit", "fr"],
      ["fr-CA", "https://example.com/produit", "fr"],
      ["de", "https://example.com/product", undefined],
      ["fr;q=0", "https://example.com/product", undefined],
      ["fr;q=0, de", "https://example.com/product", undefined],
      ["*", "https://example.com/product", undefined],
      // A private subtag truncates to `fr`, so the French link is right and the field is
      // two characters where the header was four kilobytes, which was the point of it.
      [`fr-x-${"a".repeat(4000)}`, "https://example.com/produit", "fr"],
    ];
    for (const [header, target, recorded] of cases) {
      events.length = 0;
      const response = await get("/01/09520123456788", { headers: { "accept-language": header } });
      expect(response.headers.get("location"), `${header} went somewhere unexpected`).toBe(target);
      const scan = events.find((event) => event.type === "scan");
      const language = scan?.type === "scan" ? scan.language : undefined;
      expect(language, `${header.slice(0, 40)} recorded ${String(language)}`).toBe(recorded);
    }
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

  it("publishes every counter against what actually happened, and no counter that is a copy", async () => {
    // Nothing asserted the set of counters or their values, so a counter could carry a name
    // that claimed more than it counted and no test would mind. One did:
    // `taggant_answered_total` incremented once per scan, which made it exactly the sum of
    // the scan counter, under a name suggesting every answer this resolver gives. Health
    // checks, readiness checks, metrics scrapes and bad requests are all answers and none
    // were in it, so a dashboard reading it as a request rate read low by however often an
    // orchestrator polls. It is gone, and this is what keeps the rest honest.
    // Deltas, not totals: every test in this file shares one server, so the counters carry
    // whatever ran before. Reading them twice is safe because a metrics scrape is not a
    // scan, which the test above this one is what keeps true.
    const read = async (): Promise<(name: string) => number> => {
      const body = await (await get("/metrics")).text();
      return (name: string): number => {
        const line = body.split("\n").find((each) => each.startsWith(name));
        expect(line, `${name} is not published`).toBeDefined();
        return Number((line ?? "").slice(name.length).trim());
      };
    };
    const before = await read();

    const redirects = 2;
    const linksets = 1;
    const unresolved = 1;
    const bad = 1;
    for (let i = 0; i < redirects; i++) await get("/01/09520123456788");
    for (let i = 0; i < linksets; i++) await get("/01/09520123456788?linkType=linkset");
    for (let i = 0; i < unresolved; i++) await get("/01/09520123456702");
    for (let i = 0; i < bad; i++) await get("/nothing/here");
    // Answered too, and deliberately counted nowhere.
    await get("/healthz");
    await get("/readyz");

    const after = await read();
    const rose = (name: string): number => after(name) - before(name);

    expect(rose('taggant_scans_total{outcome="redirect"}')).toBe(redirects);
    expect(rose('taggant_scans_total{outcome="linkset"}')).toBe(linksets);
    expect(rose('taggant_scans_total{outcome="unresolved"}')).toBe(unresolved);
    expect(rose("taggant_bad_requests_total")).toBe(bad);

    // Each counter against the events, which are the other record of the same requests.
    // `events` is emptied before each test, so these are this test's own.
    const scans = events.filter((event) => event.type === "scan");
    expect(redirects + linksets + unresolved).toBe(scans.length);
    expect(rose("taggant_resolve_seconds_total")).toBeCloseTo(
      scans.reduce((total, event) => total + (event.type === "scan" ? event.tookMs : 0), 0) / 1000,
      4,
    );

    // And no counter is a second name for a number already published. The first version of
    // this filtered out every line containing a brace and then mapped the values away, so
    // it pinned unlabelled names and nothing else: an adversarial pass reintroduced the
    // deleted counter as `taggant_answered_total{kind="all"}` and as
    // `resolver_answered_total` and this passed both times, while the comment above it
    // claimed every value was compared against the scan sum. Both halves are real now.
    const series = (await (await get("/metrics")).text())
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const cut = line.lastIndexOf(" ");
        return { series: line.slice(0, cut), value: Number(line.slice(cut + 1)) };
      });

    // Every series, labels and prefix included, so a name outside the taggant_ prefix or
    // wearing a label cannot slip in.
    expect(series.map((each) => each.series).sort()).toEqual([
      "taggant_bad_requests_total",
      "taggant_resolve_seconds_total",
      'taggant_scans_total{outcome="linkset"}',
      'taggant_scans_total{outcome="redirect"}',
      'taggant_scans_total{outcome="unresolved"}',
    ]);

    // And by value: nothing outside the scan counter carries the scan sum. The counts above
    // are chosen so that the sum is four while the bad requests are one and the seconds are
    // a fraction, and a delta is compared rather than a total, so equality here means a
    // duplicate rather than a coincidence.
    const scanSum = redirects + linksets + unresolved;
    const copies = series.filter(
      (each) => !each.series.startsWith("taggant_scans_total") && each.value === scanSum,
    );
    expect(
      copies.map((each) => each.series),
      `these carry the scan sum: ${JSON.stringify(copies)}`,
    ).toEqual([]);
  });
});

describe("what a stranger can put in a header", () => {
  it("publishes nothing of the path the caller wrote in front of the identifier", async () => {
    // This used to check that the prefix was encoded when it was published, which it was.
    // An adversarial pass pointed out what encoding it does not fix: the prefix is the
    // caller's, so `/attacker/chosen/stem/01/09520123456788` published
    // `<origin>/attacker/chosen/stem/01/09520123456788` as that product's identity, under
    // `owl:sameAs`, with an origin configured and doing nothing about it. It is not in the
    // subject at all now, so the encoding question does not arise.
    const response = await get("/%22%3E%3Cscript%3E/attacker/stem/01/09520123456788");
    const header = response.headers.get("link") ?? "";
    expect(header).not.toContain('"><script>');
    expect(header).not.toContain("%22%3E%3Cscript%3E");
    expect(header).not.toContain("attacker");
    expect(header).toContain("/01/09520123456788");
  });

  it("answers a path carrying a line break rather than failing on it", async () => {
    // Node refuses to write a header holding a carriage return, so this used to become a
    // 500 whose body carried the internal error text.
    const response = await get("/a%0d%0aX-Injected:%20yes/01/09520123456788");
    expect(response.status).toBe(307);
    expect(response.headers.get("x-injected")).toBeNull();
  });

  it("publishes nothing a Host header says, over a raw socket that can actually send one", async () => {
    // `fetch` silently replaces a caller-set `host`, which is why the test this replaces
    // could not fail for its own reason: an adversarial pass proved the header never left
    // the client, and then sent it raw and found `Host: evil.example` published as the
    // linkset anchor, in all three `Link` references including `owl:sameAs`, and as
    // `resolverRoot` in the description file. A socket, therefore, not `fetch`.
    const raw = async (path: string, host: string): Promise<string> => {
      const { connect } = await import("node:net");
      const url = new URL(origin);
      return await new Promise<string>((settle, fail) => {
        const socket = connect(Number(url.port), url.hostname, () => {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", fail);
        socket.on("end", () => settle(Buffer.concat(chunks).toString("utf8")));
      });
    };

    const linkset = await raw("/01/09520123456788?linkType=linkset", "evil.example");
    expect(linkset).toContain("200 OK");
    expect(linkset, "a Host header reached the subject").not.toContain("evil.example");
    const described = await raw("/.well-known/gs1resolver", "evil.example");
    expect(described, "a Host header reached the description file").not.toContain("evil.example");
  });

  it("answers a Host that is not a host with a refusal rather than a 500", async () => {
    // The request target was parsed against `http://${request.headers.host}`, so a Host
    // that `URL` rejects threw before anything was validated and became a 500, which also
    // moved no counter and left readiness green. Nothing reads the host now.
    const { connect } = await import("node:net");
    const url = new URL(origin);
    const statuses: string[] = [];
    for (const host of ["::1", "[", "a b", "%", "@", "evil.example:99999"]) {
      const answer = await new Promise<string>((settle, fail) => {
        const socket = connect(Number(url.port), url.hostname, () => {
          socket.write(`GET /01/09520123456788 HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", fail);
        socket.on("end", () => settle(Buffer.concat(chunks).toString("utf8").split("\r\n")[0] ?? ""));
      });
      statuses.push(answer);
    }
    expect(
      statuses.filter((line) => line.includes("500")),
      statuses.join(" | "),
    ).toEqual([]);
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

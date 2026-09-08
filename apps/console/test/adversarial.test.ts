import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCode } from "../src/operations.js";
import { createConsole } from "../src/server.js";
import { type Workspace, createWorkspace, safeFilename } from "../src/workspace.js";

/**
 * The findings of the fourth adversarial pass, each pinned by the case that produced it.
 *
 * Every one of these was reproduced against the running console before it was fixed. They
 * are here so that the fix is what is tested, rather than the intention behind it.
 */

let server: Server;
let origin = "";
let workspace: Workspace;
let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "console-adversarial-"));
  workspace = createWorkspace(join(root, "workspace"));
  server = createConsole({
    workspace,
    publishRoot: join(root, "bundles"),
    linkTablePath: join(root, "links.json"),
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function post(path: string, body: FormData | URLSearchParams, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    body,
    headers: { "sec-fetch-site": "same-origin", ...headers },
    redirect: "manual",
  });
}

const CRLF = "\r\n";

/** A request written by hand, for the headers `fetch` refuses to send. */
async function raw(...lines: string[]): Promise<number> {
  const { connect } = await import("node:net");
  const port = (server.address() as AddressInfo).port;
  return await new Promise<number>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(lines.join(CRLF));
    });
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(Number(answer.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0));
    });
  });
}

const upload = (name: string, bytes: string) => {
  const form = new FormData();
  form.append("targetId", name);
  form.append("physicalWidthMm", "62");
  form.append("artwork", new Blob([Buffer.from(bytes)], { type: "image/png" }), `${name}.png`);
  return form;
};

describe("H3: two uploads whose names reduce to one", () => {
  it("keeps both files rather than letting the second delete the first", async () => {
    await post("/experiences", new URLSearchParams({ id: "collide", title: "Collide" }));
    for (const [targetId, filename, bytes] of [
      ["one", "logo.png", "AAAA"],
      ["two", "LOGO.PNG", "BBBB"],
    ] as const) {
      const form = new FormData();
      form.append("targetId", targetId);
      form.append("physicalWidthMm", "62");
      form.append("artwork", new Blob([Buffer.from(bytes)], { type: "image/png" }), filename);
      expect((await post("/e/collide/targets", form)).status).toBe(303);
    }
    const saved = await workspace.read("collide");
    const sources = saved.manifest.targets.map((target) => target.source);
    expect(new Set(sources).size).toBe(2);
    const stored = await readdir(join(workspace.root, "collide", "artwork"));
    expect(stored).toHaveLength(2);
    // And each target still names its own image.
    const [first, second] = sources as [string, string];
    expect(await readFile(join(workspace.root, "collide", first), "utf8")).toBe("AAAA");
    expect(await readFile(join(workspace.root, "collide", second), "utf8")).toBe("BBBB");
  });

  it("keeps the extension on a name that is only an extension", () => {
    expect(safeFilename(".png")).toMatch(/^file-[0-9a-f]{8}\.png$/);
  });
});

describe("H5: registering a code", () => {
  it("leaves every other link on that code alone", async () => {
    // The shape this repository ships as its worked example: an English page, a French
    // page, and a certification link, all on one GTIN.
    const table = join(root, "siblings.json");
    await writeFile(
      table,
      JSON.stringify({
        version: 1,
        entries: {
          "/01/09520123456788": [
            {
              href: "https://a.example/en",
              linkType: "gs1:pip",
              title: "EN",
              hreflang: ["en"],
              default: true,
            },
            { href: "https://a.example/fr", linkType: "gs1:pip", title: "FR", hreflang: ["fr"] },
            {
              href: "https://a.example/cert",
              linkType: "gs1:certificationInfo",
              title: "Cert",
              hreflang: ["en"],
            },
          ],
        },
      }),
    );
    const written = await registerCode(table, {
      path: "/01/09520123456788",
      href: "https://new.example/here",
      title: "New",
      language: "en",
    });
    // The two product pages go, because they are the same fact pointing at the old place
    // and the resolver would still hand French scans the stale one. The certification
    // link is a different fact and stays.
    expect(written.replaced).toBe(2);
    expect(written.kept).toBe(1);

    const after = JSON.parse(await readFile(table, "utf8"));
    const links = after.entries["/01/09520123456788"] as { href: string; linkType: string }[];
    expect(links.map((link) => link.href).sort()).toEqual([
      "https://a.example/cert",
      "https://new.example/here",
    ]);
    // And exactly one default of that type, or the choice is ambiguous.
    const defaults = links.filter((link) => (link as { default?: boolean }).default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.href).toBe("https://new.example/here");
  });

  it("adds rather than replaces when the code carried nothing of that kind", async () => {
    const table = join(root, "fresh.json");
    const written = await registerCode(table, {
      path: "/01/09520123456788",
      href: "https://a.example/",
      title: "A",
    });
    expect(written.replaced).toBe(0);
    expect(written.kept).toBe(0);
  });
});

describe("H6: the Host header", () => {
  it("refuses a form posted to a name this console does not answer to", async () => {
    // A raw socket, because `fetch` will not send a Host header somebody else chose, and
    // the whole point is what happens when a browser is held on a name that resolves here.
    const status = await raw(
      "POST /experiences HTTP/1.1",
      "Host: evil.example",
      "Origin: http://evil.example",
      "Sec-Fetch-Site: same-origin",
      "Content-Type: application/x-www-form-urlencoded",
      "Content-Length: 26",
      "Connection: close",
      "",
      "id=rebound&title=Rebound",
    );
    expect(status).toBe(403);
    expect(await workspace.exists("rebound")).toBe(false);
  });

  it("refuses a loopback name on a port it is not listening on", async () => {
    const status = await raw(
      "POST /experiences HTTP/1.1",
      "Host: 127.0.0.1:9999",
      "Sec-Fetch-Site: same-origin",
      "Content-Type: application/x-www-form-urlencoded",
      "Content-Length: 24",
      "Connection: close",
      "",
      "id=wrongport&title=No",
    );
    expect(status).toBe(403);
  });

  it("accepts the loopback name it is actually listening on", async () => {
    const port = (server.address() as AddressInfo).port;
    const body = "id=rawok&title=Raw";
    const status = await raw(
      "POST /experiences HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Sec-Fetch-Site: same-origin",
      "Content-Type: application/x-www-form-urlencoded",
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      body,
    );
    expect(status).toBe(303);
  });

  it("still answers to the loopback names it is reached by", async () => {
    const response = await post("/experiences", new URLSearchParams({ id: "loopback", title: "Loopback" }));
    expect(response.status).toBe(303);
  });
});

describe("M1: links inside the workspace", () => {
  it("will not write a manifest through a link that leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "console-outside-"));
    let linked = true;
    try {
      await symlink(outside, join(workspace.root, "escaped"), "junction");
    } catch {
      linked = false;
    }
    if (!linked) return;
    const response = await post("/experiences", new URLSearchParams({ id: "escaped", title: "Escaped" }));
    const said = await fetch(`${origin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("outside the workspace");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("M2: one unreadable folder", () => {
  it("does not take the whole index down with it", async () => {
    await post("/experiences", new URLSearchParams({ id: "healthy", title: "Healthy" }));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workspace.root, "shapeless"), { recursive: true });
    // Targets that are not targets. The view reached for `content.length` and threw.
    await writeFile(
      join(workspace.root, "shapeless", "manifest.json"),
      '{"schemaVersion":"1.0.0","id":"shapeless","targets":[{"id":"t","source":"a.png","physicalWidthMm":1}]}',
    );
    const index = await fetch(`${origin}/`);
    expect(index.status).toBe(200);
    const body = await index.text();
    expect(body).toContain("healthy");
    expect(body).toContain("shapeless");
    // And the bad one says what is wrong rather than showing a V8 message.
    const one = await fetch(`${origin}/e/shapeless`);
    expect(await one.text()).not.toContain("Cannot read properties");
  });
});

describe("M3: addresses that will not decode", () => {
  it("answers a lone percent with a sentence rather than a 500", async () => {
    for (const path of ["/e/%/targets", "/e/%zz/publish", "/e/loopback/targets/%E0%A4%A/compile"]) {
      const response = await post(path, new URLSearchParams());
      expect([303, 404], path).toContain(response.status);
    }
  });
});

describe("M4 and M7: what a body may weigh", () => {
  it("refuses an oversized form before reading it, so the answer arrives", async () => {
    const response = await fetch(`${origin}/experiences`, {
      method: "POST",
      body: "x".repeat(200_000),
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const said = await fetch(`${origin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("the limit is");
  });
});

describe("L1: the score", () => {
  it("is escaped like everything else that reaches a page", async () => {
    const { verdict } = await import("../src/views.js");
    const rendered = verdict(
      {
        score: "</span><img src=x onerror=alert(1)><span>" as unknown as number,
        pass: true,
        featureCount: 1,
        areasWithFeatures: 1,
        repetition: null,
        areas: 16,
        analysisWidth: 640,
        smallestUsableScale: 0.5,
        minimumWidthMm: 70,
        reasons: [],
      },
      350,
    );
    expect(rendered).not.toContain("<img src=x");
    expect(rendered).toContain("&lt;img");
  });
});

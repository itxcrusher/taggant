import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCode } from "../src/operations.js";
import { createConsole } from "../src/server.js";
import { type Workspace, createWorkspace, safeFilename } from "../src/workspace.js";

/**
 * Hostile and unlucky inputs to the console, each pinned by the case that showed the defect.
 *
 * Every one of these was reproduced against the running console before it was fixed. They
 * are here so that the fix is what is tested, rather than the intention behind it.
 */

let server: Server;
let origin = "";
let workspace: Workspace;
let root = "";

/** Every folder this file makes, removed when it finishes. */
const made: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "console-hostile-"));
  made.push(root);
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
  // Best effort: a folder Windows has not let go of yet is not a test failure. A link the
  // workspace holds is removed as a link, never followed.
  for (const folder of made.splice(0)) {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
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

describe("two uploads whose names reduce to one", () => {
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

describe("a target on disk the runtime cannot read", () => {
  it("is rebuilt rather than refused, because the workspace holds the artwork", async () => {
    // A target file can be present and unusable: an older format, a half written file, or
    // one edited by hand. It parses as JSON, carries the right shape, and matches nothing.
    // The workspace still holds the artwork they were built from, so the answer is to
    // build them again, not to hand back a message about a file format.
    const { compile, publish } = await import("../src/operations.js");
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const artwork = fileURLToPath(new URL("../../../examples/postcard/artwork.png", import.meta.url));
    const overlay = fileURLToPath(new URL("../../../examples/postcard/overlay.svg", import.meta.url));
    const runtimeDir = fileURLToPath(new URL("../../../packages/runtime/dist", import.meta.url));

    const created = await workspace.create("stale-format", "Stale");
    const source = await workspace.storeFile(created.id, "artwork", "artwork.png", await read(artwork));
    const media = await workspace.storeFile(created.id, "media", "overlay.svg", await read(overlay));
    await workspace.save(created.id, {
      ...created.manifest,
      // Wide enough for 350 mm, where this artwork needs 270. Declared 148 this passed only because
      // the rebuild fell back to 150 mm, the defect the test after this one is about.
      targets: [{ id: "front", source, physicalWidthMm: 300, content: [{ type: "image", src: media }] }],
    });

    const outcome = await compile(workspace, await workspace.read(created.id), "front", 350);
    const path = join(workspace.directoryFor(created.id), outcome.path);
    const stored = JSON.parse(await read(path, "utf8"));
    expect(stored.formatVersion).toBe(2);
    await write(path, JSON.stringify({ ...stored, formatVersion: 1 }));

    const out = join(root, "republished");
    const published = await publish(workspace, await workspace.read(created.id), out, { runtimeDir });
    expect(published.compiled).toHaveLength(1);
    expect(published.compiled[0]?.report.scanDistanceMm).toBe(350);
    const shipped = JSON.parse(await read(join(out, "targets", "front.json"), "utf8"));
    expect(shipped.formatVersion).toBe(2);
  }, 60_000);

  it("is rebuilt at the distance its report was compiled for, when the report survived", async () => {
    // A file the runtime cannot read can still carry its report, and the report its distance. One
    // in a later format, or holding a descriptor word past 32 bits, kept a report compiled for
    // 600 mm and was rebuilt at 150, where this artwork needs 116 mm: a piece declared 120 mm wide
    // and refused at 600 was published, and the 600 chosen was gone from disk. Its card offered 150.
    const { compile, publish } = await import("../src/operations.js");
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const artwork = fileURLToPath(new URL("../../../examples/postcard/artwork.png", import.meta.url));
    const overlay = fileURLToPath(new URL("../../../examples/postcard/overlay.svg", import.meta.url));
    const runtimeDir = fileURLToPath(new URL("../../../packages/runtime/dist", import.meta.url));

    const created = await workspace.create("late-format", "Late format");
    const source = await workspace.storeFile(created.id, "artwork", "artwork.png", await read(artwork));
    const media = await workspace.storeFile(created.id, "media", "overlay.svg", await read(overlay));
    await workspace.save(created.id, {
      ...created.manifest,
      targets: [{ id: "front", source, physicalWidthMm: 120, content: [{ type: "image", src: media }] }],
    });
    const outcome = await compile(workspace, await workspace.read(created.id), "front", 600);
    const path = join(workspace.directoryFor(created.id), outcome.path);

    type Stored = { features: Array<{ descriptor: number[] }>; report: { scanDistanceMm: number } };
    const unreadable = "cannot be read as a target";
    const damaged: Array<[string, (stored: Stored) => unknown, string]> = [
      ["a later format", (stored) => ({ ...stored, formatVersion: 3 }), unreadable],
      [
        "a descriptor word past 32 bits",
        (stored) => {
          const [first, ...rest] = stored.features;
          return {
            ...stored,
            features: [{ ...first, descriptor: [2 ** 32, ...(first?.descriptor.slice(1) ?? [])] }, ...rest],
          };
        },
        unreadable,
      ],
    ];
    for (const [label, damage, cardSays] of damaged) {
      const stored = JSON.parse(await read(path, "utf8")) as Stored;
      expect(stored.report.scanDistanceMm, label).toBe(600);
      await write(path, JSON.stringify(damage(stored)));
      const card = await (await fetch(`${origin}/e/late-format`)).text();
      expect(card, label).toContain(cardSays);
      expect(card, label).toMatch(/name="scanDistanceMm"[^>]*value="600"/);

      const rebuiltAt: number[] = [];
      await expect(
        publish(workspace, await workspace.read(created.id), join(root, "late-format-out"), {
          runtimeDir,
          onRebuild: (_id: string, at: number) => rebuiltAt.push(at),
        }),
        label,
      ).rejects.toThrow(/declared 120 mm wide.* at 600 mm/);
      expect(rebuiltAt, label).toEqual([600]);
    }
  }, 240_000);
});

describe("a target on disk from a build whose print widths were wrong", () => {
  it("is rebuilt on publish, because the bundler would otherwise wave the piece through", async () => {
    // The one above is a target the runtime cannot read. This one it reads perfectly: only
    // the print advice inside it is wrong, by about four times, and the bundler compares
    // the declared print width against exactly that number before letting anything be
    // published. Left alone the gate passes a piece that will not be recognised, which is
    // the failure the gate exists to catch.
    const { compile, publish } = await import("../src/operations.js");
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const artwork = fileURLToPath(new URL("../../../examples/postcard/artwork.png", import.meta.url));
    const overlay = fileURLToPath(new URL("../../../examples/postcard/overlay.svg", import.meta.url));
    const runtimeDir = fileURLToPath(new URL("../../../packages/runtime/dist", import.meta.url));

    const created = await workspace.create("old-widths", "Old widths");
    const source = await workspace.storeFile(created.id, "artwork", "artwork.png", await read(artwork));
    const media = await workspace.storeFile(created.id, "media", "overlay.svg", await read(overlay));
    await workspace.save(created.id, {
      ...created.manifest,
      // Comfortably over the width the old model printed for 190 mm, and comfortably under
      // the real one, which is the position every piece made against that model is in.
      targets: [{ id: "front", source, physicalWidthMm: 100, content: [{ type: "image", src: media }] }],
    });

    const chosenDistanceMm = 190;
    const outcome = await compile(workspace, await workspace.read(created.id), "front", chosenDistanceMm);
    const path = join(workspace.directoryFor(created.id), outcome.path);
    const stored = JSON.parse(await read(path, "utf8"));

    // Rewritten as the previous build would have written it: no distance, and the width its
    // own arithmetic gave, which divided by a sensor figure of 1.6 px per mm at a metre.
    const { scanDistanceMm: _dropped, ...oldShape } = stored.report;
    const pixelsNeeded = stored.report.smallestUsableScale * stored.report.analysisWidth;
    const asTheOldBuildWroteIt = Math.ceil((pixelsNeeded * chosenDistanceMm) / 1600);
    expect(asTheOldBuildWroteIt).toBeLessThan(stored.report.minimumWidthMm);
    await write(
      path,
      JSON.stringify({ ...stored, report: { ...oldShape, minimumWidthMm: asTheOldBuildWroteIt } }),
    );

    const out = join(root, "old-widths-out");
    const rebuiltAt: number[] = [];
    await expect(
      publish(workspace, await workspace.read(created.id), out, {
        runtimeDir,
        onRebuild: (_id: string, at: number) => rebuiltAt.push(at),
      }),
      "the piece is 100 mm and cannot be read at the distance it was compiled for, so the publish has to fail",
    ).rejects.toThrow(/needs at least/);

    // The distance the operator chose, taken back out of the old report rather than
    // replaced by the default. Falling back to 150 mm was the defect: the same artwork
    // needs less than half the width there, so a piece the gate had to refuse published
    // clean and the operator's own choice was gone from disk with it.
    expect(rebuiltAt, "nothing was rebuilt, so the stale report was published as it stood").toHaveLength(1);
    expect(rebuiltAt[0]).toBe(chosenDistanceMm);

    // And the workspace now holds a target that says what distance it means.
    const onDisk = JSON.parse(await read(path, "utf8"));
    expect(onDisk.report.scanDistanceMm).toBe(chosenDistanceMm);
    expect(onDisk.report.minimumWidthMm).toBeGreaterThan(asTheOldBuildWroteIt);
  }, 60_000);
});

describe("a target on disk with no report at all", () => {
  it("is compiled before publishing, as anything not compiled yet is", async () => {
    // Published as it stood, which skipped every readiness check the bundler makes, while this
    // console's own page called the target not compiled yet. Removing one key from a target
    // file was the way to publish a design the compiler had refused.
    const { compile, publish } = await import("../src/operations.js");
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const artwork = fileURLToPath(new URL("../../../examples/postcard/artwork.png", import.meta.url));
    const overlay = fileURLToPath(new URL("../../../examples/postcard/overlay.svg", import.meta.url));
    const runtimeDir = fileURLToPath(new URL("../../../packages/runtime/dist", import.meta.url));

    const created = await workspace.create("no-report", "No report");
    const source = await workspace.storeFile(created.id, "artwork", "artwork.png", await read(artwork));
    const media = await workspace.storeFile(created.id, "media", "overlay.svg", await read(overlay));
    await workspace.save(created.id, {
      ...created.manifest,
      targets: [{ id: "front", source, physicalWidthMm: 148, content: [{ type: "image", src: media }] }],
    });
    const outcome = await compile(workspace, await workspace.read(created.id), "front", 190);
    const path = join(workspace.directoryFor(created.id), outcome.path);
    const { report: _removed, ...unreported } = JSON.parse(await read(path, "utf8"));
    await write(path, JSON.stringify(unreported));

    const rebuilt: string[] = [];
    const out = join(root, "no-report-out");
    await publish(workspace, await workspace.read(created.id), out, {
      runtimeDir,
      onRebuild: (id: string) => rebuilt.push(id),
    });
    expect(rebuilt, "a target with no report was published as it stood").toEqual(["front"]);
    const shipped = JSON.parse(await read(join(out, "targets", "front.json"), "utf8"));
    expect(shipped.report?.pass).toBe(true);

    // And a report written for another target, which the gate refuses in terms of that target: it
    // went to the gate as it stood, and the operator was told the other artwork's width. Rebuilt
    // from this target's own artwork, it publishes on its own report, and at the distance the
    // report on record was compiled for: rebuilt at the default instead, a piece compiled for a
    // longer reading distance, and refused there, passed at the shorter one and was published.
    await compile(workspace, await workspace.read(created.id), "front", 190);
    const own = JSON.parse(await read(path, "utf8"));
    const [first, ...rest] = own.features as Array<{ descriptor: number[] }>;
    await write(
      path,
      JSON.stringify({
        ...own,
        features: [
          {
            ...first,
            descriptor: [((first?.descriptor[0] ?? 0) ^ 1) >>> 0, ...(first?.descriptor.slice(1) ?? [])],
          },
          ...rest,
        ],
      }),
    );
    const again: string[] = [];
    const elsewhere = join(root, "another-out");
    await publish(workspace, await workspace.read(created.id), elsewhere, {
      runtimeDir,
      onRebuild: (id: string, at: number) => again.push(`${id} at ${at} mm`),
    });
    expect(again, "another target's report went to the gate as it stood").toEqual(["front at 190 mm"]);
    const republished = JSON.parse(await read(join(elsewhere, "targets", "front.json"), "utf8"));
    expect(republished.report?.pass).toBe(true);
  }, 240_000);
});

describe("a publish sent while the target is being compiled", () => {
  it("publishes what that compile writes, and does not write over it", async () => {
    // A publish read the target outside the target's compile queue, so one sent while a compile at
    // 600 mm was running read the file from the compile before, at 190. Carrying a report that no
    // longer described it, the file was rebuilt at 190 after the 600 compile and over it; carrying
    // its own, it was published as it stood while the file on disk said 600. Either way a piece
    // declared 150 mm wide, which needs 462 at 600, was published as one that needs 147 at 190.
    const { compile, publish } = await import("../src/operations.js");
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const artwork = fileURLToPath(new URL("../../../examples/postcard/artwork.png", import.meta.url));
    const overlay = fileURLToPath(new URL("../../../examples/postcard/overlay.svg", import.meta.url));
    const runtimeDir = fileURLToPath(new URL("../../../packages/runtime/dist", import.meta.url));

    const created = await workspace.create("asked-during", "Asked during");
    const source = await workspace.storeFile(created.id, "artwork", "artwork.png", await read(artwork));
    const media = await workspace.storeFile(created.id, "media", "overlay.svg", await read(overlay));
    await workspace.save(created.id, {
      ...created.manifest,
      targets: [{ id: "front", source, physicalWidthMm: 150, content: [{ type: "image", src: media }] }],
    });

    type Stored = { features: Array<{ descriptor: number[] }>; report: { scanDistanceMm: number } };
    const before: Array<[string, (stored: Stored) => Stored]> = [
      [
        "a report that no longer describes its file",
        (stored) => {
          const [first, ...rest] = stored.features;
          const flipped = [((first?.descriptor[0] ?? 0) ^ 1) >>> 0, ...(first?.descriptor.slice(1) ?? [])];
          return { ...stored, features: [{ ...first, descriptor: flipped }, ...rest] };
        },
      ],
      ["its own report", (stored) => stored],
    ];
    for (const [label, change] of before) {
      const outcome = await compile(workspace, await workspace.read(created.id), "front", 190);
      const path = join(workspace.directoryFor(created.id), outcome.path);
      await write(path, JSON.stringify(change(JSON.parse(await read(path, "utf8")) as Stored)));

      const experience = await workspace.read(created.id);
      const compiling = compile(workspace, experience, "front", 600);
      const publishing = publish(workspace, experience, join(root, "asked-during-out"), { runtimeDir });
      await expect(publishing, label).rejects.toThrow(/declared 150 mm wide.* at 600 mm/);
      await compiling;
      const onDisk = JSON.parse(await read(path, "utf8")) as Stored;
      expect(onDisk.report.scanDistanceMm, label).toBe(600);
    }
  }, 240_000);
});

describe("registering a code", () => {
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

  it("keeps both codes when two are registered at the same moment", async () => {
    // Registering a code is read, change, write, and the two were not serialised: both
    // registrations read the table before either wrote, so the second wrote the table as it
    // was before the first. Measured, two codes registered together left one identifier in
    // the file and both operators were told theirs "points here", which is a printed code
    // pointing at nothing and a person told that it does not. The workspace already had
    // this queue, keyed per experience; the link table is one shared file and never went
    // through it.
    const table = join(root, "at-once.json");
    const codes = ["/01/09520123456788", "/01/09520123456795", "/01/09520123456702", "/01/09520123456719"];
    await Promise.all(
      codes.map((path, index) =>
        registerCode(table, { path, href: `https://example.com/${index}/`, title: `Page ${index}` }),
      ),
    );
    const written = JSON.parse(await readFile(table, "utf8")) as { entries: Record<string, unknown[]> };
    expect(Object.keys(written.entries).sort()).toEqual([...codes].sort());
    // And each one kept its own destination rather than the last writer's.
    for (const [index, path] of codes.entries()) {
      const links = written.entries[path] as { href: string }[];
      expect(links?.[0]?.href, `${path} lost its destination`).toBe(`https://example.com/${index}/`);
    }
  });
});

describe("the Host header", () => {
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

describe("links inside the workspace", () => {
  it("will not write a manifest through a link that leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "console-outside-"));
    made.push(outside);
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

describe("one unreadable folder", () => {
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

describe("addresses that will not decode", () => {
  it("answers a lone percent with a sentence rather than a 500", async () => {
    for (const path of ["/e/%/targets", "/e/%zz/publish", "/e/loopback/targets/%E0%A4%A/compile"]) {
      const response = await post(path, new URLSearchParams());
      expect([303, 404], path).toContain(response.status);
    }
  });
});

describe("what a body may weigh", () => {
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

describe("the score", () => {
  it("is escaped like everything else that reaches a page", async () => {
    const { verdict } = await import("../src/views.js");
    const rendered = verdict({
      score: "</span><img src=x onerror=alert(1)><span>" as unknown as number,
      pass: true,
      featureCount: 1,
      areasWithFeatures: 1,
      repetition: null,
      areas: 16,
      analysisWidth: 640,
      smallestUsableScale: 0.5,
      minimumWidthMm: 70,
      scanDistanceMm: 150,
      targetDigest: "0".repeat(64),
      recognition: {
        pixelsAcross: 320,
        widths: 5,
        widthsAgreed: 5,
        views: 20,
        misplaced: 0,
        found: true,
        inliers: 58,
        needed: 20,
      },
      reasons: [],
    });
    expect(rendered).not.toContain("<img src=x");
    expect(rendered).toContain("&lt;img");
  });
});

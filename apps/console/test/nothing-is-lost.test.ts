/**
 * What two people doing one thing at once leaves behind.
 *
 * Every test here was a defect first, and each one was found by driving the console rather
 * than by reading it. They are grouped because they share a shape: the console answered
 * both requests, told both operators their work was saved, and one of the two was gone. A
 * green suite never had anything to say about it, because a suite that does one thing at a
 * time cannot.
 *
 * The rest of the file is the opposite failure: an internal error reaching an operator as
 * a stack trace and a 500 instead of a sentence they could act on.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { type Report, buildReport } from "@taggant/compiler";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, FLAGS, USAGE, main } from "../src/cli.js";
import { STALE_AFTER_MS, claim, lockFor, markerPrefix } from "../src/one-console.js";
import { createConsole } from "../src/server.js";
import { type Workspace, createWorkspace } from "../src/workspace.js";

const RUNTIME_DIR = fileURLToPath(new URL("../../../packages/runtime/dist", import.meta.url));

/** Artwork with enough to track, built the way the compiler's own tests build it. */
async function artwork(size = 600, blobs = 200, radius = 18): Promise<Buffer> {
  const pixels = Buffer.alloc(size * size).fill(238);
  let seed = 4242;
  for (let i = 0; i < blobs; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const value = seed % 2 === 0 ? 28 : 140;
    for (let y = Math.max(0, cy - radius); y < Math.min(size, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x < Math.min(size, cx + radius); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius && x >= cx - radius / 2) {
          pixels[y * size + x] = value;
        }
      }
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
}

/** A report as the compiler writes it today, built by the compiler rather than by hand. */
async function currentReport(): Promise<Report> {
  const corners: { x: number; y: number; strength: number }[] = [];
  for (let y = 40; y < 452; y += 40)
    for (let x = 40; x < 640; x += 40) corners.push({ x, y, strength: 1000 });
  const report = await buildReport({
    image: { width: 640, height: 452 },
    levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners })),
    features: [],
    scanDistanceMm: 190,
    recognises: () => [{ found: true, inliers: 58, misplaced: false }],
  });
  return JSON.parse(JSON.stringify(report));
}

/** The bytes say MP4, which is what the bundler reads to decide what ships. */
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("isommp41"),
]);

interface Driven {
  root: string;
  workspace: Workspace;
  server: Server;
  port: number;
  post: (path: string, body: BodyInit, headers?: Record<string, string>) => Promise<Response>;
  told: (response: Response) => Promise<string>;
}

const running: Driven[] = [];

/**
 * A console of its own per test, because these are races and a shared one would let one
 * test's queue order another test's writes.
 */
async function drive(options: { links?: (root: string) => string } = {}): Promise<Driven> {
  const root = await mkdtemp(join(tmpdir(), "console-race-"));
  const workspace = createWorkspace(join(root, "workspace"));
  const server = createConsole({
    workspace,
    publishRoot: join(root, "bundles"),
    linkTablePath: options.links?.(root) ?? join(root, "links.json"),
    runtimeDir: RUNTIME_DIR,
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const driven: Driven = {
    root,
    workspace,
    server,
    port: (server.address() as AddressInfo).port,
    post: (path, body, headers) =>
      fetch(`${base}${path}`, {
        method: "POST",
        body,
        headers: { "sec-fetch-site": "same-origin", ...headers },
        redirect: "manual",
      }),
    // What the operator is told, whichever way the console chose to tell them: a redirect
    // carrying a notice, or a page rendered in place.
    told: async (response) => {
      const location = response.headers.get("location");
      const body = location ? await (await fetch(`${base}${location}`)).text() : await response.text();
      const notice = body.match(/<div class="notice[^"]*" role="status">\s*<p>([\s\S]*?)<\/p>/)?.[1];
      return (notice ?? body)
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    },
  };
  running.push(driven);
  return driven;
}

afterEach(async () => {
  for (const driven of running.splice(0)) {
    driven.server.close();
    await rm(driven.root, { recursive: true, force: true });
  }
});

function target(id: string, filename: string, bytes: Buffer): FormData {
  const form = new FormData();
  form.append("targetId", id);
  form.append("physicalWidthMm", "120");
  form.append("artwork", new Blob([bytes], { type: "image/png" }), filename);
  return form;
}

async function count(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    total += entry.isDirectory() ? await count(join(dir, entry.name)) : 1;
  }
  return total;
}

/** Capture what a run of the command line said, and give the stream back either way. */
async function saying(work: () => Promise<number>): Promise<{ code: number; said: string }> {
  const chunks: string[] = [];
  const wrote = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await work(), said: chunks.join("") };
  } finally {
    process.stderr.write = wrote;
  }
}

/** The workspace as `claim` takes it, since every test here locks the same kind of thing. */
const WORKSPACE = (path: string) => ({ what: "workspace", path, kind: "directory" }) as const;

/**
 * Another name for an existing file, if this machine can make one: a symbolic link where
 * anyone may make one, or the short name Windows keeps beside a long one on volumes that keep
 * them. Null where neither exists, and the test that needs it says it was skipped.
 */
async function secondNameFor(file: string): Promise<string | null> {
  const link = join(dirname(file), "alias.json");
  try {
    await symlink(file, link, "file");
    return link;
  } catch {
    // Windows without the right to make links.
  }
  if (process.platform !== "win32") return null;
  const listing = spawnSync("cmd", ["/c", "dir", "/x", dirname(file)], { encoding: "utf8" }).stdout ?? "";
  const line = listing.split(/\r?\n/).find((row) => row.trimEnd().endsWith(` ${basename(file)}`));
  const short = line?.trim().split(/\s+/).at(-2);
  return short?.includes("~") ? join(dirname(file), short) : null;
}

describe("two people doing one thing at once", () => {
  it("does not let two uploads whose names reduce to one share a file", async () => {
    // Both names slug to `logo.png`, and the second write landed on the first's bytes: one
    // target's manifest entry pointed at the other target's artwork, and a press run was
    // the way to find out.
    //
    // Five rounds, because one missed the defect three times in thirty with the queue removed.
    const { post, workspace } = await drive();
    for (let round = 0; round < 5; round++) {
      const id = `collide-${round}`;
      await post("/experiences", new URLSearchParams({ id, title: "Collide" }));
      await Promise.all([
        post(`/e/${id}/targets`, target("target-one", "logo.png", Buffer.from("AAAA"))),
        post(`/e/${id}/targets`, target("target-two", "LOGO.PNG", Buffer.from("BBBB"))),
      ]);

      const saved = await workspace.read(id);
      const sources = saved.manifest.targets.map((one) => one.source);
      expect(new Set(sources).size, `round ${round}: two targets share a file: ${sources.join(" ")}`).toBe(
        sources.length,
      );
      const held = await Promise.all(
        sources.map((source) => readFile(join(saved.directory, source), "utf8").catch(() => "MISSING")),
      );
      expect(held, `round ${round}`).not.toContain("MISSING");
      expect(new Set(held).size, `round ${round}: two targets hold the same bytes: ${held.join(" ")}`).toBe(
        held.length,
      );
    }
  });

  it("does not delete an accepted upload while refusing another with the same name", async () => {
    // The cleanup added for the upload above deleted by the name it had asked for rather
    // than by the file it had written, so a refused upload took the accepted one's artwork
    // with it and the manifest went on naming a file that was gone.
    const { post, workspace } = await drive();
    await post("/experiences", new URLSearchParams({ id: "cleanup", title: "Cleanup" }));
    await post("/e/cleanup/targets", target("taken-id", "seed.png", Buffer.from("SEED")));
    await Promise.all([
      post("/e/cleanup/targets", target("fresh-id", "shared.png", Buffer.from("FRESH"))),
      post("/e/cleanup/targets", target("taken-id", "shared.png", Buffer.from("DUPE"))),
    ]);

    const saved = await workspace.read("cleanup");
    const missing: string[] = [];
    for (const one of saved.manifest.targets) {
      const bytes = await readFile(join(saved.directory, one.source), "utf8").catch(() => null);
      if (bytes === null) missing.push(`${one.id} -> ${one.source}`);
    }
    expect(missing, `the manifest names files that are not there: ${missing.join(", ")}`).toEqual([]);
  });

  it("will not forget a file the manifest names, whoever asks", async () => {
    // The second lock behind the test above, and it needs its own: with names now chosen
    // inside the queue, no route can hand the cleanup a name the manifest holds, so
    // deleting this guard left that test green. Driven through the API rather than through
    // a route because that is where the contract is. `forgetFile` is exported, its caller
    // passes the path, and a cleanup that can delete a named file is one rename away from
    // doing it again.
    const { post, workspace } = await drive();
    await post("/experiences", new URLSearchParams({ id: "named", title: "Named" }));
    await post("/e/named/targets", target("front", "front.png", Buffer.from("KEEP")));
    const saved = await workspace.read("named");
    expect(saved.manifest.targets[0]?.source).toBe("artwork/front.png");

    await workspace.forgetFile("named", "artwork/front.png");
    expect(
      await readFile(join(saved.directory, "artwork/front.png"), "utf8").catch(() => null),
      "a file the manifest names was deleted on request",
    ).toBe("KEEP");

    // The inverse, so this is a check on the manifest and not a refusal to delete at all:
    // a file nothing names does go.
    await workspace.storeFile("named", "artwork", "spare.png", Buffer.from("SPARE"));
    await workspace.forgetFile("named", "artwork/spare.png");
    expect(await readFile(join(saved.directory, "artwork/spare.png"), "utf8").catch(() => null)).toBeNull();
  });

  it("refuses exactly one of two creates of the same id", async () => {
    // Both reported success and one experience existed, so an operator had a page telling
    // them their title was saved over a manifest holding somebody else's.
    const { post, told } = await drive();
    const answers = await Promise.all([
      post("/experiences", new URLSearchParams({ id: "twice", title: "First" })),
      post("/experiences", new URLSearchParams({ id: "twice", title: "Second" })),
    ]);
    const lines = await Promise.all(answers.map(told));
    const refused = lines.filter((line) => line.includes("already exists"));
    expect(refused, `both creates were accepted: ${lines.join(" | ")}`).toHaveLength(1);
  });

  it("keeps two workspace objects on one folder to one queue", async () => {
    // The queue belonged to the object, so two `createWorkspace` calls on one folder had a
    // queue each and both creates of one id succeeded in eighteen rounds of twenty. The command
    // line makes one object; anything embedding the console can make two.
    const root = await mkdtemp(join(tmpdir(), "console-two-objects-"));
    const one = createWorkspace(join(root, "workspace"));
    const two = createWorkspace(join(root, "workspace"));
    for (let round = 0; round < 20; round++) {
      const outcomes = await Promise.allSettled([
        one.create(`same-${round}`, "One"),
        two.create(`same-${round}`, "Two"),
      ]);
      const created = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(created, `round ${round}: both objects created the same experience`).toHaveLength(1);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("keeps both codes when one link table is reached through a linked folder", async () => {
    // A junction or a symbolic link puts one table under two folders, and the queue keyed the
    // two paths apart: both registrations read the table before either wrote, and one code was
    // gone with both callers told it was registered.
    const { registerCode } = await import("../src/operations.js");
    for (let round = 0; round < 10; round++) {
      const root = await mkdtemp(join(tmpdir(), "console-linked-table-"));
      const real = join(root, "tables");
      await mkdir(real, { recursive: true });
      const via = join(root, "via");
      await symlink(real, via, "junction");
      await Promise.all([
        registerCode(join(real, "links.json"), {
          path: "/01/09520123456788",
          href: "https://example.invalid/a",
          title: "A",
        }),
        registerCode(join(via, "links.json"), {
          path: "/01/09520123456795",
          href: "https://example.invalid/b",
          title: "B",
        }),
      ]);
      const codes = Object.keys(JSON.parse(await readFile(join(real, "links.json"), "utf8")).entries).sort();
      expect(codes, `round ${round}`).toEqual(["/01/09520123456788", "/01/09520123456795"]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives an upload a name of its own when the manifest still names a file that is gone", async () => {
    // Names were checked against the disk alone. With one target's artwork moved away, the next
    // upload of that name took it, and two targets pointed at one image: the second target's.
    const { post, workspace } = await drive();
    await post("/experiences", new URLSearchParams({ id: "shelf", title: "Shelf" }));
    await post("/e/shelf/targets", target("front", "logo.png", Buffer.from("FRONT")));
    const before = await workspace.read("shelf");
    await rm(join(before.directory, "artwork", "logo.png"));

    await post("/e/shelf/targets", target("back", "logo.png", Buffer.from("BACK")));

    const after = await workspace.read("shelf");
    const sources = Object.fromEntries(after.manifest.targets.map((one) => [one.id, one.source]));
    expect(sources.front).toBe("artwork/logo.png");
    expect(sources.back, "the new upload took the name the front target still holds").not.toBe(
      "artwork/logo.png",
    );
    expect(await readFile(join(after.directory, sources.back ?? ""), "utf8")).toBe("BACK");
  });

  it("leaves nothing behind when it refuses an upload made under a name whose file is gone", async () => {
    // The refused upload took the missing file's name, and the cleanup will not delete a file
    // the manifest names, so it stayed: the refused bytes became the front target's artwork.
    // The console's own message for a moved file says to upload it again, which leads here.
    const { post, workspace } = await drive();
    await post("/experiences", new URLSearchParams({ id: "shelf", title: "Shelf" }));
    await post("/e/shelf/targets", target("front", "logo.png", Buffer.from("FRONT")));
    const before = await workspace.read("shelf");
    await rm(join(before.directory, "artwork", "logo.png"));

    await post("/e/shelf/targets", target("front", "logo.png", Buffer.from("REFUSED")));

    expect(await readdir(join(before.directory, "artwork"))).toEqual([]);
  });

  it("writes two compiled versions of one target at once, one after the other", async () => {
    // The compiled target was written outside the experience's queue, and on Windows the
    // second of two renames onto one file is refused: a double click on Compile was a 500 with
    // an EPERM stack. Driven at the write rather than through two compiles, because a compile
    // takes seconds and two of them put their writes together too rarely to show anything: six
    // double clicks stayed green with the queue removed. Linux renames onto one file without
    // complaint, so only a Windows run can catch this one being undone.
    const { workspace } = await drive();
    await workspace.create("twice", "Twice");
    for (let round = 0; round < 40; round++) {
      const written = await Promise.allSettled([
        workspace.writeTarget("twice", "front", { round, from: "one" }),
        workspace.writeTarget("twice", "front", { round, from: "two" }),
      ]);
      const refused = written.flatMap((outcome) =>
        outcome.status === "rejected" ? [String(outcome.reason)] : [],
      );
      expect(refused, `round ${round}`).toEqual([]);
      expect(await workspace.readTarget("twice", "front"), `round ${round}`).toEqual({ round, from: "two" });
    }
  });

  it("publishes one at a time, so the file count an operator is told is the count on disk", async () => {
    // Two publishes of one experience shared a staging directory: the second emptied it
    // while the first was writing into it. Measured over fourteen pairs with the defect
    // in place, eight rounds put a raw ENOENT or EPERM naming that internal directory in
    // front of an operator while the notice said how many files had been written.
    //
    // Making the staging path unique was necessary and not sufficient: on its own it was
    // worse, fourteen rounds of fourteen, because both publishes then reached the
    // destination and collided on the delete-then-rename there, and one round left the
    // published folder empty with both publishes failing. Serialising is the half that
    // makes the sentence true.
    const { post, told, root } = await drive();
    await post("/experiences", new URLSearchParams({ id: "race", title: "Race" }));
    await post("/e/race/targets", target("front", "front.png", await artwork()));
    await post("/e/race/targets/front/compile", new URLSearchParams({ scanDistanceMm: "150" }));
    const content = new FormData();
    content.append("type", "video");
    content.append("file", new Blob([MP4], { type: "video/mp4" }), "pour.mp4");
    await post("/e/race/targets/front/content", content);

    // Published once first. With the destination empty neither publish takes the
    // delete-then-rename path, and a probe that starts there stays green with the defect
    // restored: the first fourteen rounds of this measurement were exactly that probe.
    await post("/e/race/publish", "");

    for (let round = 0; round < 4; round++) {
      const answers = await Promise.all([post("/e/race/publish", ""), post("/e/race/publish", "")]);
      const lines = await Promise.all(answers.map(told));
      for (const line of lines) {
        expect(line, `an internal error reached the operator: ${line}`).not.toMatch(
          /ENOENT|EPERM|EBUSY|ENOTEMPTY|\.publishing/,
        );
        expect(line).toMatch(/Published \d+ files/);
      }
      const counted = lines.map((line) => Number(line.match(/Published (\d+) files/)?.[1]));
      const onDisk = await count(join(root, "bundles", "race"));
      expect(counted, `round ${round}: told ${counted.join(" and ")}, folder holds ${onDisk}`).toEqual([
        onDisk,
        onDisk,
      ]);
    }
  }, 180_000);
});

describe("an internal failure said as a sentence", () => {
  it("says which target and which file when the artwork has moved", async () => {
    // Publishing already wrapped its own rebuild in a sentence. Compiling from the page
    // did not, so the same moved file was a sentence on one route and a 500 with a stack
    // trace in the log on the other.
    const { post, told, workspace } = await drive();
    await post("/experiences", new URLSearchParams({ id: "moved", title: "Moved" }));
    await post("/e/moved/targets", target("front", "front.png", await artwork()));
    const saved = await workspace.read("moved");
    const source = saved.manifest.targets[0]?.source;
    expect(source).toBe("artwork/front.png");
    await rm(join(saved.directory, String(source)), { force: true });

    const answer = await post(
      "/e/moved/targets/front/compile",
      new URLSearchParams({ scanDistanceMm: "150" }),
    );
    const line = await told(answer);
    expect(answer.status, `a moved file is the operator's mistake, not a crash: ${line}`).toBeLessThan(500);
    expect(line).toContain("front");
    expect(line).toContain("artwork/front.png");
    expect(line).toMatch(/Upload the artwork again/);
  });

  it("says that artwork which is not an image cannot be compiled, rather than failing", async () => {
    // The upload is accepted, because it is only bytes until something decodes it, and the
    // decoder's own error then reached the operator as a 500 with a stack trace.
    const { post, told } = await drive();
    await post("/experiences", new URLSearchParams({ id: "words", title: "Words" }));
    await post("/e/words/targets", target("front", "front.png", Buffer.from("this is not a png")));

    const answer = await post(
      "/e/words/targets/front/compile",
      new URLSearchParams({ scanDistanceMm: "150" }),
    );
    const line = await told(answer);
    expect(answer.status, line).toBeLessThan(500);
    expect(line).toContain("not an image the compiler can read");
    expect(line).toContain("artwork/front.png");

    // Cut short, too. The decoder words a PNG cut short as "end of stream" or "libspng read
    // error", which the pattern the console matched did not know, so the operator read libvips's
    // words where every other unreadable file got the sentence.
    const png = await artwork();
    for (const [name, bytes] of [
      ["cut to 100 bytes", png.subarray(0, 100)],
      ["cut in half", png.subarray(0, Math.floor(png.length / 2))],
    ] as const) {
      const id = name.replace(/[^a-z0-9]+/g, "-");
      await post("/experiences", new URLSearchParams({ id, title: name }));
      await post(`/e/${id}/targets`, target("front", "front.png", Buffer.from(bytes)));
      const cut = await post(
        `/e/${id}/targets/front/compile`,
        new URLSearchParams({ scanDistanceMm: "150" }),
      );
      const said = await told(cut);
      expect(cut.status, `${name}: ${said}`).toBeLessThan(500);
      expect(said, name).toContain("Upload the artwork again");
    }
  });

  it("creates the link table's folder rather than failing on it", async () => {
    // A link table in a folder that does not exist yet is the ordinary case on a fresh
    // checkout, and the first code anyone registered came back as an ENOENT naming an
    // internal staging path: a 500, and nothing said about the folder.
    const { post, told, root } = await drive({ links: (at) => join(at, "not-there", "links.json") });
    await post("/experiences", new URLSearchParams({ id: "coded", title: "Coded" }));
    const answer = await post(
      "/e/coded/code",
      new URLSearchParams({ path: "/01/09506000134352", href: "https://example.invalid/p" }),
    );
    const line = await told(answer);
    expect(answer.status, line).toBe(303);
    expect(line).toContain("points here");
    expect(await readFile(join(root, "not-there", "links.json"), "utf8")).toContain("09506000134352");
  });

  it("bounds a form by the route rather than by what the request calls itself", async () => {
    // The limit was picked by the client's own Content-Type: anything declaring multipart
    // was allowed 256 MB, so creating an experience, which has two short fields in it,
    // could hand this process a quarter of a gigabyte to hold in memory.
    const { post, told } = await drive();
    const big = Buffer.alloc(100 * 1024, 0x41);
    const refused = await told(
      await post("/experiences", big, { "content-type": "multipart/form-data; boundary=x" }),
    );
    expect(refused).toContain("the limit is 64 KB");

    // The control: a route that does take a file reads the same body, and whatever it says
    // about it is not about its size.
    await post("/experiences", new URLSearchParams({ id: "uploads", title: "Uploads" }));
    const upload = await told(
      await post("/e/uploads/targets", big, { "content-type": "multipart/form-data; boundary=x" }),
    );
    expect(upload).not.toContain("the limit is 64 KB");
  });

  it("allows the upload limit only to a body that is an upload", async () => {
    // Giving the two file routes the large limit gave it to anything posted to them, and a
    // body that is not multipart is parsed as a form, in one synchronous step: 250 MB of
    // urlencoded text to the targets route held every other request for three to five
    // seconds, where before it was refused at 64 KB in a tenth of one. The limit belongs to a
    // file, so a body that cannot carry one gets the form limit whatever the route.
    const { post, told } = await drive();
    await post("/experiences", new URLSearchParams({ id: "plain", title: "Plain" }));
    // The content route refuses a target it does not know before it reads a body.
    await post("/e/plain/targets", target("front", "front.png", Buffer.from("FRONT")));
    const big = Buffer.alloc(100 * 1024, 0x41);
    for (const route of ["/e/plain/targets", "/e/plain/targets/front/content"]) {
      const said = await told(
        await post(route, big, { "content-type": "application/x-www-form-urlencoded" }),
      );
      expect(said, route).toContain("the limit is 64 KB");
    }
  });

  it("refuses a multipart body of many parts, or a long field with no file, before parsing it", async () => {
    // The platform's parser reads a whole body in one step, and the large limit went to any
    // multipart body on a file route: five million tiny parts held every other request for
    // 29.7 s, long enough for another console to take this one's lock as abandoned, and one
    // 250 MB field for 4. Both are refused before the parser sees them, here at a size a test
    // can send.
    const { post, told } = await drive();
    await post("/experiences", new URLSearchParams({ id: "parts", title: "Parts" }));
    const boundary = "taggant-test-boundary";
    const headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
    const part = (name: string, value: string, filename?: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? "" : `; filename="${filename}"`}\r\n\r\n${value}\r\n`;
    const end = `--${boundary}--\r\n`;

    const many = Array.from({ length: 40 }, (_, i) => part(`f${i}`, "x")).join("") + end;
    expect(await told(await post("/e/parts/targets", many, headers))).toContain("more than 16 parts");

    const long = part("targetId", "a".repeat(100 * 1024)) + end;
    expect(await told(await post("/e/parts/targets", long, headers))).toContain("a field of 100 KB");

    // Headers that run on: read as text whatever their length, they were one string the size
    // of the body.
    const runOn = `--${boundary}\r\nContent-Disposition: form-data; name="targetId"\r\nX-Padding: ${"p".repeat(20 * 1024)}\r\n\r\nfront\r\n${end}`;
    expect(await told(await post("/e/parts/targets", runOn, headers))).toContain("whose headers run to");

    // The control: a file part as large is what the large limit is for, and it is the target
    // added, whatever its bytes are.
    const withFile =
      part("targetId", "front") +
      part("physicalWidthMm", "120") +
      part("artwork", "a".repeat(100 * 1024), "front.png") +
      end;
    expect(await told(await post("/e/parts/targets", withFile, headers))).toContain("front added");
  });

  it("keeps a notice of its own, cut between characters and never through one", async () => {
    // A notice repeats the value it refused. Cut at a fixed index, a character written as two
    // halves was split at each cut and the page showed marks that stand for nothing; and the
    // cut kept a view of the whole posted value alive, so five refused 100 MB fields took the
    // heap from 10 MB to 509.
    const { post, told } = await drive();
    await post("/experiences", new URLSearchParams({ id: "wide", title: "Wide" }));
    const form = new FormData();
    form.append("targetId", "front");
    // One ordinary character first, so every cut at an even index falls between two halves.
    form.append("physicalWidthMm", `1${"\u{1F600}".repeat(10_000)}`);
    form.append("artwork", new Blob([Buffer.from("x")], { type: "image/png" }), "front.png");
    const said = await told(await post("/e/wide/targets", form));
    expect(said).toContain("characters not shown");
    expect(said).toContain("is not a printed width");
    expect(said.length).toBeLessThan(3000);
    expect(said).not.toContain("�");
    expect(said).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("says what is wrong with a stored report on its card, and keeps the page", async () => {
    // A report with no list of reasons took the page down with a TypeError, as a 404; `null`,
    // `0`, `false` and `""` read as not compiled yet, and a string as a width too small to trust.
    const { post, workspace, port } = await drive();
    await post("/experiences", new URLSearchParams({ id: "kept", title: "Kept" }));
    await post("/e/kept/targets", target("front", "front.png", await artwork()));
    const good = await currentReport();
    const { reasons: _reasons, ...noReasons } = good;
    const cases: Array<[string, unknown, string]> = [
      ["null", null, "not one at all"],
      ["0", 0, "not one at all"],
      ["false", false, "not one at all"],
      ["an empty string", "", "not one at all"],
      ["a string", "text", "not one at all"],
      ["a report with no reasons", noReasons, "does not stand behind its verdict"],
      ["reasons that are a word", { ...good, reasons: "abc" }, "does not stand behind its verdict"],
    ];
    for (const [name, report, expected] of cases) {
      await workspace.writeTarget("kept", "front", {
        formatVersion: 2,
        id: "front",
        width: 640,
        height: 452,
        features: [],
        report,
      });
      const page = await fetch(`http://127.0.0.1:${port}/e/kept`);
      const body = await page.text();
      expect(page.status, name).toBe(200);
      expect(body, name).toContain(expected);
      expect(body, name).not.toContain("Not compiled yet");
    }
  });

  it("keeps the compile asked for last, not the one that finished last", async () => {
    // The recogniser hands the event loop back between looks, so two compiles of one target
    // interleave, and the later request did less work, finished first and was overwritten: the
    // operator's last choice undone with nothing said. From ten metres this target's smallest
    // size is wider than any manifest can declare, so that compile asks the recogniser nothing.
    const { post, workspace } = await drive();
    await post("/experiences", new URLSearchParams({ id: "twice", title: "Twice" }));
    await post("/e/twice/targets", target("front", "front.png", await artwork()));
    const first = post("/e/twice/targets/front/compile", new URLSearchParams({ scanDistanceMm: "190" }));
    await new Promise((settle) => setTimeout(settle, 50));
    const second = post("/e/twice/targets/front/compile", new URLSearchParams({ scanDistanceMm: "10000" }));
    await Promise.all([first, second]);
    const stored = (await workspace.readTarget("twice", "front")) as { report: { scanDistanceMm: number } };
    expect(stored.report.scanDistanceMm, "the earlier compile was kept").toBe(10_000);
  }, 240_000);

  it("compiles at any distance the compiler takes, and refuses one past it in the same words", async () => {
    // The console took up to five metres and the command line ten, so a target compiled at six
    // could not be published from here: its rebuild was refused the distance it was made at.
    const { post, told } = await drive();
    await post("/experiences", new URLSearchParams({ id: "far", title: "Far" }));
    await post("/e/far/targets", target("front", "front.png", await artwork()));
    const far = await told(
      await post("/e/far/targets/front/compile", new URLSearchParams({ scanDistanceMm: "6000" })),
    );
    expect(far).not.toContain("not one a person could hold");
    const past = await told(
      await post("/e/far/targets/front/compile", new URLSearchParams({ scanDistanceMm: "10001" })),
    );
    expect(past).toContain("50 to 10000");
  }, 240_000);
});

describe("one console at a time", () => {
  it("puts a directory's lock inside it and a file's lock beside it", () => {
    // Where the lock sits is a property of the container rather than a detail. In the
    // compose stack the workspace is a bind mount under a read-only root: `/srv/workspace`
    // is writable and `/srv/workspace.console-lock` is not, so a lock beside the directory
    // stopped the console starting in its own stack. The link table is a file inside a
    // mount, so its lock beside it is inside the same mount.
    expect(lockFor(WORKSPACE(join("/srv", "workspace")))).toBe(join("/srv", "workspace", ".console-lock"));
    expect(lockFor({ what: "link table", path: join("/srv", "links", "links.json"), kind: "file" })).toBe(
      join("/srv", "links", "links.json.console-lock"),
    );
  });

  it("refuses a workspace a running console holds, and names the process and the file", async () => {
    // Every write here is atomic and queued, and none of that survives a second console in
    // another process: both read a file, both decide the next version of it, and one edit is
    // gone with both operators told it was saved.
    const root = await mkdtemp(join(tmpdir(), "console-lock-"));
    const workspace = join(root, "workspace");
    const held = await claim([WORKSPACE(workspace)]);
    expect(held.ok).toBe(true);

    const { code, said } = await saying(() =>
      main([workspace, "--port", "4999", "--links", join(root, "links.json")]),
    );

    expect(code).toBe(EXIT.alreadyOpen);
    expect(said).toContain("another console is already open");
    expect(said).toContain(`process ${process.pid}`);
    expect(said).toContain(lockFor(WORKSPACE(workspace)));
    if (held.ok) held.claim.release();
    await rm(root, { recursive: true, force: true });
  });

  it("takes over a lock nobody has touched for longer than the stale interval", async () => {
    // A lock is kept fresh by the console holding it. One left untouched was left by a console
    // that is not running, whatever process it names, and is taken over with the takeover said.
    const root = await mkdtemp(join(tmpdir(), "console-stale-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    // Named after a process that is certainly alive, the parent of this one, because whether
    // the named process is alive no longer decides anything.
    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({ pid: process.ppid, host: "elsewhere", nonce: "x" }),
    );
    const longAgo = new Date(Date.now() - (STALE_AFTER_MS + 5_000));
    await utimes(lockFor(WORKSPACE(workspace)), longAgo, longAgo);

    // Watched for a fifth of a second here, where a console watches for a heartbeat and a half.
    const held = await claim([WORKSPACE(workspace)], { watchMs: 200 });
    expect(held.ok, "a lock nobody touched blocked the console").toBe(true);
    if (held.ok) {
      expect(held.notes.join(" ")).toMatch(/took over .*untouched for .* and not touched while watched/);
      held.claim.release();
    }
    // The marker a takeover holds is gone once it is done, or the next takeover of this lock
    // would be refused as another console starting.
    expect((await readdir(workspace)).filter((name) => name.includes("taking-over"))).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("gives a lock up when another console replaces it before it is confirmed", async () => {
    // Two consoles cannot both create one lock, and a takeover goes through a marker, so nothing
    // in this process can replace a fresh lock. A console on another machine whose clock runs
    // ahead can: it reads the fresh lock as old and takes it over. Reading the lock back before
    // going on is what notices.
    const root = await mkdtemp(join(tmpdir(), "console-replaced-"));
    const workspace = join(root, "workspace");
    const pending = claim([WORKSPACE(workspace)], { settleMs: 300 });
    await new Promise((settle) => setTimeout(settle, 100));
    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({ pid: 4242, host: "clock-ahead", nonce: "theirs" }),
    );
    const held = await pending;
    expect(held.ok, "went on holding a lock another console had replaced").toBe(false);
    if (!held.ok) expect(held.because).toContain("at the same moment");
    await rm(root, { recursive: true, force: true });
  });

  it("waits out another console's takeover, and steps past one that stopped part way", async () => {
    // A takeover holds a marker only one claimant can create, numbered, and named for the lock
    // as it read. A fresh marker is another console taking over the lock right now: refused, as
    // another console. One nobody has touched for ten seconds was left by a takeover that died
    // part way, and the next number is taken past it. No claimant removes a marker by name while
    // anyone may be using it: removing an old one by name let a claimant remove the fresh one
    // another had just made, and then both took the lock.
    const root = await mkdtemp(join(tmpdir(), "console-marker-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const lock = lockFor(WORKSPACE(workspace));
    const longAgo = new Date(Date.now() - (STALE_AFTER_MS + 5_000));
    const text = JSON.stringify({ pid: 1, host: "gone", nonce: "old" });
    await writeFile(lock, text);
    await utimes(lock, longAgo, longAgo);
    const prefix = markerPrefix(lock, text);
    const stopped = join(workspace, `${prefix}1`);
    const running = join(workspace, `${prefix}2`);
    await writeFile(stopped, "a takeover that died part way");
    await utimes(stopped, longAgo, longAgo);
    await writeFile(running, "a takeover happening now");

    const waiting = await claim([WORKSPACE(workspace)], { watchMs: 200 });
    expect(waiting.ok, "took over a lock another console was taking over").toBe(false);
    if (!waiting.ok) {
      expect(waiting.because).toContain("is starting on the workspace");
      expect(waiting.heldByAnother).toBe(true);
    }
    // Both markers where they were: the claim that waited removed neither.
    expect(await readdir(workspace)).toEqual(expect.arrayContaining([`${prefix}1`, `${prefix}2`]));

    await utimes(running, longAgo, longAgo);
    const cleared = await claim([WORKSPACE(workspace)], { watchMs: 200 });
    expect(cleared.ok, "a takeover that died part way blocked every later one").toBe(true);
    if (cleared.ok) cleared.claim.release();
    // Once the lock they were for is gone, every marker made for it is litter, and goes.
    expect((await readdir(workspace)).filter((name) => name.includes("taking-over"))).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a fresh lock from another machine, and says when it will be taken over", async () => {
    // A lock from a container or another machine is checked the same way as one from here:
    // touched recently means running. It used to be refused for ever, because whether a process
    // on another machine is alive is not a question this one can answer; the heartbeat is.
    const root = await mkdtemp(join(tmpdir(), "console-elsewhere-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({ pid: 1, host: "some-other-container", since: "2026-10-02T00:00:00.000Z", nonce: "x" }),
    );
    const held = await claim([WORKSPACE(workspace)]);
    expect(held.ok).toBe(false);
    if (!held.ok) {
      expect(held.because).toContain("some-other-container");
      expect(held.because).toContain(lockFor(WORKSPACE(workspace)));
      expect(held.because).toMatch(/taken over once \d+ s pass/);
      expect(held.heldByAnother).toBe(true);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("takes over a lock an earlier run of this very process left, which is every container restart", async () => {
    // Inside a container the console is process 1 every time. After an unclean stop the lock
    // names process 1 on this host, and asking whether process 1 is alive asked this console
    // about itself: refused on every restart, for ever. A lock naming this process with a value
    // this process is not holding was written by an earlier run of it.
    const root = await mkdtemp(join(tmpdir(), "console-restart-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        since: new Date().toISOString(),
        nonce: "from-before",
      }),
    );
    // Watched first, because the same process id on the same host is also what two containers
    // on the host's network look like, and a heartbeat is the only thing that tells them apart.
    const held = await claim([WORKSPACE(workspace)], { watchMs: 200 });
    expect(held.ok, "a restarted console was refused its own lock").toBe(true);
    if (held.ok) {
      expect(held.notes.join(" ")).toContain("left by an earlier run of this console");
      held.claim.release();
    }
    await rm(root, { recursive: true, force: true });
  });

  it("lets exactly one of two claims made at the same instant hold the lock", async () => {
    // The lock was created empty and then written, and a second claim reading the empty file
    // in between took it for a lock that named nobody: both started. Driven twenty times,
    // because one clean run of a race is one scheduling.
    for (let round = 0; round < 20; round++) {
      const root = await mkdtemp(join(tmpdir(), "console-both-"));
      const workspace = join(root, "workspace");
      const both = await Promise.all([claim([WORKSPACE(workspace)]), claim([WORKSPACE(workspace)])]);
      const holders = both.filter((one) => one.ok);
      expect(holders, `round ${round}: ${holders.length} claims held the lock`).toHaveLength(1);
      // And the one holding it did not get there by calling the other a leftover. Both name this
      // process, so a claim that only learned of the other after creating its own file would
      // remove a live lock and say an earlier run had left it.
      for (const one of holders) {
        if (one.ok) expect(one.notes.join(" "), `round ${round}`).not.toContain("earlier run");
      }
      for (const one of both) if (one.ok) one.claim.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a claim made while another is still confirming, rather than calling it a leftover", async () => {
    // Both name this process. A claim that only learned of the other after creating its own
    // file read that file as left by an earlier run, removed a live lock and said so, and the
    // first claim then lost the lock it had just made.
    //
    // The first claim waits long before confirming, so the second certainly reads a lock that
    // is written and not yet confirmed. Started a few milliseconds apart instead, this stayed
    // green with the defect restored: timers here fire in steps of about fifteen milliseconds,
    // and the second claim nearly always arrived after the first had finished.
    for (let round = 0; round < 5; round++) {
      const root = await mkdtemp(join(tmpdir(), "console-stagger-"));
      const workspace = join(root, "workspace");
      const first = claim([WORKSPACE(workspace)], { settleMs: 400 });
      await new Promise((settle) => setTimeout(settle, 60));
      const second = await claim([WORKSPACE(workspace)]);
      const held = await first;
      expect(held.ok, `round ${round}: the first claim lost the lock it made`).toBe(true);
      expect(second.ok, `round ${round}: the second claim took a live lock`).toBe(false);
      // Refused at once, as this console a second time, rather than watched for seconds as a
      // lock some earlier run left behind.
      if (!second.ok) {
        expect(second.because).toContain("already open");
        expect(second.because).toContain("this console starting on it a second time");
      }
      if (held.ok) held.claim.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets exactly one of two claims take over the same stale lock", async () => {
    // Both see a lock nobody has touched, both remove it and both create their own, and the
    // second removal can delete the first claim's new lock: each then believes it holds the
    // workspace. Reading the lock back after a moment is what tells the first it lost.
    for (let round = 0; round < 40; round++) {
      const root = await mkdtemp(join(tmpdir(), "console-stale-both-"));
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const lock = lockFor(WORKSPACE(workspace));
      await writeFile(lock, JSON.stringify({ pid: 1, host: "gone", nonce: "old" }));
      const longAgo = new Date(Date.now() - (STALE_AFTER_MS + 5_000));
      await utimes(lock, longAgo, longAgo);

      const both = await Promise.all([
        claim([WORKSPACE(workspace)], { watchMs: 100 }),
        claim([WORKSPACE(workspace)], { watchMs: 100 }),
      ]);
      const holders = both.filter((one) => one.ok);
      expect(holders, `round ${round}: ${holders.length} claims held the lock`).toHaveLength(1);
      for (const one of both) if (one.ok) one.claim.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never takes a lock from a console running on this machine, however long since it touched it", async () => {
    // A console stopped with Ctrl+Z, held by a debugger, or busy in one synchronous step stops
    // touching its lock without stopping being a console. One multipart request held a console's
    // loop for 29.7 s, a second console took its lock at 21, and the first went on writing:
    // sixteen codes of forty were lost, and their operators told they pointed somewhere. A process
    // this machine says is running is a console that is running.
    const root = await mkdtemp(join(tmpdir(), "console-paused-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const lock = lockFor(WORKSPACE(workspace));
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.ppid,
        host: hostname(),
        since: "2026-10-02T00:00:00.000Z",
        nonce: "paused",
      }),
    );
    const longAgo = new Date(Date.now() - (STALE_AFTER_MS + 60_000));
    await utimes(lock, longAgo, longAgo);
    const held = await claim([WORKSPACE(workspace)], { watchMs: 200 });
    expect(held.ok, "took the lock of a console running on this machine").toBe(false);
    if (!held.ok) {
      expect(held.because).toContain("running on this machine");
      expect(held.because).toContain(lock);
      expect(held.heldByAnother).toBe(true);
    }
    expect(JSON.parse(await readFile(lock, "utf8")).nonce).toBe("paused");
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a lock that looks left behind but is touched while it is watched, whatever the clocks say", async () => {
    // A console whose clock runs thirty seconds behind stamps its lock thirty seconds in the past
    // every time it touches it, so by this machine's clock it always looked left behind, and it
    // was taken while it ran. And a lock naming this very process and host can be another
    // console with the same process id in another namespace, which two containers on the host's
    // network are. Both touch their locks, and a lock that changes while watched is running.
    const root = await mkdtemp(join(tmpdir(), "console-watched-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const lock = lockFor(WORKSPACE(workspace));
    for (const holder of [
      { pid: 4242, host: "clock-behind", nonce: "behind" },
      { pid: process.pid, host: hostname(), nonce: "twin" },
    ]) {
      await writeFile(lock, JSON.stringify(holder));
      const behind = () => new Date(Date.now() - 60_000);
      await utimes(lock, behind(), behind());
      const touching = setInterval(() => {
        void utimes(lock, behind(), behind()).catch(() => undefined);
      }, 40);
      let held: Awaited<ReturnType<typeof claim>>;
      try {
        held = await claim([WORKSPACE(workspace)], { watchMs: 800 });
      } finally {
        clearInterval(touching);
      }
      expect(held.ok, `took a lock ${holder.host} was touching`).toBe(false);
      if (!held.ok) {
        expect(held.because).toContain(`touched the lock at ${lock} while this console watched it`);
      }
      expect(JSON.parse(await readFile(lock, "utf8")).nonce).toBe(holder.nonce);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("says so for every lock it loses, and writes nothing after", async () => {
    // One flag for every lock named the first lost and never the second, and the console went on
    // writing to both: the edits of the console that took them and of this one were lost between
    // them. Every write asks the lock first now.
    const root = await mkdtemp(join(tmpdir(), "console-lost-"));
    const workspace = join(root, "workspace");
    const table = { what: "link table", path: join(root, "links.json"), kind: "file" as const };
    const lost: string[] = [];
    const held = await claim([WORKSPACE(workspace), table], {
      heartbeatMs: 25,
      onLost: (sentence) => lost.push(sentence),
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(held.claim.check()).toBeNull();
    const guarded = createWorkspace(workspace, { holds: held.claim.check });
    await guarded.create("before", "Before");

    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({ pid: 4242, host: "intruder", nonce: "a" }),
    );
    await writeFile(lockFor(table), JSON.stringify({ pid: 4243, host: "intruder", nonce: "b" }));
    await new Promise((settle) => setTimeout(settle, 200));
    expect(lost, "a lost lock was not said").toHaveLength(2);
    expect(lost.join(" ")).toContain(lockFor(WORKSPACE(workspace)));
    expect(lost.join(" ")).toContain(lockFor(table));
    expect(held.claim.check()).toContain("no longer holds");

    await expect(guarded.create("after", "After")).rejects.toThrow(/no longer holds/);
    await expect(guarded.update("before", (manifest) => ({ ...manifest, title: "Changed" }))).rejects.toThrow(
      /no longer holds/,
    );
    await expect(guarded.storeFile("before", "artwork", "x.png", new Uint8Array([1]))).rejects.toThrow(
      /no longer holds/,
    );
    await expect(guarded.writeTarget("before", "front", { features: [] })).rejects.toThrow(/no longer holds/);
    // And a cleanup leaves the file alone rather than refusing, because its refusal would replace
    // the reason the upload was being taken back.
    await mkdir(join(workspace, "before", "artwork"), { recursive: true });
    await writeFile(join(workspace, "before", "artwork", "left.png"), "x");
    await guarded.forgetFile("before", "artwork/left.png");
    expect(await readdir(join(workspace, "before", "artwork"))).toContain("left.png");
    // The folder is made with the experience; what must not be in it is a compiled target.
    expect(await readdir(join(workspace, "before", "targets"))).toEqual([]);
    const { registerCode } = await import("../src/operations.js");
    await expect(
      registerCode(
        table.path,
        { path: "/01/09520123456788", href: "https://example.invalid/a", title: "A" },
        {
          holds: held.claim.check,
        },
      ),
    ).rejects.toThrow(/no longer holds/);
    expect(await readdir(workspace)).not.toContain("after");
    expect(JSON.parse(await readFile(join(workspace, "before", "manifest.json"), "utf8")).title).toBe(
      "Before",
    );
    await expect(stat(table.path)).rejects.toThrow();
    held.claim.release();
    await rm(root, { recursive: true, force: true });
  });

  it("names every lock it has lost at the write that finds out, not only the first", async () => {
    // The heartbeat notices a lost lock within an interval. A write that finds one gone says so
    // for every lock at that moment, so an operator is not told about the link table an interval
    // after the workspace. The heartbeat here is ten minutes, so only the write can say it.
    const root = await mkdtemp(join(tmpdir(), "console-lost-"));
    const workspace = join(root, "workspace");
    const table = { what: "link table", path: join(root, "links.json"), kind: "file" as const };
    const lost: string[] = [];
    const held = await claim([WORKSPACE(workspace), table], {
      heartbeatMs: 600_000,
      onLost: (sentence) => lost.push(sentence),
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({ pid: 4242, host: "intruder", nonce: "a" }),
    );
    await writeFile(lockFor(table), JSON.stringify({ pid: 4243, host: "intruder", nonce: "b" }));
    expect(lost, "the heartbeat reported it, so this measured nothing").toEqual([]);
    expect(held.claim.check()).toContain("no longer holds");
    expect(lost, "a lost lock was not said at the write that found it").toHaveLength(2);
    held.claim.release();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps its lock fresh while it holds it, and says so if another console takes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "console-beat-"));
    const workspace = join(root, "workspace");
    const lost: string[] = [];
    const held = await claim([WORKSPACE(workspace)], {
      heartbeatMs: 25,
      onLost: (sentence) => lost.push(sentence),
    });
    expect(held.ok).toBe(true);
    const lock = lockFor(WORKSPACE(workspace));
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lock, longAgo, longAgo);
    await new Promise((settle) => setTimeout(settle, 120));
    expect(Date.now() - (await stat(lock)).mtimeMs, "the holder stopped touching its lock").toBeLessThan(
      5_000,
    );

    await writeFile(lock, JSON.stringify({ pid: 4242, host: "intruder", nonce: "theirs" }));
    await new Promise((settle) => setTimeout(settle, 120));
    expect(lost, "another console took the lock and nothing was said").toHaveLength(1);
    expect(lost[0]).toContain("no longer holds");
    expect(lost[0]).toContain("4242");
    if (held.ok) held.claim.release();
    // Released, and not its to delete: the lock is the other console's now.
    expect((await readFile(lock, "utf8")).includes("theirs")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("says what is wrong when the lock cannot be made, and exits with the code for that", async () => {
    // A file where the link table's folder should be was read as a lock somebody held, with a
    // sentence naming a lock file that could not exist; a folder named like the lock was a Node
    // stack; and a folder refusing new files exited with the code for another console.
    const root = await mkdtemp(join(tmpdir(), "console-cannot-"));
    const workspace = join(root, "workspace");
    await writeFile(join(root, "afile"), "not a folder");
    const blocked = await saying(() =>
      main([workspace, "--port", "4999", "--links", join(root, "afile", "links.json")]),
    );
    expect(blocked.code).toBe(EXIT.cannotLock);
    expect(blocked.said).toContain("is not a folder");
    expect(blocked.said).not.toMatch(/\n\s+at /);

    const other = join(root, "other");
    await mkdir(join(other, ".console-lock"), { recursive: true });
    const folder = await claim([WORKSPACE(other)]);
    expect(folder.ok).toBe(false);
    if (!folder.ok) {
      expect(folder.because).toContain("is a folder");
      expect(folder.heldByAnother).toBe(false);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("says which port is taken instead of printing a stack, and gives the lock back", async () => {
    // A listen that fails was an unhandled error event: a stack trace with absolute
    // internal paths, and exit 1, which is also the code for a usage error. A start that
    // fails must also not leave the workspace looking occupied.
    const root = await mkdtemp(join(tmpdir(), "console-port-"));
    const workspace = join(root, "workspace");
    const other = createServer();
    await new Promise<void>((ready) => other.listen(0, "127.0.0.1", ready));
    const taken = (other.address() as AddressInfo).port;

    const { code, said } = await saying(() =>
      main([workspace, "--port", String(taken), "--links", join(root, "links.json")]),
    );
    other.close();

    expect(code).toBe(EXIT.cannotListen);
    expect(said).toContain(`port ${taken} is already in use`);
    // The lock is back, so the next attempt is not refused by the attempt that failed.
    const again = await claim([WORKSPACE(workspace)]);
    expect(again.ok, "a failed start left the workspace claimed").toBe(true);
    if (again.ok) again.claim.release();
    await rm(root, { recursive: true, force: true });
  });

  it("takes one lock for one link table however its path is spelled", async (context) => {
    // On a volume that keeps short names, `LINKS~1.JSO` is `links.json`, and a symbolic link is
    // another name again. The lock was the path as typed plus a suffix, so two consoles given
    // the two names both started; and a code registered through the short name renamed the
    // table itself, so the file the resolver reads was gone.
    const root = await mkdtemp(join(tmpdir(), "console-spelled-"));
    const tables = join(root, "tables");
    await mkdir(tables, { recursive: true });
    const table = join(tables, "links.json");
    await writeFile(table, `${JSON.stringify({ version: 1, entries: {} })}\n`);
    const other = await secondNameFor(table);
    if (other === null) {
      await rm(root, { recursive: true, force: true });
      context.skip();
      return;
    }
    const held = await claim([{ what: "link table", path: table, kind: "file" }]);
    expect(held.ok).toBe(true);
    // A port already taken, so a console the lock fails to stop says so instead of serving.
    const busy = createServer();
    await new Promise<void>((ready) => busy.listen(0, "127.0.0.1", ready));
    const port = (busy.address() as AddressInfo).port;

    const { code, said } = await saying(() =>
      main([join(root, "workspace"), "--port", String(port), "--links", other]),
    );
    busy.close();
    if (held.ok) held.claim.release();
    expect(code, said).toBe(EXIT.alreadyOpen);
    expect(said).toContain(lockFor({ what: "link table", path: table, kind: "file" }));

    const { registerCode } = await import("../src/operations.js");
    await registerCode(other, { path: "/01/09520123456788", href: "https://example.invalid/a", title: "A" });
    expect((await readdir(tables)).filter((name) => !name.startsWith("alias"))).toEqual(["links.json"]);
    expect(Object.keys(JSON.parse(await readFile(table, "utf8")).entries)).toEqual(["/01/09520123456788"]);
    await rm(root, { recursive: true, force: true });
  });

  it("answers --help wherever it is on the line", async () => {
    // Only the first position was looked at, so `taggant-console ./workspace --help` was an
    // unknown option and exit 1.
    const printed: string[] = [];
    const wrote = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main([join(tmpdir(), "console-help-never-made"), "--help"]);
    } finally {
      process.stdout.write = wrote;
    }
    expect(code).toBe(EXIT.ok);
    expect(printed.join("")).toBe(USAGE);
  });
});

describe("what it writes down, and how much it holds", () => {
  it("writes nothing to the log when a browser goes away mid-upload", async () => {
    // A cancelled upload, a navigation, a laptop closing. Nothing is damaged and nothing
    // can be answered either way, since there is nobody on the socket. What this pins is
    // what gets written down about it, because a terminal that cries wolf is one nobody
    // reads when something is actually wrong.
    //
    // It pins the property and not the guard, and the difference is worth a sentence.
    // Deleting the guard in `readBody` leaves this green: on Node 22 here the destroyed
    // socket leaves a request stream that simply ends, so the short body reaches the
    // multipart parser and its refusal is what the operator gets. The five lines of stack
    // this was filed for were measured elsewhere and are not reachable from this harness.
    const { port, post } = await drive();
    await post("/experiences", new URLSearchParams({ id: "abandoned", title: "Abandoned" }));

    const said: string[] = [];
    const wrote = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await new Promise<void>((done) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            [
              "POST /e/abandoned/targets HTTP/1.1",
              "Host: 127.0.0.1",
              "Sec-Fetch-Site: same-origin",
              "Content-Type: multipart/form-data; boundary=zzz",
              "Content-Length: 40000000",
              "",
              "--zzz",
              "",
            ].join("\r\n"),
          );
          socket.write(Buffer.alloc(2 * 1024 * 1024, 0x41));
          // Destroyed rather than ended, which is what a closed laptop looks like.
          setTimeout(() => {
            socket.destroy();
            setTimeout(done, 1000);
          }, 10);
        });
        socket.on("error", () => done());
      });
    } finally {
      process.stderr.write = wrote;
    }

    const logged = said.join("");
    expect(logged, `a stack was written for an abandoned upload: ${logged.slice(0, 300)}`).not.toMatch(
      /\n\s+at /,
    );
  });

  it("holds a bounded number of unread notices", async () => {
    // The one quantity in the server without a bound, in a file where every other bound is
    // commented. A notice is held until its redirect is followed or five minutes pass, so a
    // client that never follows its redirects holds every one: about 1.4 KB each.
    const { post, port } = await drive();
    // A refusal, whose redirect carries a notice token nobody is going to collect.
    const refuse = () => post("/experiences", new URLSearchParams({ id: "NOT AN ID", title: "x" }));
    const read = async (at: string) => await (await fetch(`http://127.0.0.1:${port}${at}`)).text();
    const first = (await refuse()).headers.get("location") ?? "";
    expect(first, "a refusal did not carry a notice").toMatch(/\?said=/);

    // The control, so this can fail for its own reason: a token collected straight away is
    // shown.
    const fresh = (await refuse()).headers.get("location") ?? "";
    expect(await read(fresh), "a notice was not shown at all").toContain('role="status"');

    // Past the ceiling, in batches so this is a second rather than a minute.
    for (let batch = 0; batch < 22; batch++) {
      await Promise.all(Array.from({ length: 50 }, refuse));
    }

    expect(
      await read(first),
      "the oldest notice was still held after eleven hundred newer ones",
    ).not.toContain('role="status"');
  });

  it("keeps a notice short whatever it repeats back", async () => {
    // The count of notices was bounded and their size was not: a refused width repeats the
    // field it refused, so one 100 MB field became a 100 MB notice and then a 100 MB page,
    // and five of them took the console from 67 to 694 MB.
    const { post, told } = await drive();
    await post("/experiences", new URLSearchParams({ id: "wide", title: "Wide" }));
    const form = target("front", "front.png", Buffer.from("PNG"));
    // Under the limit a field without a file has, which a longer one is refused at before it
    // is parsed, so this is the longest value that reaches the width's own refusal.
    form.set("physicalWidthMm", "9".repeat(60_000));
    const line = await told(await post("/e/wide/targets", form));
    expect(line.length, "the notice carried the whole field").toBeLessThan(3_000);
    expect(line).toContain("characters not shown");
    // And still says what was wrong, which comes after the value it repeats.
    expect(line).toContain("is not a printed width");

    // The million characters this used to send are refused before any of that, in a sentence.
    form.set("physicalWidthMm", "9".repeat(1_000_000));
    expect(await told(await post("/e/wide/targets", form))).toContain(
      "a field without a file is limited to 64 KB",
    );
  });

  it("says what is wrong with a stored report it will not show, rather than one reason for all", async () => {
    // Every report this build does not stand behind was called too small to trust, which is
    // true of the oldest and not of one whose width carried its distance and whose verdict came
    // from the check on one width that this build replaced.
    const { post, workspace, port } = await drive();
    await post("/experiences", new URLSearchParams({ id: "stored", title: "Stored" }));
    await post("/e/stored/targets", target("front", "front.png", Buffer.from("PNG")));
    const page = async () => await (await fetch(`http://127.0.0.1:${port}/e/stored`)).text();
    const oneWidth = {
      score: 100,
      pass: true,
      minimumWidthMm: 147,
      scanDistanceMm: 190,
      recognition: { pixelsAcross: 322, found: true, inliers: 58, needed: 20 },
    };
    await workspace.writeTarget("stored", "front", { formatVersion: 2, features: [], report: oneWidth });
    expect(await page()).toContain("this build does not stand behind its verdict");
    expect(await page()).not.toContain("too small to trust");

    await workspace.writeTarget("stored", "front", {
      formatVersion: 2,
      features: [],
      report: { minimumWidthMm: 70, pass: true },
    });
    expect(await page()).toContain("too small to trust");
  });

  it("keeps both codes when one link table is registered under two spellings", async () => {
    // `resolve` normalises separators and relative segments and does not normalise case,
    // and the comment on both queues said it did. Where the filesystem folds case,
    // `case.json` and `CASE.JSON` are one file: two concurrent registrations took two
    // queues, ran together, and one of the two codes was gone.
    //
    // Asserted both ways rather than skipped, because the right answer differs and both
    // are worth pinning: one file holding both codes where case is folded, and two files
    // holding one each where it is not. It only bites on the first kind of filesystem, so
    // the Linux runner cannot catch the fold being removed and says so here.
    const { root } = await drive();
    const { registerCode } = await import("../src/operations.js");
    const table = join(root, "case.json");
    // Only the name shouts. Upper-casing the whole path took the temporary directory with
    // it, and on Linux that is a path nothing may create: the run failed with EACCES on
    // `/TMP` rather than measuring anything.
    const shouting = join(root, "CASE.JSON");
    await Promise.all([
      registerCode(table, {
        path: "/01/09520123456788",
        href: "https://example.invalid/a",
        title: "A",
      }),
      registerCode(shouting, {
        path: "/01/09520123456795",
        href: "https://example.invalid/b",
        title: "B",
      }),
    ]);

    const folds = process.platform === "win32" || process.platform === "darwin";
    const codes = async (path: string) =>
      Object.keys(JSON.parse(await readFile(path, "utf8")).entries).sort();
    if (folds) {
      expect(await codes(table)).toEqual(["/01/09520123456788", "/01/09520123456795"]);
    } else {
      expect(await codes(table)).toEqual(["/01/09520123456788"]);
      expect(await codes(shouting)).toEqual(["/01/09520123456795"]);
    }
  });

  it("names every flag it parses in the line it prints", async () => {
    // `--allow-host` was parsed and appeared in no usage line and in no document, and it
    // is the only way a console reached by another name will act on a form.
    for (const flag of FLAGS) {
      expect(USAGE, `${flag} is parsed and not printed`).toContain(flag);
    }
  });
});

describe("the command line reached through a link", () => {
  it("runs, as it does when a package manager puts it on the path", async () => {
    // It compared argv[1] with its own module address as text, and through a link the first names
    // the link and the second the file, so it did nothing at all and exited 0. A package manager
    // puts a command line on the path through a link, and pnpm lays out a workspace with them.
    const { spawnSync } = await import("node:child_process");
    const { mkdtemp, rm, rmdir, symlink, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = await mkdtemp(join(tmpdir(), "linked-cli-"));
    const link = join(dir, "dist");
    await symlink(fileURLToPath(new URL("../dist", import.meta.url)), link, "junction");
    try {
      const run = spawnSync(process.execPath, [join(link, "cli.js"), "--help"], { encoding: "utf8" });
      expect(`${run.stdout}${run.stderr}`, "said nothing through the link").toContain("usage:");
      expect(run.status).toBe(0);
    } finally {
      // The link alone, never what it points at.
      await unlink(link).catch(() => rmdir(link));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

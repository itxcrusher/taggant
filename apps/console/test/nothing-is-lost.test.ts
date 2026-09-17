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
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, FLAGS, USAGE, main } from "../src/cli.js";
import { claim, lockFor } from "../src/one-console.js";
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

describe("two people doing one thing at once", () => {
  it("does not let two uploads whose names reduce to one share a file", async () => {
    // Both names slug to `logo.png`, and the second write landed on the first's bytes: one
    // target's manifest entry pointed at the other target's artwork, and a press run was
    // the way to find out.
    const { post, workspace } = await drive();
    await post("/experiences", new URLSearchParams({ id: "collide", title: "Collide" }));
    await Promise.all([
      post("/e/collide/targets", target("target-one", "logo.png", Buffer.from("AAAA"))),
      post("/e/collide/targets", target("target-two", "LOGO.PNG", Buffer.from("BBBB"))),
    ]);

    const saved = await workspace.read("collide");
    const sources = saved.manifest.targets.map((one) => one.source);
    expect(new Set(sources).size, `two targets share a file: ${sources.join(" ")}`).toBe(sources.length);
    const held = await Promise.all(
      sources.map((source) => readFile(join(saved.directory, source), "utf8").catch(() => "MISSING")),
    );
    expect(held).not.toContain("MISSING");
    expect(new Set(held).size, `two targets hold the same bytes: ${held.join(" ")}`).toBe(held.length);
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

  it("refuses a workspace another live console holds, and names the process", async () => {
    // Every write here is atomic and queued, and none of that survives a second console in
    // another process: both read a file, both decide the next version of it, and one edit
    // is gone with both operators told it was saved. Until this check existed the comments
    // on both queues cited a document that said nothing of the kind.
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
    if (held.ok) held.claim.release();
    await rm(root, { recursive: true, force: true });
  });

  it("takes over a lock left by a process that is gone", async () => {
    // A lock that outlived a crash must not brick the tool, and the takeover is printed
    // rather than silent, because a lock file appearing and disappearing on its own is the
    // sort of thing that gets debugged for an hour.
    const root = await mkdtemp(join(tmpdir(), "console-stale-"));
    const workspace = join(root, "workspace");
    // A process id that is certainly dead: one that has already exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    // The lock lives inside the workspace, so there has to be one.
    await mkdir(workspace, { recursive: true });
    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({ pid: dead, since: new Date().toISOString(), what: "workspace" }),
    );

    const held = await claim([WORKSPACE(workspace)]);
    expect(held.ok, "a lock naming a dead process blocked the console").toBe(true);
    if (held.ok) {
      expect(held.notes.join(" ")).toContain(`left by process ${dead}`);
      held.claim.release();
    }
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a lock taken on another machine, and says it cannot tell", async () => {
    // The failure branch of the check rather than of the thing it guards. A console in a
    // container writes a lock on a mounted workspace, the container is killed, and the next
    // container starts its process ids again from one: the lock names a process that is
    // alive there and is its own init. Checked by id alone, that console never starts
    // again. So a lock says where it was taken, and one from elsewhere is refused with a
    // sentence naming the file, which is a few seconds of attention rather than a tool that
    // will not open.
    const root = await mkdtemp(join(tmpdir(), "console-elsewhere-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      lockFor(WORKSPACE(workspace)),
      JSON.stringify({ pid: 1, host: "some-other-container", since: "2026-09-17T00:00:00.000Z" }),
    );

    const held = await claim([WORKSPACE(workspace)]);
    expect(held.ok).toBe(false);
    if (!held.ok) {
      expect(held.because).toContain("some-other-container");
      expect(held.because).toContain("cannot tell whether that process is still running");
      expect(held.because).toContain(lockFor(WORKSPACE(workspace)));
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
    const shouting = table.toUpperCase();
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

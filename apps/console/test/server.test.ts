import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConsole } from "../src/server.js";
import { type Workspace, createWorkspace } from "../src/workspace.js";

/**
 * The console driven over HTTP, as a browser drives it.
 *
 * Every one of these posts a form the way the pages do, follows the redirect the way a
 * browser does, and reads the page that comes back. Nothing here calls a function and
 * asserts what it returned; a console that works in unit tests and not in a browser is
 * the failure this project has already had once.
 */

const RUNTIME_DIR = fileURLToPath(new URL("../../../packages/runtime/dist", import.meta.url));

/** Artwork with enough to track, built the same way the compiler's own tests build it. */
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

let server: Server;
let origin = "";
let workspace: Workspace;
let publishRoot = "";
let linkTable = "";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "console-http-"));
  publishRoot = join(root, "bundles");
  linkTable = join(root, "links.json");
  workspace = createWorkspace(join(root, "workspace"));
  server = createConsole({ workspace, publishRoot, linkTablePath: linkTable, runtimeDir: RUNTIME_DIR });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

/** A form post from the console's own pages, which is what the browser sends. */
async function post(path: string, body: FormData | URLSearchParams): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: "POST",
    body,
    headers: { "sec-fetch-site": "same-origin" },
    redirect: "manual",
  });
}

async function pageAt(path: string): Promise<string> {
  const response = await fetch(`${origin}${path}`);
  expect(response.status).toBe(200);
  return await response.text();
}

describe("the whole path, driven the way the pages drive it", () => {
  it("goes from nothing to a published bundle with a code pointing at it", async () => {
    const created = await post(
      "/experiences",
      new URLSearchParams({ id: "botanica-500", title: "Botanica 500 ml" }),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toMatch(/^\/e\/botanica-500/);

    // Nothing can be published yet, and the page says exactly what is missing rather than
    // offering a button that fails.
    let page = await pageAt("/e/botanica-500");
    expect(page).toContain("Not ready to publish yet");
    expect(page).toContain("disabled");

    const target = new FormData();
    target.append("targetId", "front-panel");
    target.append("physicalWidthMm", "120");
    target.append("artwork", new Blob([await artwork()], { type: "image/png" }), "front panel FINAL.png");
    expect((await post("/e/botanica-500/targets", target)).status).toBe(303);

    page = await pageAt("/e/botanica-500");
    expect(page).toContain("front-panel");
    // The uploaded name was rebuilt, not taken.
    expect(page).toContain("artwork/front-panel-final.png");
    expect(page).toContain("Not compiled yet");

    const compiled = await post(
      "/e/botanica-500/targets/front-panel/compile",
      new URLSearchParams({ scanDistanceMm: "350" }),
    );
    expect(compiled.status).toBe(303);

    page = await pageAt("/e/botanica-500");
    expect(page).toContain("Ready for press");
    // The verdict is a sentence; the measurement behind it is disclosed, not asserted.
    expect(page).toContain("Under the lamp: what the compiler measured");
    expect(page).toMatch(/Print it at least \d+ mm wide to be read from 350 mm away/);

    const content = new FormData();
    content.append("type", "video");
    content.append("file", new Blob([Buffer.from("not really a video")], { type: "video/mp4" }), "pour.mp4");
    expect((await post("/e/botanica-500/targets/front-panel/content", content)).status).toBe(303);

    page = await pageAt("/e/botanica-500");
    expect(page).not.toContain("Not ready to publish yet");

    expect((await post("/e/botanica-500/publish", new URLSearchParams())).status).toBe(303);
    const bundled = await readFile(join(publishRoot, "botanica-500", "manifest.json"), "utf8");
    expect(JSON.parse(bundled).id).toBe("botanica-500");
    // The bundle carries the runtime rather than pointing at it.
    expect(await readFile(join(publishRoot, "botanica-500", "index.html"), "utf8")).toContain("<script");

    const code = await post(
      "/e/botanica-500/code",
      new URLSearchParams({ path: "/01/09520123456788", href: "https://example.com/b/botanica-500/" }),
    );
    expect(code.status).toBe(303);
    const table = JSON.parse(await readFile(linkTable, "utf8"));
    expect(Object.keys(table.entries)).toEqual(["/01/09520123456788"]);
    expect(table.entries["/01/09520123456788"][0].href).toBe("https://example.com/b/botanica-500/");
  });
});

describe("what it refuses", () => {
  it("refuses a form posted from somewhere else", async () => {
    const response = await fetch(`${origin}/experiences`, {
      method: "POST",
      body: new URLSearchParams({ id: "from-elsewhere", title: "x" }),
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(await workspace.exists("from-elsewhere")).toBe(false);
  });

  it("refuses a form with no origin evidence at all, rather than guessing", async () => {
    const response = await fetch(`${origin}/experiences`, {
      method: "POST",
      body: new URLSearchParams({ id: "no-evidence", title: "x" }),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });

  it("refuses an id that would walk out of the workspace, and says so on the page", async () => {
    const response = await post("/experiences", new URLSearchParams({ id: "../escape", title: "x" }));
    expect(response.status).toBe(303);
    const said = await fetch(`${origin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("is not a usable id");
  });

  it("refuses a code pointing at something that is not http", async () => {
    await post("/experiences", new URLSearchParams({ id: "scheme-test", title: "x" }));
    const response = await post(
      "/e/scheme-test/code",
      new URLSearchParams({ path: "/01/09520123456788", href: "javascript:alert(1)" }),
    );
    const said = await fetch(`${origin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("can only point at http or https");
  });

  it("refuses a Digital Link path the standard would not accept", async () => {
    await post("/experiences", new URLSearchParams({ id: "bad-code", title: "x" }));
    const response = await post(
      "/e/bad-code/code",
      new URLSearchParams({ path: "/01/09520123456789", href: "https://example.com/" }),
    );
    const said = await fetch(`${origin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("check digit");
  });

  it("will not write over a link table it cannot read, because that would lose every other code", async () => {
    const broken = join(await mkdtemp(join(tmpdir(), "console-table-")), "links.json");
    await writeFile(broken, "{ this is not json");
    const other = createConsole({
      workspace,
      publishRoot,
      linkTablePath: broken,
      runtimeDir: RUNTIME_DIR,
    });
    await new Promise<void>((ready) => other.listen(0, "127.0.0.1", ready));
    const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    await fetch(`${otherOrigin}/experiences`, {
      method: "POST",
      body: new URLSearchParams({ id: "table-test", title: "x" }),
      headers: { "sec-fetch-site": "same-origin" },
      redirect: "manual",
    });
    const response = await fetch(`${otherOrigin}/e/table-test/code`, {
      method: "POST",
      body: new URLSearchParams({ path: "/01/09520123456788", href: "https://example.com/" }),
      headers: { "sec-fetch-site": "same-origin" },
      redirect: "manual",
    });
    const said = await fetch(`${otherOrigin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("would lose the codes already in it");
    expect(await readFile(broken, "utf8")).toBe("{ this is not json");
    await new Promise<void>((done) => other.close(() => done()));
  });
});

describe("what it does not crash on", () => {
  it("answers a truncated upload with a message rather than a 500", async () => {
    // An interrupted upload is ordinary. Node's own parser throws a TypeError, which is
    // not a WorkspaceError, so it used to become a 500 with a stack trace in the log.
    await post("/experiences", new URLSearchParams({ id: "cut-short", title: "Cut short" }));
    const boundary = "----probe";
    const body = `--${boundary}
Content-Disposition: form-data; name="targetId"

t
--${boundary}
Content-Disposition: form-data; name="artwork"; filename="a.png"

not finished`;
    const response = await fetch(`${origin}/e/cut-short/targets`, {
      method: "POST",
      body,
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const said = await fetch(`${origin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("could not be read");
  });

  it("refuses a printed width no press could produce", async () => {
    await post("/experiences", new URLSearchParams({ id: "tiny", title: "Tiny" }));
    const form = new FormData();
    form.append("targetId", "t");
    form.append("physicalWidthMm", "1e-3");
    form.append("artwork", new Blob([await artwork()], { type: "image/png" }), "a.png");
    const response = await post("/e/tiny/targets", form);
    const said = await fetch(`${origin}${response.headers.get("location")}`);
    expect(await said.text()).toContain("is not a printed width in millimetres");
  });

  it("keeps every target when several are added at the same moment", async () => {
    await post("/experiences", new URLSearchParams({ id: "at-once", title: "At once" }));
    const png = await artwork();
    const add = (id: string) => {
      const form = new FormData();
      form.append("targetId", id);
      form.append("physicalWidthMm", "120");
      form.append("artwork", new Blob([png], { type: "image/png" }), `${id}.png`);
      return post("/e/at-once/targets", form);
    };
    await Promise.all([add("a"), add("b"), add("c"), add("d")]);
    const saved = await workspace.read("at-once");
    expect(saved.manifest.targets.map((target) => target.id).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("what it says", () => {
  it("escapes a title that is trying to be markup", async () => {
    await post(
      "/experiences",
      new URLSearchParams({ id: "hostile", title: '</title><script>fetch("//evil.example")</script>' }),
    );
    const page = await pageAt("/e/hostile");
    expect(page).not.toContain("<script>fetch");
    expect(page).toContain("&lt;script&gt;");
  });

  it("does not take a message from whoever wrote the address", async () => {
    const page = await pageAt("/?said=everything-published-successfully");
    expect(page).not.toContain("everything-published-successfully");
  });

  it("warns when the printed width is smaller than the compile says it needs", async () => {
    await post("/experiences", new URLSearchParams({ id: "too-small", title: "Too small" }));
    const target = new FormData();
    target.append("targetId", "front");
    // Far smaller than any artwork could need at half a metre.
    target.append("physicalWidthMm", "5");
    target.append("artwork", new Blob([await artwork()], { type: "image/png" }), "front.png");
    await post("/e/too-small/targets", target);
    await post("/e/too-small/targets/front/compile", new URLSearchParams({ scanDistanceMm: "500" }));
    const page = await pageAt("/e/too-small");
    expect(page).toContain("Printed as it stands it will not be recognised");
  });
});

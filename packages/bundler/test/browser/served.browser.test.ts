import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTarget, toTargetJson } from "@taggant/compiler";
import { type Browser, chromium } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artwork, inView, writeFeed } from "../../../runtime/test/browser/feed.js";
import { bundle } from "../../src/bundle.js";

declare global {
  interface Window {
    taggantExperience?: { threaded: boolean };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = join(here, "../../../runtime/dist");

/**
 * Sized so the camera actually delivers what the compiled target needs.
 *
 * The runtime recognises against a frame reduced to 480 px wide, and a target's smallest
 * size is half the raster it was analysed at, so the artwork has to fill enough of the
 * frame to clear that. Artwork at 480 px in a 640 px frame lands at 360 processed pixels
 * against a target whose smallest size is 320. Getting this wrong looks exactly like a
 * broken tracker and is neither.
 */
const ART = { width: 480, height: 360 };
const FRAME = { width: 640, height: 480 };
const PLACED = { x: 80, y: 60 };

const OVERLAY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#e2402a"/></svg>';

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

let browser: Browser | undefined;
let close: (() => Promise<void>) | undefined;
let origin = "";
let outDir = "";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "taggant-served-"));
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "overlay.svg"), OVERLAY);
  outDir = join(root, "out");

  const art = artwork(ART.width, ART.height);
  // Compiled by the real compiler rather than described directly, so this test is also the
  // only place the two halves of the system meet: artwork in one end, recognised out of the
  // other. Building targets by hand everywhere else is what let a change that made nothing
  // recognisable pass every test.
  const artworkPng = await sharp(Buffer.from(art.data), {
    raw: { width: art.width, height: art.height, channels: 1 },
  })
    .png()
    .toBuffer();
  const compiled = await compileTarget(artworkPng, { id: "front", scanDistanceMm: 350 });
  await bundle({
    manifest: {
      schemaVersion: "1.0.0",
      id: "served",
      title: "Served bundle",
      targets: [
        {
          id: "front",
          source: "artwork.png",
          physicalWidthMm: 148,
          content: [{ type: "image", src: "overlay.svg" }],
        },
      ],
    },
    targets: { front: toTargetJson(compiled) },
    sourceDir,
    outDir,
    runtimeDir: RUNTIME_DIST,
  });

  const scratchFeed = join(root, "camera.y4m");
  await writeFeed(scratchFeed, inView(art, FRAME.width, FRAME.height, PLACED.x, PLACED.y));

  // A plain static server over the bundle folder and nothing else. No resolver, no
  // console, no package registry, no path outside this directory. If the bundle needs
  // anything that is not in it, this is where that shows up.
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const parts = path.split("/").filter((part) => part && part !== "." && part !== "..");
    try {
      const body = await readFile(join(outDir, ...parts));
      response
        .writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a bound port");
  origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${scratchFeed}`,
    ],
  });

  close = async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}, 180_000);

afterAll(async () => {
  await close?.();
});

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(full);
  }
  return found;
}

describe("a published bundle", () => {
  it("runs from a static folder with everything else switched off", async () => {
    if (!browser) throw new Error("no browser");
    // The viewport matches the feed, so a position in the page can be compared with the
    // position the feed put the artwork at. The runtime scales the pose from the size it
    // tracked at to the size it is shown at, which is correct and would otherwise make
    // these two numbers describe different spaces.
    const context = await browser.newContext({
      permissions: ["camera"],
      viewport: { width: FRAME.width, height: FRAME.height },
    });
    const page = await context.newPage();

    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    // Anything the page asks for that this folder does not hold is a broken promise.
    const missing: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404) missing.push(response.url());
    });
    // And any request that leaves this origin at all.
    const offsite: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
        offsite.push(request.url());
    });

    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(
      () => document.querySelector("#scene")?.getAttribute("data-state") === "tracking",
      { timeout: 60_000 },
    );

    const overlay = page.locator('[data-taggant-target="front"]');
    expect(await overlay.count()).toBe(1);
    expect(await overlay.isHidden()).toBe(false);
    const box = await overlay.boundingBox();
    if (!box) throw new Error("expected the overlay to have a box");
    expect(Math.abs(box.x - PLACED.x)).toBeLessThan(40);
    expect(Math.abs(box.y - PLACED.y)).toBeLessThan(40);

    expect(missing).toEqual([]);
    expect(offsite).toEqual([]);
    expect(failures).toEqual([]);
    await context.close();
  }, 180_000);

  it("holds no absolute reference to anywhere in the code it ships", async () => {
    const files = await walk(outDir);
    const offending: string[] = [];
    for (const file of files) {
      if (![".html", ".js"].includes(extname(file))) continue;
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
        // An XML namespace is a name, not an address, and nothing fetches it.
        if (match[0].startsWith("http://www.w3.org/")) continue;
        offending.push(`${relative(outDir, file).split(sep).join("/")}: ${match[0]}`);
      }
    }
    expect(offending).toEqual([]);
  });
});

describe("a bundle that cannot start", () => {
  // The page used to do its work at the top of the module. A module that throws while it
  // is being evaluated is a page error, not a rejection, so the unhandledrejection handler
  // never fired: whoever scanned a printed code was left reading "Starting." with the
  // reason in a console they do not have, and the fallback the manifest exists to provide
  // was never reached. That is worse than a camera which will not open.
  //
  // Two cases rather than one, because following the fallback destroys the page: asserting
  // on the message and on the navigation in the same run is a race with the navigation.
  const breakTheTarget = async () => {
    const targetPath = join(outDir, "targets", "front.json");
    const good = await readFile(targetPath, "utf8");
    // Valid JSON, wrong shape: exactly how an unreadable target arrives.
    await writeFile(targetPath, JSON.stringify({ formatVersion: 99 }));
    return () => writeFile(targetPath, good);
  };
  const setFallback = async (value: string | undefined) => {
    const manifestPath = join(outDir, "manifest.json");
    const good = await readFile(manifestPath, "utf8");
    const { fallback: _existing, ...rest } = JSON.parse(good);
    const manifest = value === undefined ? rest : { ...rest, fallback: value };
    await writeFile(manifestPath, JSON.stringify(manifest));
    return () => writeFile(manifestPath, good);
  };

  it("says so, instead of leaving the viewer on Starting forever", async () => {
    if (!browser) throw new Error("no browser");
    const restoreTarget = await breakTheTarget();
    const restoreManifest = await setFallback(undefined);
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => !(document.getElementById("status")?.textContent ?? "").startsWith("Starting"),
        undefined,
        { timeout: 20_000 },
      );
      expect(await page.textContent("#status")).toContain("could not be loaded");
      expect(await page.getAttribute("#scene", "data-state")).toBe("error");
    } finally {
      await page.close().catch(() => undefined);
      await restoreTarget();
      await restoreManifest();
    }
  }, 60_000);

  it("sends the viewer where the manifest says to go", async () => {
    if (!browser) throw new Error("no browser");
    const restoreTarget = await breakTheTarget();
    const restoreManifest = await setFallback(`${origin}/fallback-reached`);
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/fallback-reached/, { timeout: 20_000 });
      expect(page.url()).toContain("/fallback-reached");
    } finally {
      await page.close().catch(() => undefined);
      await restoreTarget();
      await restoreManifest();
    }
  }, 60_000);
});

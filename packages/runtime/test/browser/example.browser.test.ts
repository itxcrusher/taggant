import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCanvasCamera } from "./camera-stub.js";

/**
 * The example, run the way its README tells a reader to run it.
 *
 * `examples/postcard` is the front door: the README points at it, and it is the first
 * thing anyone who finds this repository will try. Nothing opened it. What was checked
 * was that the figures in its README match what the compiler prints, which is a check on
 * two documents agreeing and not on the page working.
 *
 * Driving it found two things a reader would have met. The manifest carried a fallback
 * pointing at `example.com`, so refusing the camera navigated off the example to a
 * placeholder page with no explanation; and the page's own sentences had been overwritten
 * by the runtime's internal wording, so instead of "The camera could not be opened." it
 * said that a camera would not start playing within ten thousand milliseconds.
 *
 * The compile step is the README's own command, run as a command, so the instructions are
 * what is under test rather than a library call standing in for them.
 */

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../../..");
const EXAMPLE = join(ROOT, "examples/postcard");

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Where the artwork sits in the frame the camera shows. */
const PLACED = { x: 100, y: 90 };
const FRAME = { width: 800, height: 600 };

let browser: Browser | undefined;
let close: (() => Promise<void>) | undefined;
let origin = "";
let frame64 = "";
let artSize = { width: 0, height: 0 };

beforeAll(async () => {
  // The README's third command, verbatim apart from the paths being absolute.
  await run("node", [
    join(ROOT, "packages/compiler/dist/cli.js"),
    join(EXAMPLE, "artwork.png"),
    "--id",
    "front",
    "--scan-distance",
    "350",
    "--out",
    join(EXAMPLE, "front.target.json"),
  ]);

  // The artwork itself, in a frame, as the camera. Read through the compiler's own loader
  // so this is the same picture the compile step just described.
  const compiler = (await import(pathToFileURL(join(ROOT, "packages/compiler/dist/index.js")).href)) as {
    loadGrayscale: (bytes: Buffer) => Promise<{ width: number; height: number; data: Uint8Array }>;
  };
  const loadGrayscale = compiler.loadGrayscale;
  const art = await loadGrayscale(await readFile(join(EXAMPLE, "artwork.png")));
  artSize = { width: art.width, height: art.height };
  const frame = new Uint8Array(FRAME.width * FRAME.height).fill(150);
  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const into = (y + PLACED.y) * FRAME.width + (x + PLACED.x);
      if (y + PLACED.y < FRAME.height && x + PLACED.x < FRAME.width) {
        frame[into] = art.data[y * art.width + x] ?? 0;
      }
    }
  }
  frame64 = Buffer.from(frame).toString("base64");

  // `serve .` from the root of the repository, which is the README's fourth command. The
  // page imports the built packages by relative path, so the root is what has to be served.
  const server = createServer(async (request, response) => {
    let path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    if (path.endsWith("/")) path += "index.html";
    try {
      const body = await readFile(join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, "")));
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
  browser = await chromium.launch();
  close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await close?.();
});

describe("the example, opened the way its README says to open it", () => {
  it("finds the artwork through a camera and puts the content on it", async () => {
    if (!browser) throw new Error("no browser");
    const page = await browser.newPage({ viewport: FRAME });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    const missing: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404) missing.push(response.url().replace(origin, ""));
    });
    try {
      await page.addInitScript(installCanvasCamera, {
        encoded: frame64,
        width: FRAME.width,
        height: FRAME.height,
      });
      await page.goto(`${origin}/examples/postcard/`);
      await page.waitForFunction(
        () => document.querySelector("#scene")?.getAttribute("data-state") === "tracking",
        undefined,
        { timeout: 90_000 },
      );

      const overlay = page.locator('[data-taggant-target="front"]');
      expect(await overlay.count()).toBe(1);
      const box = await overlay.boundingBox();
      if (!box) throw new Error("expected the overlay to have a box");
      const said = await page.textContent("#status");
      console.log(
        `engine-line example: ${said}, content ${box.width.toFixed(0)}x${box.height.toFixed(0)} at ${box.x.toFixed(0)},${box.y.toFixed(0)} against artwork ${artSize.width}x${artSize.height} at ${PLACED.x},${PLACED.y}`,
      );

      // Where the frame put it, at the size it was tracked at. The artwork nearly fills the
      // frame here, so a pose that ignored recognition and centred the target would land
      // 20 px away in x and 15 in y, which these bounds do not admit.
      expect(Math.abs(box.x - PLACED.x)).toBeLessThan(12);
      expect(Math.abs(box.y - PLACED.y)).toBeLessThan(12);
      expect(Math.abs(box.width - artSize.width)).toBeLessThan(artSize.width * 0.1);
      expect(said).toBe("Found it.");
      expect(missing, "the example asked for something the repository does not serve").toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180_000);

  it("says so and stays where it is when there is no camera", async () => {
    if (!browser) throw new Error("no browser");
    const page = await browser.newPage({ viewport: FRAME });
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      });
      await page.goto(`${origin}/examples/postcard/`);
      await page.waitForFunction(
        () => document.querySelector("#scene")?.getAttribute("data-state") === "error",
        undefined,
        { timeout: 30_000 },
      );
      // Still here. A manifest with a fallback would have sent the reader away, which this
      // one used to do, to a placeholder domain, from the repository's own example.
      expect(page.url()).toContain("/examples/postcard/");
      // And in the page's own words rather than the runtime's, which is what the entry page
      // says it is for: the reason goes to the console.
      expect(await page.textContent("#status")).toBe("The camera could not be opened.");
    } finally {
      await page.close();
    }
  }, 60_000);
});

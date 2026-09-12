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
/** Set by a test to serve a 404 for the files a reader may not have made yet. */
let withhold: (path: string) => boolean = () => false;
/** Set by a test to serve something else in place of a file the example ships. */
let swap: Record<string, string> = {};

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
    if (withhold(path)) {
      response.writeHead(404).end();
      return;
    }
    const instead = swap[path];
    if (instead !== undefined) {
      response
        .writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
        .end(instead);
      return;
    }
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

      // What is actually on the artwork, and that the frames came from the canvas.
      //
      // Everything above passes with an overlay that is served, valid, and renders nothing:
      // a reader gets the camera picture, the words "Found it." and a blank rectangle. The
      // sibling test for a published bundle checks all of this and this one did not, which
      // is the same gap twice in one repository.
      const shown = await page.evaluate(() => {
        const holder = document.querySelector('[data-taggant-target="front"]');
        const image = holder?.querySelector("img");
        return {
          children: holder?.childElementCount ?? 0,
          image: image ? `${image.naturalWidth}x${image.naturalHeight}` : "none",
          hidden: (holder as HTMLElement | null)?.hidden ?? true,
          asked:
            (window as unknown as { cameraDiagnostics?: { called: number } }).cameraDiagnostics?.called ?? 0,
        };
      });
      expect(shown.children, "the overlay is there and empty, so a reader sees nothing").toBeGreaterThan(0);
      expect(shown.image, "the content image did not load").not.toBe("none");
      expect(shown.hidden).toBe(false);

      // Whether anything is actually painted, read off the content's own pixels.
      //
      // None of the checks above notices an overlay that renders nothing. An empty but valid
      // SVG is served, loads, and reports a natural size of 300 by 150, so a page showing
      // the camera picture, the words "Found it." and a blank rectangle passes every one of
      // them: that was driven, and it did. Drawing the content and counting what is not
      // transparent is the check that means "a reader sees something".
      const painted = await page.evaluate(() => {
        const image = document.querySelector('[data-taggant-target="front"] img') as HTMLImageElement | null;
        if (!image) return -1;
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return -1;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let i = 3; i < pixels.length; i += 4) if ((pixels[i] ?? 0) > 200) opaque++;
        return opaque / (canvas.width * canvas.height);
      });
      console.log(`engine-line example: content covers ${(painted * 100).toFixed(1)}% of its own box`);
      expect(painted, "the content rendered nothing, so a reader sees a blank rectangle").toBeGreaterThan(
        0.9,
      );
      expect(Math.abs(box.height - artSize.height)).toBeLessThan(artSize.height * 0.1);
      // The stub answered, so the picture came from the canvas and not from anywhere else.
      // This is the only assertion that would notice the init script failing to install.
      expect(shown.asked, "the stub was never asked for a camera").toBeGreaterThan(0);
      expect(missing, "the example asked for something the repository does not serve").toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180_000);

  /**
   * The two ways a reader gets here without having finished the instructions. Both used to
   * leave the page saying "Starting." for as long as they were willing to look at it, with
   * the reason in a console they may not have open. The published entry page was fixed for
   * exactly this and the example, which is what the README points at, was not.
   *
   * A module that fails while it is being evaluated cannot be caught from inside itself, so
   * this is worth having a test for rather than an assumption: the listeners are outside.
   */
  it.each([
    ["the packages are not built", (path: string) => path.includes("/dist/"), /dist\/index\.js/],
    [
      "the target is not compiled",
      (path: string) => path.endsWith("front.target.json"),
      /compile step writes it/,
    ],
  ])(
    "says what is missing when %s",
    async (_what, hide, expected) => {
      if (!browser) throw new Error("no browser");
      const page = await browser.newPage({ viewport: FRAME });
      // Set inside the try, so a page that fails to open does not leave it set for every
      // case after this one, which would then fail on the wrong thing.
      try {
        withhold = hide;
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
        });
        await page.goto(`${origin}/examples/postcard/`);
        await page.waitForFunction(
          () => !(document.getElementById("status")?.textContent ?? "").startsWith("Starting"),
          undefined,
          { timeout: 30_000 },
        );
        const said = (await page.textContent("#status")) ?? "";
        expect(said, "the page did not name what was missing").toMatch(expected);
        // And it points at the way out rather than only at the symptom.
        expect(said).toMatch(/README/);
        expect(await page.getAttribute("#scene", "data-state")).toBe("error");
      } finally {
        withhold = () => false;
        await page.close();
      }
    },
    60_000,
  );

  /**
   * The likeliest authoring mistake there is, and the page has to say it.
   *
   * The runtime's own source calls a mismatch between a manifest's target ids and the
   * compiled ones one of the likeliest mistakes in authoring this, and says silence about
   * it is the worst outcome. It was silent: the report arrives, and the state that follows
   * it in the same task replaced it with a sentence telling the author to point a camera at
   * artwork that can never be found. Nothing reached the console either.
   */
  it("tells the author when the manifest names a target nothing was built for", async () => {
    if (!browser) throw new Error("no browser");
    const manifest = JSON.parse(await readFile(join(EXAMPLE, "manifest.json"), "utf8"));
    manifest.targets[0].id = "back";
    const page = await browser.newPage({ viewport: FRAME });
    try {
      swap = { "/examples/postcard/manifest.json": JSON.stringify(manifest) };
      await page.addInitScript(installCanvasCamera, {
        encoded: frame64,
        width: FRAME.width,
        height: FRAME.height,
      });
      await page.goto(`${origin}/examples/postcard/`);
      await page.waitForFunction(
        () => (document.getElementById("status")?.textContent ?? "").includes("no target in the manifest"),
        undefined,
        { timeout: 30_000 },
      );
      const said = (await page.textContent("#status")) ?? "";
      expect(said).toContain("front");
      // And it stays said. A state follows it immediately and used to overwrite it.
      await page.waitForTimeout(1_500);
      expect(await page.textContent("#status"), "the state sentence overwrote the problem").toContain(
        "no target in the manifest",
      );
    } finally {
      swap = {};
      await page.close();
    }
  }, 60_000);

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

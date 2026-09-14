import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTarget, toTargetJson } from "@taggant/compiler";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../../..");

/**
 * The page that measures a camera, driven against a camera whose answer is known in advance.
 *
 * This page carries the one assumption the print readiness report cannot derive: how much of
 * the world the camera's picture covers. Everything the compiler prints scales with it, so a
 * page that measures it wrongly is worse than no page, and nothing had ever run this one.
 *
 * Driving it found two things a reader would have hit in the first minute. The distance was a
 * row of buttons starting at 200 mm, which is past where the artwork the page tells you to
 * print can be recognised at all, so a correct measurement was divided by a distance nobody
 * was standing at. And the page recognised at 640 px where the runtime recognises at 480, so
 * it answered yes about prints the product answers no about.
 *
 * The camera is a canvas, as everywhere else in this repository. `getUserMedia` is replaced
 * on the instance and on `Navigator.prototype` before any page script runs, so no launch
 * flag or preference can let a real device through.
 */
describe("the measurement page", () => {
  let browser: Browser | undefined;
  let origin = "";
  let root = "";
  let server: ReturnType<typeof createServer> | undefined;
  let launchFailure = "";

  const TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
  };

  beforeAll(async () => {
    // Assembled the way `.github/workflows/pages.yml` assembles it, because the page needs
    // three things the repository does not check in and a test against a different bundle
    // than the one published is a test of nothing.
    root = await mkdtemp(join(tmpdir(), "taggant-measure-"));
    await mkdir(join(root, "measure", "runtime"), { recursive: true });
    const artwork = await readFile(join(REPO, "examples/postcard/artwork.png"));
    await writeFile(join(root, "artwork.png"), artwork);
    await writeFile(
      join(root, "measure", "index.html"),
      await readFile(join(REPO, "site/measure/index.html")),
    );
    await writeFile(
      join(root, "measure", "runtime", "vision.js"),
      await readFile(join(REPO, "packages/vision/dist/index.js")),
    );
    const compiled = await compileTarget(artwork, { id: "front", scanDistanceMm: 190 });
    await writeFile(join(root, "measure", "front.target.json"), JSON.stringify(toTargetJson(compiled)));

    server = createServer(async (request, response) => {
      try {
        let path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
        if (path.endsWith("/")) path += "index.html";
        const bytes = await readFile(join(root, path));
        response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
        response.end(bytes);
      } catch {
        response.writeHead(404);
        response.end("not here");
      }
    });
    await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    try {
      browser = await chromium.launch();
    } catch (error) {
      launchFailure = String(error).slice(0, 300);
    }
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => {
      if (server) server.close(() => done());
      else done();
    });
    if (root) await rm(root, { recursive: true, force: true });
  });

  /**
   * Open the page with a canvas camera standing at a chosen geometry, and read back the
   * field of view it reports.
   */
  async function ask(fieldDegrees: number, distanceMm: number, printedMm: number) {
    if (!browser) throw new Error(`chromium could not be launched: ${launchFailure}`);
    const native = 640;
    const pictureAtOneMetre = 2 * 1000 * Math.tan((fieldDegrees / 2) * (Math.PI / 180));
    const fraction = printedMm / (pictureAtOneMetre * (distanceMm / 1000));

    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.addInitScript(
      ({ artworkUrl, share, width }) => {
        const fake = {
          async getUserMedia() {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = Math.round((width * 3) / 4);
            const context = canvas.getContext("2d");
            const image = new Image();
            image.src = artworkUrl;
            await image.decode();
            const draw = () => {
              if (!context) return;
              // Flat mid grey, so every feature the page finds came from the artwork.
              context.fillStyle = "#969696";
              context.fillRect(0, 0, canvas.width, canvas.height);
              const w = canvas.width * share;
              const h = (image.height / image.width) * w;
              context.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
              requestAnimationFrame(draw);
            };
            draw();
            return (canvas as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(
              30,
            );
          },
          async enumerateDevices() {
            return [];
          },
        };
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => fake });
        Object.defineProperty(Navigator.prototype, "mediaDevices", { configurable: true, get: () => fake });
      },
      { artworkUrl: `${origin}/artwork.png`, share: fraction, width: native },
    );

    await page.goto(`${origin}/measure/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("found")?.dataset.found === "yes", undefined, {
      timeout: 60_000,
    });
    await page.fill("#printed", String(printedMm));
    await page.fill("#distance", String(distanceMm));
    await page.waitForTimeout(400);
    await page.click("#record");

    const reading = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll("#results thead th")).map(
        (c) => c.textContent?.trim() ?? "",
      );
      const cells = Array.from(document.querySelectorAll("#results tbody tr td")).map(
        (c) => c.textContent?.trim() ?? "",
      );
      const at = (name: string) => Number(cells[heads.indexOf(name)]);
      return { field: at("field deg"), pictureMm: at("picture mm"), atOneMetre: at("picture mm at 1 m") };
    });
    await page.close();
    return reading;
  }

  it.each([
    [55, 120, 148],
    [70, 150, 148],
    [80, 130, 200],
  ])(
    "reports a %i degree camera correctly, read from %i mm against a %i mm copy",
    async (field, distance, printed) => {
      const answer = await ask(field, distance, printed);
      // Within a degree. The page works from a recognised pose, so the only slack is where
      // the matcher puts the corners, and that is sub-pixel.
      expect(
        Math.abs(answer.field - field),
        `reported ${answer.field} degrees for a ${field} degree camera`,
      ).toBeLessThanOrEqual(1);
      // And the scale-free half, which does not depend on the distance being typed right.
      const truePicture = 2 * 1000 * Math.tan((field / 2) * (Math.PI / 180)) * (distance / 1000);
      expect(Math.abs(answer.pictureMm - truePicture) / truePicture).toBeLessThan(0.02);
    },
    120_000,
  );

  it("offers distances the artwork it names can actually be read at", async () => {
    if (!browser) throw new Error(`chromium could not be launched: ${launchFailure}`);
    // The page tells the reader to show a 148 mm wide copy. Under the corrected model that
    // is readable to about 190 mm and no further, and every button on the page used to start
    // at 200. A row of buttons all past the limit reads as the page being broken rather than
    // as the reader standing too far away.
    const page = await browser.newPage();
    await page.goto(`${origin}/measure/`, { waitUntil: "domcontentloaded" });
    // The page's script is a module, so it has not run when the document is ready. Without
    // this the query found no buttons and the case failed for a reason that was not the one
    // it is about.
    await page.waitForFunction(() => document.querySelectorAll("#distances button").length > 0, undefined, {
      timeout: 30_000,
    });
    const offered = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#distances button")).map((b) =>
        Number((b as HTMLElement).dataset.mm),
      ),
    );
    await page.close();
    expect(offered.length, "the page offers no distances at all").toBeGreaterThan(2);
    expect(
      Math.min(...offered),
      "the closest distance offered is already past where an A6 postcard can be read",
    ).toBeLessThanOrEqual(150);
  }, 60_000);
});

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
  async function ask(fieldDegrees: number, distanceMm: number, printedMm: number, pitch = 0) {
    if (!browser) throw new Error(`chromium could not be launched: ${launchFailure}`);
    const native = 640;
    const pictureAtOneMetre = 2 * 1000 * Math.tan((fieldDegrees / 2) * (Math.PI / 180));
    const fraction = printedMm / (pictureAtOneMetre * (distanceMm / 1000));

    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.addInitScript(
      ({ artworkUrl, share, width, pitch }) => {
        const fake = {
          async getUserMedia() {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = Math.round((width * 3) / 4);
            const context = canvas.getContext("2d");
            const image = new Image();
            image.src = artworkUrl;
            await image.decode();

            /**
             * The artwork as a pinhole camera sees it when the plane is pitched.
             *
             * Built once by inverse mapping, from the geometry rather than by stretching
             * rows. A stack of rows of varying width is a trapezoid and not a perspective
             * view of a rectangle: no homography fits it, so the matcher settles on a
             * near-similarity and the tilt it was built to show disappears. Asked for 28
             * degrees, that stub drew a top edge of 356 px against a bottom of 614 and the
             * page still called the view square on.
             *
             * For a plane pitched by t about its own horizontal axis, a distance d from a
             * camera of focal length f, a plane point (u, v) lands at
             * x = f*u/z, y = f*v*cos(t)/z with z = d + v*sin(t). That inverts in closed
             * form, which is all this needs.
             */
            let warped: HTMLCanvasElement | null = null;
            if (pitch !== 0) {
              const scratch = document.createElement("canvas");
              scratch.width = image.width;
              scratch.height = image.height;
              scratch.getContext("2d")?.drawImage(image, 0, 0);
              const source = scratch.getContext("2d")?.getImageData(0, 0, image.width, image.height);
              warped = document.createElement("canvas");
              warped.width = width;
              warped.height = Math.round((width * 3) / 4);
              const out = warped.getContext("2d");
              if (source && out) {
                const frame = out.createImageData(warped.width, warped.height);
                const t = (pitch * Math.PI) / 180;
                const d = 1000;
                // Focal length in pixels from the share the artwork should fill at zero tilt.
                const f = warped.width / 2 / (share / 2);
                const halfW = (share * warped.width * d) / (2 * f);
                const halfH = halfW * (image.height / image.width);
                const cx = warped.width / 2;
                const cy = warped.height / 2;
                for (let py = 0; py < warped.height; py++) {
                  for (let px = 0; px < warped.width; px++) {
                    const x = px - cx;
                    const y = py - cy;
                    const denom = f * Math.cos(t) - y * Math.sin(t);
                    const at = (py * warped.width + px) * 4;
                    let r = 150;
                    let g = 150;
                    let b = 150;
                    if (denom !== 0) {
                      const v = (y * d) / denom;
                      const z = d + v * Math.sin(t);
                      const u = (x * z) / f;
                      if (z > 0 && Math.abs(u) <= halfW && Math.abs(v) <= halfH) {
                        const sx = Math.min(
                          image.width - 1,
                          Math.max(0, Math.round(((u + halfW) / (2 * halfW)) * image.width)),
                        );
                        const sy = Math.min(
                          image.height - 1,
                          Math.max(0, Math.round(((v + halfH) / (2 * halfH)) * image.height)),
                        );
                        const from = (sy * image.width + sx) * 4;
                        r = source.data[from] ?? 150;
                        g = source.data[from + 1] ?? 150;
                        b = source.data[from + 2] ?? 150;
                      }
                    }
                    frame.data[at] = r;
                    frame.data[at + 1] = g;
                    frame.data[at + 2] = b;
                    frame.data[at + 3] = 255;
                  }
                }
                out.putImageData(frame, 0, 0);
              }
            }
            const draw = () => {
              if (!context) return;
              // Flat mid grey, so every feature the page finds came from the artwork.
              context.fillStyle = "#969696";
              context.fillRect(0, 0, canvas.width, canvas.height);
              const w = canvas.width * share;
              const h = (image.height / image.width) * w;
              const top = (canvas.height - h) / 2;
              if (pitch === 0) {
                context.drawImage(image, (canvas.width - w) / 2, top, w, h);
              } else if (warped) {
                context.drawImage(warped, 0, 0);
              }
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
      { artworkUrl: `${origin}/artwork.png`, share: fraction, width: native, pitch },
    );

    await page.goto(`${origin}/measure/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("found")?.dataset.found === "yes", undefined, {
      timeout: 60_000,
    });
    await page.fill("#printed", String(printedMm));
    await page.fill("#distance", String(distanceMm));
    await page.waitForTimeout(400);
    if (!(await page.isDisabled("#record"))) await page.click("#record");

    const recordable = !(await page.isDisabled("#record"));
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
    const line = (await page.textContent("#found"))?.trim() ?? "";
    await page.close();
    return { ...reading, recordable, line };
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

  it("refuses to record a tilted reading, because it is wrong rather than merely nervous", async () => {
    // The page measured the width from the top edge alone, and tilt foreshortens that edge.
    // Against frames built at a known pitch the reading came back 4.4 per cent low at 5
    // degrees and 12.1 per cent low at 15, and every print width the compiler derives
    // scales with it. It averages both horizontal edges now, which holds the same cases
    // inside two per cent, and past that it says so and will not take the reading.
    const tilted = await ask(70, 150, 148, 28);
    expect(tilted.line, `the page did not call this tilted: ${tilted.line}`).toContain("TILTED");
    expect(tilted.recordable, "a tilted reading could still be recorded").toBe(false);

    // And it is not simply refusing everything: square on, the same geometry records.
    const square = await ask(70, 150, 148, 0);
    expect(square.line).toContain("square on");
    expect(square.recordable).toBe(true);
  }, 180_000);

  it("will not turn an empty measurement box into a number", async () => {
    if (!browser) throw new Error(`chromium could not be launched: ${launchFailure}`);
    // The width box fell back to 148 mm whenever it held nothing usable, so a reader who
    // cleared it, or never typed in it, got a full row of confident figures about a print
    // nobody had measured. That is how the first real reading off this page came back: both
    // boxes left at their defaults, and a field of view derived from two numbers that were
    // not measurements of anything.
    const field = 70;
    const distance = 150;
    const printed = 148;
    const native = 640;
    const share = printed / (2 * 1000 * Math.tan((field / 2) * (Math.PI / 180)) * (distance / 1000));

    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.addInitScript(
      ({ artworkUrl, width, fill }) => {
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
              context.fillStyle = "#969696";
              context.fillRect(0, 0, canvas.width, canvas.height);
              const w = canvas.width * fill;
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
      { artworkUrl: `${origin}/artwork.png`, width: native, fill: share },
    );
    await page.goto(`${origin}/measure/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (document.getElementById("found")?.textContent ?? "").includes("px across"),
      undefined,
      {
        timeout: 60_000,
      },
    );

    // Clear the width. The artwork is still found; the figures must stop.
    await page.fill("#printed", "");
    await page.waitForTimeout(400);
    const cleared = (await page.textContent("#found")) ?? "";
    expect(cleared, `with the width cleared the page still said: ${cleared}`).not.toContain("px across");
    expect(cleared).toContain("type the measured print width");
    expect(await page.isDisabled("#record"), "an unmeasured reading could still be recorded").toBe(true);

    // And the same for the distance on its own.
    await page.fill("#printed", String(printed));
    await page.fill("#distance", "");
    await page.waitForTimeout(400);
    expect(await page.isDisabled("#record"), "a reading with no distance could still be recorded").toBe(true);

    // Both back: it records, and records the numbers that are in the boxes.
    await page.fill("#distance", String(distance));
    await page.waitForTimeout(400);
    expect(await page.isDisabled("#record")).toBe(false);
    await page.click("#record");
    const row = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll("#results thead th")).map(
        (c) => c.textContent?.trim() ?? "",
      );
      const cells = Array.from(document.querySelectorAll("#results tbody tr td")).map(
        (c) => c.textContent?.trim() ?? "",
      );
      return { printed: cells[heads.indexOf("printed")], distance: cells[heads.indexOf("distance")] };
    });
    await page.close();
    expect(row.printed).toBe(`${printed} mm`);
    expect(row.distance).toBe(`${distance} mm`);
  }, 120_000);

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

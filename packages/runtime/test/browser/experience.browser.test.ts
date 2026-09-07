import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrackingFeatures, toTargetFile } from "@taggant/vision";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artwork, inView, writeFeed } from "./feed.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(here, "../../dist/index.js");

const ART = { width: 320, height: 240 };
const FRAME = { width: 640, height: 480 };
const PLACED = { x: 150, y: 110 };

const MANIFEST = {
  schemaVersion: "1.0.0",
  id: "harness",
  targets: [
    {
      id: "front",
      source: "artwork.png",
      physicalWidthMm: 148,
      content: [{ type: "image", src: "overlay.svg" }],
    },
  ],
};

/** A one pixel SVG, so the page has real content to place without shipping a binary. */
const OVERLAY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#e2402a"/></svg>';

let browser: Browser | undefined;
let close: (() => Promise<void>) | undefined;
let origin = "";

beforeAll(async () => {
  const art = artwork(ART.width, ART.height);
  const target = toTargetFile({
    id: "front",
    width: ART.width,
    height: ART.height,
    features: buildTrackingFeatures(art),
  });

  const scratch = await mkdtemp(join(tmpdir(), "taggant-browser-"));
  const feed = join(scratch, "camera.y4m");
  await writeFeed(feed, inView(art, FRAME.width, FRAME.height, PLACED.x, PLACED.y));

  const files = new Map<string, { body: Buffer; type: string }>([
    ["/page.html", { body: await readFile(join(here, "page.html")), type: "text/html" }],
    ["/runtime.js", { body: await readFile(RUNTIME), type: "text/javascript" }],
    ["/manifest.json", { body: Buffer.from(JSON.stringify(MANIFEST)), type: "application/json" }],
    ["/target.json", { body: Buffer.from(JSON.stringify(target)), type: "application/json" }],
    ["/overlay.svg", { body: Buffer.from(OVERLAY), type: "image/svg+xml" }],
  ]);

  const server = createServer((request, response) => {
    const file = files.get((request.url ?? "").split("?")[0] ?? "");
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": file.type }).end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a bound port");
  // localhost is a secure context, which getUserMedia requires.
  origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${feed}`,
    ],
  });

  close = async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe("the runtime in a browser, against a camera", () => {
  it("opens the camera, finds the artwork and puts the content on it", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({ permissions: ["camera"] });
    const page = await context.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));

    await page.goto(`${origin}/page.html`);
    const stage = page.locator("#stage");
    await stage.waitFor({ state: "attached" });
    // Recognition runs per frame, so this is waiting for the pipeline, not for a load.
    await page.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-state") === "tracking",
      {
        timeout: 60_000,
      },
    );

    const overlay = page.locator('[data-taggant-target="front"]');
    expect(await overlay.count()).toBe(1);
    expect(await overlay.isHidden()).toBe(false);

    const transform = await overlay.evaluate((element) => (element as HTMLElement).style.transform);
    expect(transform).toMatch(/^matrix3d\(/);
    expect(transform).not.toBe("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)");

    // Where the runtime thinks the artwork is, against where the feed actually put it.
    const box = await overlay.boundingBox();
    if (!box) throw new Error("expected the overlay to have a box");
    expect(box.x).toBeGreaterThan(PLACED.x - 40);
    expect(box.x).toBeLessThan(PLACED.x + 40);
    expect(box.y).toBeGreaterThan(PLACED.y - 40);
    expect(box.y).toBeLessThan(PLACED.y + 40);

    expect(failures).toEqual([]);
    await context.close();
  }, 120_000);

  it("reports a refused camera as denied rather than failing silently", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({ permissions: [] });
    await context.grantPermissions([]);
    const page = await context.newPage();
    // Refuse the device outright, which is what a viewer declining the prompt produces.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
        },
      });
    });
    await page.goto(`${origin}/page.html`);
    await page.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-state") === "denied",
      {
        timeout: 30_000,
      },
    );
    expect(await page.locator("#stage").getAttribute("data-state")).toBe("denied");
    await context.close();
  }, 60_000);
});

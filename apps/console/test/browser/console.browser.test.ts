import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../../src/operations.js";
import { createConsole } from "../../src/server.js";
import { createWorkspace } from "../../src/workspace.js";

/**
 * The console in a real browser.
 *
 * This exists because of a defect no assertion about the HTML could have found. The
 * console sends a style-src of self, which blocks inline style attributes, and the pages
 * were written with them: every string assertion passed and the running page had no
 * spacing, no alignment and no layout at all. It was found by opening it.
 *
 * So this test opens it, and fails on anything the browser refused.
 */

const RUNTIME_DIST = fileURLToPath(new URL("../../../../packages/runtime/dist", import.meta.url));

async function artwork(size = 600): Promise<Buffer> {
  const pixels = Buffer.alloc(size * size).fill(238);
  let seed = 4242;
  for (let i = 0; i < 200; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const value = seed % 2 === 0 ? 28 : 140;
    for (let y = Math.max(0, cy - 18); y < Math.min(size, cy + 18); y++) {
      for (let x = Math.max(0, cx - 18); x < Math.min(size, cx + 18); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= 324 && x >= cx - 9) pixels[y * size + x] = value;
      }
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
}

let browser: Browser;
let server: Server;
let origin = "";
let scratch = "";
/** Made in the hook, so a case that only needs a page to open does not depend on another. */
const STANDING = "standing-experience";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "console-browser-"));
  const workspace = createWorkspace(join(scratch, "workspace"));
  server = createConsole({
    workspace,
    publishRoot: join(scratch, "bundles"),
    linkTablePath: join(scratch, "links.json"),
    runtimeDir: RUNTIME_DIST,
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();

  // An experience for the cases that only need one to look at. They used to open the one
  // the case above them builds through the interface, so neither passed on its own and
  // reordering or filtering the file broke both. Built here through the same calls the
  // interface makes, rather than through the interface, because the case that drives the
  // interface is still doing that and that is what it is for.
  await workspace.create(STANDING, "Standing experience");
  const stored = await workspace.storeFile(STANDING, "artwork", "front.png", await artwork());
  await workspace.update(STANDING, (manifest) => ({
    ...manifest,
    targets: [
      ...(manifest.targets ?? []),
      { id: "front-panel", source: stored, physicalWidthMm: 120, content: [] },
    ],
  }));
  await compile(workspace, await workspace.read(STANDING), "front-panel");
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server.close(() => done()));
});

describe("the console in a browser", () => {
  it("renders and works, with nothing the browser had to refuse", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const refused: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") refused.push(message.text());
    });
    page.on("pageerror", (error) => refused.push(String(error)));
    page.on("requestfailed", (request) => refused.push(`${request.url()} ${request.failure()?.errorText}`));

    await page.goto(origin, { waitUntil: "networkidle" });

    // The stylesheet actually applied, rather than merely being linked.
    const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(ground).toBe("rgb(11, 12, 14)");

    await page.fill("#new-id", "botanica-500");
    await page.fill("#new-title", "Botanica 500 ml");
    await page.click("button:has-text('Create')");
    await page.waitForLoadState("networkidle");

    // A class that came from a replaced inline style. If the policy blocked it or the
    // class was never added, the element sits at its default and this is 0.
    const gap = await page.evaluate(() => {
      const form = document.querySelector("form[action$='/targets']");
      return form ? Number.parseFloat(getComputedStyle(form).marginTop) : 0;
    });
    expect(gap).toBeGreaterThan(0);

    const artworkPath = join(scratch, "front.png");
    await writeFile(artworkPath, await artwork());
    await page.fill("#t-id", "front-panel");
    await page.fill("#t-width", "120");
    await page.setInputFiles("#t-file", artworkPath);
    await page.click("form[action$='/targets'] button:has-text('Add')");
    await page.waitForLoadState("networkidle");

    await page.click("button:has-text('Compile')");
    await page.waitForLoadState("networkidle");
    expect(await page.textContent(".verdict .state")).toContain("Ready for press");

    // The reveal is a real disclosure: the record is not in view until it is opened.
    expect(await page.locator(".record-body").isVisible()).toBe(false);
    await page.click("summary:has-text('Under the lamp')");
    expect(await page.locator(".record-body").isVisible()).toBe(true);
    expect(await page.textContent(".record-body")).toMatch(/features/);

    expect(refused).toEqual([]);
    await page.close();
  }, 120_000);

  it("does not scroll sideways on a phone", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/e/${STANDING}`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.close();
  }, 60_000);

  it("still shows the whole page with no script at all", async () => {
    // Server rendered, so this is a claim worth pinning: the reveal is a details element
    // rather than something a listener opens.
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, javaScriptEnabled: false });
    await page.goto(`${origin}/e/${STANDING}`, { waitUntil: "domcontentloaded" });
    expect(await page.textContent(".verdict .state")).toContain("Ready for press");
    await page.click("summary:has-text('Under the lamp')");
    expect(await page.locator(".record-body").isVisible()).toBe(true);
    await page.close();
  }, 60_000);
});

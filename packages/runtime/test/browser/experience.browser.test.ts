import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrackingFeatures, toTargetFile } from "@taggant/vision";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

declare global {
  interface Window {
    taggantExperience?: { threaded: boolean };
    // Set by the bare page below, so a test can mount its own manifest.
    mountExperience?: (options: Record<string, unknown>) => Promise<{
      state: string;
      threaded: boolean;
      unmatchedTargets: readonly string[];
    }>;
    taggantReady?: boolean;
    taggantProblems?: string[];
  }
}
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

/** A page that exposes the runtime and mounts nothing, for tests that supply their own manifest. */
const BARE = `<!doctype html><html><head><meta charset="utf-8"><title>bare</title></head>
<body><div id="scene" style="width:640px;height:480px"></div>
<script type="module">
  import { mountExperience } from "/runtime.js";
  window.taggantProblems = [];
  window.mountExperience = mountExperience;
  window.taggantReady = true;
</script></body></html>`;

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
    // The worker is loaded by URL from beside the runtime, so it has to be served too.
    ["/worker.js", { body: await readFile(join(dirname(RUNTIME), "worker.js")), type: "text/javascript" }],
    ["/manifest.json", { body: Buffer.from(JSON.stringify(MANIFEST)), type: "application/json" }],
    ["/target.json", { body: Buffer.from(JSON.stringify(target)), type: "application/json" }],
    ["/overlay.svg", { body: Buffer.from(OVERLAY), type: "image/svg+xml" }],
    // A page with no manifest of its own, so a test can mount whatever it needs to.
    ["/bare.html", { body: Buffer.from(BARE), type: "text/html" }],
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

    // Recognition must be off the page's thread. It falls back to the main thread where a
    // browser will not give it one, and that fallback is quiet, so without this the page
    // could go back to freezing for a fifth of a second at a time and every test still pass.
    expect(await page.evaluate(() => window.taggantExperience?.threaded)).toBe(true);

    // And the page has to keep painting while it does. This asserts the median and the
    // share of long frames rather than the single worst one: a collector pause can stall
    // any page once, and a test that fails on one of those is a test that gets ignored.
    const pacing = await page.evaluate(async () => {
      const gaps: number[] = [];
      let last = performance.now();
      await new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          if (++frames >= 90) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      gaps.sort((a, b) => a - b);
      return { median: gaps[Math.floor(gaps.length / 2)] ?? 0, long: gaps.filter((gap) => gap > 100).length };
    });
    // On the main thread the median would sit at the recognition cost, which is measured
    // in hundreds of milliseconds, not near the display's own frame time.
    expect(pacing.median).toBeLessThan(40);
    expect(pacing.long).toBeLessThan(5);

    expect(failures).toEqual([]);
    await context.close();
  }, 120_000);

  it("refuses a fallback that is not http or https, rather than running it", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    // No camera at all, which is the path that follows the fallback.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    });
    await page.goto(`${origin}/bare.html`);
    await page.waitForFunction(() => window.taggantReady === true);

    const result = await page.evaluate(async () => {
      (window as unknown as { ran?: boolean }).ran = false;
      const mounted = await window.mountExperience?.({
        manifest: {
          schemaVersion: "1.0.0",
          id: "probe",
          targets: [],
          // A manifest is a format other people write. Nothing forces a caller to run the
          // validator first, so the runtime has to refuse this itself.
          fallback: "javascript:window.ran=true;void 0",
        },
        targets: [],
        container: document.getElementById("scene"),
        options: { onProblem: (message: string) => window.taggantProblems?.push(message) },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        state: mounted?.state,
        ran: (window as unknown as { ran?: boolean }).ran,
        problems: window.taggantProblems,
      };
    });

    expect(result.ran).toBe(false);
    expect(result.problems?.[0]).toMatch(/refused to follow a fallback/i);
    await context.close();
  }, 60_000);

  it("says when a compiled target is not claimed by any target in the manifest", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({ permissions: ["camera"] });
    const page = await context.newPage();
    await page.goto(`${origin}/bare.html`);
    await page.waitForFunction(() => window.taggantReady === true);

    const result = await page.evaluate(async () => {
      const mounted = await window.mountExperience?.({
        manifest: {
          schemaVersion: "1.0.0",
          id: "probe",
          targets: [
            {
              id: "back",
              source: "a.png",
              physicalWidthMm: 100,
              content: [{ type: "image", src: "overlay.svg" }],
            },
          ],
        },
        // Called front; the manifest only describes back.
        targets: [{ id: "front", width: 100, height: 100, features: [] }],
        container: document.getElementById("scene"),
        options: { onProblem: (message: string) => window.taggantProblems?.push(message) },
      });
      return {
        unmatched: mounted?.unmatchedTargets,
        overlays: document.querySelectorAll("[data-taggant-target]").length,
        problems: window.taggantProblems,
      };
    });

    expect([...(result.unmatched ?? [])]).toEqual(["front"]);
    expect(result.overlays).toBe(0);
    expect(result.problems?.some((message) => message.includes("front"))).toBe(true);
    await context.close();
  }, 60_000);

  it("gives up and takes the content away when recognition stops answering", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({ permissions: ["camera"] });
    const page = await context.newPage();
    // Capture the worker so the test can end it, which is what a browser does under
    // memory pressure. A terminated worker fires neither a reply nor an error.
    await page.addInitScript(() => {
      const created: Worker[] = [];
      (window as unknown as { taggantWorkers: Worker[] }).taggantWorkers = created;
      const Real = window.Worker;
      window.Worker = class extends Real {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args);
          created.push(this);
        }
      };
    });
    await page.goto(`${origin}/page.html`);
    await page.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-state") === "tracking",
      { timeout: 60_000 },
    );

    const outcome = await page.evaluate(async () => {
      for (const worker of (window as unknown as { taggantWorkers: Worker[] }).taggantWorkers)
        worker.terminate();
      await new Promise((resolve) => setTimeout(resolve, 9000));
      return {
        state: document.querySelector("#stage")?.getAttribute("data-state"),
        hidden: (document.querySelector("[data-taggant-target]") as HTMLElement | null)?.hidden,
      };
    });

    // The failure this guards against is the page going on saying "tracking" with content
    // frozen where the artwork used to be, which is what it did before there was a timeout.
    expect(outcome.state).toBe("error");
    expect(outcome.hidden).toBe(true);
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

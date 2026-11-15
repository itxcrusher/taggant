import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrackingFeatures, toTargetFile } from "@taggant/vision";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
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
    fromTargetFile?: (stored: unknown) => unknown;
  }
}
import { installCanvasCamera } from "./camera-stub.js";
import { artwork, inView } from "./feed.js";

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
  import { mountExperience, fromTargetFile } from "/runtime.js";
  window.taggantProblems = [];
  window.mountExperience = mountExperience;
  window.fromTargetFile = fromTargetFile;
  window.taggantReady = true;
</script></body></html>`;

/** A one pixel SVG, so the page has real content to place without shipping a binary. */
const OVERLAY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#e2402a"/></svg>';

/** A clip of a few seconds, recorded once in a page and served to every test that plays one. */
let clip: Buffer | undefined;

/**
 * Record a clip from a canvas, in the page, and return it as base64, so the tests that play
 * a video play a real one without the repository shipping a binary.
 */
async function recordClip(seconds: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  const paint = canvas.getContext("2d");
  if (!paint) throw new Error("no 2d context");
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  const until = performance.now() + seconds * 1000;
  recorder.start();
  await new Promise<void>((resolve) => {
    const again = () => {
      paint.fillStyle = `hsl(${Math.round(performance.now() / 10) % 360} 80% 50%)`;
      paint.fillRect(0, 0, canvas.width, canvas.height);
      if (performance.now() < until) requestAnimationFrame(again);
      else resolve();
    };
    again();
  });
  recorder.stop();
  await stopped;
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A page with the canvas camera, the bare runtime and the clip served at `clip.webm`. */
async function openWithClip(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(installCanvasCamera, {
    encoded: frame64,
    width: FRAME.width,
    height: FRAME.height,
  });
  await page.goto(`${origin}/bare.html`);
  await page.waitForFunction(() => window.taggantReady === true);
  clip ??= Buffer.from(await page.evaluate(recordClip, 4), "base64");
  if (clip.length === 0) throw new Error("the browser recorded an empty clip");
  const body = clip;
  await page.route(`${origin}/clip.webm`, (route) => route.fulfill({ contentType: "video/webm", body }));
  return page;
}

/**
 * Mount a target whose video waits for the viewer, with any other content given after it,
 * keep the experience as `experience`, record that video's play and pause events, and wait
 * for the target to be tracked.
 */
async function mountManualVideo(page: Page, alongside: unknown[] = []): Promise<void> {
  await page.evaluate(async (others) => {
    const target = await (await fetch("/target.json")).json();
    (window as unknown as { experience: unknown }).experience = await window.mountExperience?.({
      manifest: {
        schemaVersion: "1.0.0",
        id: "manual-video",
        targets: [
          {
            id: "front",
            source: "artwork.png",
            physicalWidthMm: 148,
            content: [{ type: "video", src: "clip.webm", autoplay: false, muted: false }, ...others],
          },
        ],
      },
      targets: [window.fromTargetFile?.(target)],
      container: document.getElementById("scene"),
    });
    const events: string[] = [];
    (window as unknown as { mediaEvents: string[] }).mediaEvents = events;
    const media = document.querySelector('[data-taggant-target="front"] video');
    for (const name of ["play", "pause"]) media?.addEventListener(name, () => events.push(name));
  }, alongside);
  await page.waitForFunction(
    () => document.querySelector("#scene")?.getAttribute("data-state") === "tracking",
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () =>
      ((document.querySelector('[data-taggant-target="front"] video') as HTMLVideoElement | null)
        ?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * What the video is doing once it has had time to play. Chromium's controls answer a click
 * on the picture about 300 ms after it, to tell it from a double click, so a pause they add
 * comes after the click has returned; the state is read a second after the clip has moved.
 */
async function playback(
  page: Page,
): Promise<{ paused: boolean; muted: boolean; advanced: boolean; events: string }> {
  return page.evaluate(async () => {
    const media = document.querySelector('[data-taggant-target="front"] video') as HTMLVideoElement;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = performance.now() + 10_000;
    while (media.currentTime < 0.3 && performance.now() < deadline) await wait(50);
    const advanced = media.currentTime >= 0.3;
    await wait(1000);
    return {
      paused: media.paused,
      muted: media.muted,
      advanced,
      events: (window as unknown as { mediaEvents: string[] }).mediaEvents.join(","),
    };
  });
}

let browser: Browser | undefined;
let close: (() => Promise<void>) | undefined;
let origin = "";
/** The camera frame, as base64, because it crosses into an init script. */
let frame64 = "";

beforeAll(async () => {
  const art = artwork(ART.width, ART.height);
  const target = toTargetFile({
    id: "front",
    width: ART.width,
    height: ART.height,
    features: buildTrackingFeatures(art),
  });

  // The camera every test here is given: the artwork, in a frame, on a canvas. No engine is
  // asked for a real one, and no launch flag stands between this suite and hardware. The
  // flags this used to rely on are a weaker guarantee than replacing the API outright, and
  // the same shape of protection opened a real webcam once on the file next door.
  frame64 = Buffer.from(inView(art, FRAME.width, FRAME.height, PLACED.x, PLACED.y).data).toString("base64");

  const files = new Map<string, { body: Buffer; type: string }>([
    ["/page.html", { body: await readFile(join(here, "page.html")), type: "text/html" }],
    ["/runtime.js", { body: await readFile(RUNTIME), type: "text/javascript" }],
    ["/manifest.json", { body: Buffer.from(JSON.stringify(MANIFEST)), type: "application/json" }],
    ["/target.json", { body: Buffer.from(JSON.stringify(target)), type: "application/json" }],
    ["/overlay.svg", { body: Buffer.from(OVERLAY), type: "image/svg+xml" }],
    // A page with no manifest of its own, so a test can mount whatever it needs to.
    ["/bare.html", { body: Buffer.from(BARE), type: "text/html" }],
  ]);

  // Everything the build emitted, under its own name. The worker is loaded by URL from
  // beside the runtime and both import a shared chunk, so naming the files here meant this
  // server had to be edited whenever that build changed shape. It was not, and the whole
  // suite went red at once with a 404 nobody could see from the assertion that failed.
  const dist = dirname(RUNTIME);
  for (const name of await readdir(dist)) {
    if (name.endsWith(".js")) {
      files.set(`/${name}`, { body: await readFile(join(dist, name)), type: "text/javascript" });
    }
  }

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

  browser = await chromium.launch();

  close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}, 120_000);

afterAll(async () => {
  // Closed here rather than through `close`, because `close` is assigned at the end of a
  // hook that extracts features, writes the feed and launches a browser first, so anything
  // failing before that assignment left a browser with nothing to close it.
  await browser?.close();
  await close?.();
});

describe("the runtime in a browser, against a camera", () => {
  it("opens the camera, finds the artwork and puts the content on it", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(installCanvasCamera, {
      encoded: frame64,
      width: FRAME.width,
      height: FRAME.height,
    });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));

    await page.goto(`${origin}/page.html`);
    const stage = page.locator("#stage");
    await stage.waitFor({ state: "attached" });
    // Recognition runs per frame, so this is waiting for the pipeline, not for a load.
    await page.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-state") === "tracking",
      undefined,
      { timeout: 60_000 },
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

    // And the page has to keep painting while it does. The median is the only part of this
    // that is asserted. Counting frames over 100 ms was asserted too and it measured the
    // machine rather than the runtime: it broke the moment another test file in this
    // package started three browsers beside it, with the runtime unchanged. The median
    // separates the two states this is here to tell apart by an order of magnitude, since
    // recognition on the page's thread costs a couple of hundred milliseconds against a
    // frame time near sixteen, so it survives a busy machine. The long frame count is
    // printed instead, because it is worth seeing and not worth failing on.
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
      return {
        median: gaps[Math.floor(gaps.length / 2)] ?? 0,
        long: gaps.filter((gap) => gap > 100).length,
        frames: gaps.length,
      };
    });
    console.log(
      `engine-line frame pacing: median ${pacing.median.toFixed(1)} ms over ${pacing.frames} frames, ${pacing.long} over 100 ms`,
    );
    // On the main thread the median would sit at the recognition cost, which is measured
    // in hundreds of milliseconds, not near the display's own frame time.
    expect(pacing.median).toBeLessThan(40);

    expect(failures).toEqual([]);
    await context.close();
  }, 120_000);

  it("puts content on the artwork in a portrait container, not beside it", async () => {
    if (!browser) throw new Error("no browser");
    // A phone held upright. The other test uses a stage the same shape as the feed, which
    // is the one container shape where getting the cover fit wrong is invisible.
    const context = await browser.newContext({
      viewport: { width: 400, height: 700 },
    });
    const page = await context.newPage();
    await page.addInitScript(installCanvasCamera, {
      encoded: frame64,
      width: FRAME.width,
      height: FRAME.height,
    });
    await page.goto(`${origin}/page.html?w=360&h=640`);
    await page.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-state") === "tracking",
      undefined,
      { timeout: 60_000 },
    );

    const box = await page.locator('[data-taggant-target="front"]').boundingBox();
    if (!box) throw new Error("expected the overlay to have a box");

    // Where object-fit: cover actually puts the artwork in this container, computed the
    // way the browser does: one scale for both axes, overflow split evenly.
    const scale = Math.max(360 / FRAME.width, 640 / FRAME.height);
    const offsetX = (360 - FRAME.width * scale) / 2;
    const offsetY = (640 - FRAME.height * scale) / 2;
    const expected = {
      x: PLACED.x * scale + offsetX,
      y: PLACED.y * scale + offsetY,
      width: ART.width * scale,
    };

    expect(Math.abs(box.x - expected.x)).toBeLessThan(40);
    expect(Math.abs(box.y - expected.y)).toBeLessThan(40);
    // Width as well as position: getting the scaling wrong showed up as content at 42% of
    // the artwork's width, which a position check on its own would have let through.
    expect(box.width / expected.width).toBeGreaterThan(0.85);
    expect(box.width / expected.width).toBeLessThan(1.15);
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
    // Among them rather than first: a camera that will not open now reports why it would
    // not, and that arrives before this does.
    expect((result.problems ?? []).join(" ")).toMatch(/refused to follow a fallback/i);
    await context.close();
  }, 60_000);

  it("says when a compiled target is not claimed by any target in the manifest", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(installCanvasCamera, {
      encoded: frame64,
      width: FRAME.width,
      height: FRAME.height,
    });
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

  it("carries on when the worker dies, instead of stopping or pretending it is fine", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(installCanvasCamera, {
      encoded: frame64,
      width: FRAME.width,
      height: FRAME.height,
    });
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
      undefined,
      { timeout: 60_000 },
    );

    const outcome = await page.evaluate(async () => {
      for (const worker of (window as unknown as { taggantWorkers: Worker[] }).taggantWorkers)
        worker.terminate();
      await new Promise((resolve) => setTimeout(resolve, 9000));
      return {
        state: document.querySelector("#stage")?.getAttribute("data-state"),
        hidden: (document.querySelector("[data-taggant-target]") as HTMLElement | null)?.hidden,
        threaded: window.taggantExperience?.threaded,
      };
    });

    // Recognition comes back to this thread and keeps going, which is worth more to a
    // viewer than a correct error message. Two failures are guarded here: sitting on
    // "tracking" with content frozen where the artwork used to be, which is what happened
    // before there was a timeout, and going on reporting a worker that is gone.
    expect(outcome.state).toBe("tracking");
    expect(outcome.hidden).toBe(false);
    expect(outcome.threaded).toBe(false);
    await context.close();
  }, 120_000);

  /**
   * A camera can be handed over and never become playable. A virtual device with nothing
   * behind it does this, and so does an engine on a runner: WebKit on Linux produced a live
   * video track with a resolution and no picture, which is how this was found.
   *
   * `video.play()` then neither resolves nor rejects. That is worse than either, because
   * nothing above it can see it: the mount never settles, the container never reaches an
   * error state, the entry page's own catch never runs, and the fallback the manifest
   * exists to provide is never followed. The viewer reads "asking for the camera" for as
   * long as they are willing to wait. Only the wait for a picture was bounded, one line
   * below the wait for playback that was not.
   */
  it("gives up on a camera that opens and never plays, rather than asking for ever", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    // A stream with no track in it: accepted by `srcObject`, never playable. No device is
    // reachable from here, and none is asked for.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => new MediaStream() },
      });
    });
    await page.goto(`${origin}/page.html?ready=1200`);
    await page.waitForFunction(
      () => {
        const state = document.querySelector("#stage")?.getAttribute("data-state");
        return state === "error" || state === "denied";
      },
      undefined,
      { timeout: 30_000 },
    );
    expect(await page.locator("#stage").getAttribute("data-state")).toBe("error");
    // Which of the two waits gave up, not merely that one did. Both end in the same state,
    // so a fix that bounded only the wait for a picture would pass this test on the state
    // alone while leaving playback unbounded, which is the defect it exists for.
    const said = await page.evaluate(() => window.taggantProblems ?? []);
    expect(said.join(" "), "the runtime did not say which wait it gave up on").toMatch(
      /would not start playing/i,
    );
    await context.close();
  }, 60_000);

  it("reports a refused camera as denied rather than stopping silently", async () => {
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
      undefined,
      { timeout: 30_000 },
    );
    expect(await page.locator("#stage").getAttribute("data-state")).toBe("denied");
    await context.close();
  }, 60_000);

  it("plays a video that was set not to play on its own at the viewer's first click, and takes it away paused on stop", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const page = await openWithClip(context);
    await mountManualVideo(page);

    const beforeClick = await page.evaluate(() => {
      const media = document.querySelector('[data-taggant-target="front"] video') as HTMLVideoElement | null;
      return {
        controls: media?.controls ?? false,
        autoplay: media?.autoplay ?? true,
        muted: media?.muted ?? true,
        paused: media?.paused ?? false,
        pointerEvents: media ? getComputedStyle(media).pointerEvents : "none",
      };
    });
    expect(beforeClick).toEqual({
      controls: true,
      autoplay: false,
      muted: false,
      paused: true,
      pointerEvents: "auto",
    });

    // A real pointer click on the placed video, which the stage's pointer-events: none
    // would block unless the video itself opted back in, played by the browser's own
    // controls. One click has to leave it playing, with sound, and never paused on the way.
    await page.locator('[data-taggant-target="front"] video').click();
    expect(await playback(page)).toEqual({ paused: false, muted: false, advanced: true, events: "play" });

    // Stopped, the content is taken away with its video paused, so nothing is left to click.
    await page.evaluate(() => (window as unknown as { experience: { stop(): void } }).experience.stop());
    expect(
      await page.evaluate(() => ({
        hidden: (document.querySelector('[data-taggant-target="front"]') as HTMLElement).hidden,
        paused: (document.querySelector('[data-taggant-target="front"] video') as HTMLVideoElement).paused,
      })),
    ).toEqual({ hidden: true, paused: true });
    await context.close();
  }, 90_000);

  it("takes the content away and pauses a playing video when the camera is taken away", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const page = await openWithClip(context);
    await mountManualVideo(page);
    await page.locator('[data-taggant-target="front"] video').click();
    expect(await playback(page)).toMatchObject({ paused: false, advanced: true });

    // What a browser does when another application claims the camera: the track ends.
    await page.evaluate(() => {
      const camera = document.querySelector("#scene > video") as HTMLVideoElement;
      for (const track of (camera.srcObject as MediaStream).getTracks())
        track.dispatchEvent(new Event("ended"));
    });
    await page.waitForFunction(
      () => document.querySelector("#scene")?.getAttribute("data-state") === "error",
      undefined,
      {
        timeout: 30_000,
      },
    );
    expect(
      await page.evaluate(() => ({
        hidden: (document.querySelector('[data-taggant-target="front"]') as HTMLElement).hidden,
        paused: (document.querySelector('[data-taggant-target="front"] video') as HTMLVideoElement).paused,
      })),
    ).toEqual({ hidden: true, paused: true });
    await context.close();
  }, 90_000);

  it("pauses a playing video while its target is lost and plays it again when the target is back", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const page = await openWithClip(context);
    // A second video, playing on its own and muted, in a corner of the same target.
    await mountManualVideo(page, [
      { type: "video", src: "clip.webm", placement: { scale: 0.25, offsetX: 0.35, offsetY: 0.35 } },
    ]);
    await page.locator('[data-taggant-target="front"] video:not([autoplay])').click();
    expect(await playback(page)).toMatchObject({ paused: false, advanced: true });
    const ownPaused = () =>
      page.evaluate(
        () =>
          (document.querySelector('[data-taggant-target="front"] video[autoplay]') as HTMLVideoElement)
            .paused,
      );
    expect(await ownPaused()).toBe(false);
    // Chromium pauses a muted video that started on its own whenever it is hidden, and
    // starts it again when it is shown, whatever the page does. Unmuted, which the viewer's
    // click allows, the second video is left to the runtime.
    await page.evaluate(() => {
      (document.querySelector('[data-taggant-target="front"] video[autoplay]') as HTMLVideoElement).muted =
        false;
    });
    expect(await ownPaused()).toBe(false);

    // The viewer turns away and back: the camera keeps running, and the artwork leaves the
    // frame and returns. The camera's own stream is kept to be put back.
    const away = () =>
      page.evaluate(() => {
        const camera = document.querySelector("#scene > video") as HTMLVideoElement;
        const kept = window as unknown as { cameraStream?: MediaProvider | null };
        kept.cameraStream ??= camera.srcObject;
        const blank = document.createElement("canvas");
        blank.width = 640;
        blank.height = 480;
        const paint = blank.getContext("2d");
        const again = () => {
          if (!paint || camera.srcObject !== stream) return;
          paint.fillStyle = "#808080";
          paint.fillRect(0, 0, blank.width, blank.height);
          requestAnimationFrame(again);
        };
        const stream = blank.captureStream(30);
        camera.srcObject = stream;
        again();
        void camera.play();
      });
    const back = () =>
      page.evaluate(() => {
        const camera = document.querySelector("#scene > video") as HTMLVideoElement;
        camera.srcObject = (window as unknown as { cameraStream: MediaProvider | null }).cameraStream;
        void camera.play();
      });
    const shown = (hidden: boolean) =>
      page.waitForFunction(
        (expected) =>
          (document.querySelector('[data-taggant-target="front"]') as HTMLElement | null)?.hidden ===
          expected,
        hidden,
        { timeout: 60_000 },
      );
    // Read a second after the change, for the same reason `playback` waits.
    const now = () =>
      page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          state: document.querySelector("#scene")?.getAttribute("data-state"),
          paused: (document.querySelector('[data-taggant-target="front"] video') as HTMLVideoElement).paused,
          events: (window as unknown as { mediaEvents: string[] }).mediaEvents.join(","),
        };
      });

    // Searching, not an error: the target was lost from a running camera.
    await away();
    await shown(true);
    expect(await now()).toEqual({ state: "searching", paused: true, events: "play,pause" });
    expect(await ownPaused()).toBe(true);

    await back();
    await shown(false);
    expect(await now()).toEqual({ state: "tracking", paused: false, events: "play,pause,play" });
    expect(await ownPaused()).toBe(false);

    // Paused by the viewer, it stays paused across the next loss and return.
    await page.locator('[data-taggant-target="front"] video:not([autoplay])').click();
    expect(await now()).toMatchObject({ paused: true, events: "play,pause,play,pause" });
    await away();
    await shown(true);
    await back();
    await shown(false);
    expect(await now()).toEqual({ state: "tracking", paused: true, events: "play,pause,play,pause" });
    await context.close();
  }, 180_000);

  it("reports content types that are in the format and not rendered by this build yet", async () => {
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(installCanvasCamera, {
      encoded: frame64,
      width: FRAME.width,
      height: FRAME.height,
    });
    await page.goto(`${origin}/bare.html`);
    await page.waitForFunction(() => window.taggantReady === true);

    const outcome = await page.evaluate(async () => {
      const target = await (await fetch("/target.json")).json();
      const mounted = await window.mountExperience?.({
        manifest: {
          schemaVersion: "1.0.0",
          id: "future-types",
          targets: [
            {
              id: "front",
              source: "artwork.png",
              physicalWidthMm: 148,
              content: [
                { type: "model", src: "pack.glb" },
                { type: "audio", src: "note.mp3" },
              ],
            },
          ],
        },
        targets: [window.fromTargetFile?.(target)],
        container: document.getElementById("scene"),
        options: { onProblem: (message: string) => window.taggantProblems?.push(message) },
      });
      return {
        unsupported: (mounted as unknown as { unsupported?: string[] })?.unsupported ?? [],
        problems: window.taggantProblems ?? [],
      };
    });

    expect(outcome.unsupported).toEqual(["model", "audio"]);
    expect(outcome.problems.some((line) => line.includes("model content"))).toBe(true);
    expect(outcome.problems.some((line) => line.includes("audio content"))).toBe(true);
    await context.close();
  }, 60_000);
});

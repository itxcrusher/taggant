import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CameraDiagnostics, installCanvasCamera } from "./camera-stub.js";
import { artwork, inView } from "./feed.js";
import { requiredEngines } from "./required.js";

/**
 * The compiler runs in Node and the runtime runs in a browser, and the whole system rests
 * on both producing the same descriptors from the same artwork. That is a claim about two
 * engines, so it is checked in every engine rather than argued from the source being shared.
 *
 * It did not hold when it was first checked. Measured on the same bytes, `Math.atan2`
 * differed by one unit in the last place between Node and Chromium, which rotated the
 * sampling pattern fractionally, moved samples across pixel boundaries, and changed 28 of
 * the 379 descriptors that fixture produced at the time by up to 12 bits. Recognition
 * survived it, because 12 bits is well inside the distance a match is accepted at, but the
 * closest distinct features on real artwork sit 7 bits apart, so a shift like that is
 * enough to hand a match to the wrong feature. The angle quantisation was added for it.
 *
 * Both sides load the same built file. Comparing Node against the source while the browser
 * gets the build makes an unrebuilt package look exactly like the bug above: a one unit
 * difference in an angle, reported against the engine. Two variables cannot be told apart,
 * so there is one.
 *
 * Every engine that can be launched is compared. Which engines a run is allowed to skip is
 * a property of the machine, so it is stated by the machine: set `TAGGANT_REQUIRE_ENGINES`
 * to the comma separated list a run must compare and the file fails if any of them did not
 * start. CI sets all three. A contributor with one browser installed still gets a useful
 * run, and is told on stderr which engines it did not cover.
 */

const here = dirname(fileURLToPath(import.meta.url));
const VISION = join(here, "../../../vision/dist/index.js");
const RUNTIME_DIST = join(here, "../../dist");

/**
 * The build, loaded the way the page loads it. `@taggant/vision` is aliased to source
 * across this workspace, which is right everywhere except here.
 */
const { buildTrackingFeatures, toTargetFile } = (await import(pathToFileURL(VISION).href).catch((error) => {
  throw new Error(
    `the vision build at ${VISION} could not be loaded, and this test compares it against itself in a browser, so build before running it: ${String(error)}`,
  );
})) as typeof import("@taggant/vision");

const ART = { width: 320, height: 240 };
const CAMERA = { width: 640, height: 480 };
/** Where the artwork sits in the frame, so a pose can be checked against an answer. */
const PLACED = { x: 80, y: 60 };

const ARTWORK = artwork(ART.width, ART.height);
/** Bytes, served as bytes. A frame is 307,200 of them and JSON is the wrong wire for that. */
const FRAME_BYTES = inView(ARTWORK, CAMERA.width, CAMERA.height, PLACED.x, PLACED.y).data;
/** The same frame for the canvas camera, which takes it as base64 through an init script. */
const FRAME_BASE64 = Buffer.from(FRAME_BYTES).toString("base64");
/** The compiled form, so the runtime reads it the way a published bundle does. */
const TARGET_FILE = toTargetFile({
  id: "front",
  width: ART.width,
  height: ART.height,
  features: buildTrackingFeatures(ARTWORK),
});

/**
 * A page with a sized container, the runtime, and nothing mounted, so a test can mount its
 * own manifest against a camera of its own.
 */
const CAMERA_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>camera</title></head>
<body><div id="scene" style="width:640px;height:480px"></div>
<script type="module">
  import * as runtime from "/index.js";
  window.runtime = runtime;
  window.taggantProblems = [];
  window.ready = true;
</script></body></html>`;

/** One red square, so there is real content to place without shipping a binary. */
const OVERLAY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#e2402a"/></svg>';

const CAMERA_MANIFEST = {
  schemaVersion: "1.0.0",
  id: "engines",
  targets: [
    {
      id: "front",
      source: "artwork.png",
      physicalWidthMm: 148,
      content: [{ type: "image", src: "/overlay.svg" }],
    },
  ],
};

/**
 * Chromium has both halves of the browser API a canvas camera needs on every platform, so
 * it is the one engine required to take the full path below. Without this the camera check
 * could quietly become nothing at all on a platform where the others lack them, which is
 * the shape of failure this file has already had twice.
 */
const MUST_TAKE_THE_CAMERA_PATH = "chromium";

/** Every engine Playwright can start here. A machine without one skips it, visibly. */
const ENGINES: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

/** Empty unless a machine says otherwise. CI says all three. */
const REQUIRED = requiredEngines();

/**
 * Launched here rather than in `beforeAll`, because the cases below are generated from
 * this list and a `describe` body runs before any hook. Filled in a hook, it was empty at
 * collection time, so the file generated no comparisons at all and reported itself green
 * having compared Node against nothing. Vitest registers `it.each([])` as no cases without
 * complaining, which is why the guard case below is load-bearing rather than decorative.
 *
 * The cost is that the engines start even on a run whose tests are all filtered out by
 * name. That is a few seconds on a filtered run, against a silent single engine pass.
 */
const started: [string, Browser][] = [];
for (const [name, type] of ENGINES) {
  try {
    started.push([name, await type.launch()]);
  } catch (error) {
    // Not installed, or missing a host library. Said out loud rather than silently
    // narrowing what this file claims to have checked, and at enough length to name the
    // executable it went looking for.
    console.warn(
      `engines: ${name} could not be launched, so it was not compared: ${String(error).slice(0, 400)}`,
    );
  }
}

let close: (() => Promise<void>) | undefined;
let origin = "";

beforeAll(async () => {
  const files = new Map<string, { body: Buffer; type: string }>([
    ["/vision.js", { body: await readFile(VISION), type: "text/javascript" }],
    [
      "/page.html",
      {
        body: Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>engines</title><script type="module">' +
            'import * as vision from "/vision.js"; window.vision = vision; window.ready = true;' +
            "</script>",
        ),
        type: "text/html",
      },
    ],
    [
      // The runtime's own module, so the worker is found the way the runtime finds it.
      // A test that restates `new URL("./worker.js", import.meta.url)` in its own file
      // measures its own copy: the runtime could switch to a classic worker, or resolve
      // against the document rather than its module, and that test would stay green.
      "/worker-page.html",
      {
        body: Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>worker</title><div id="scene"></div>' +
            '<script type="module">import * as runtime from "/index.js";' +
            "window.runtime = runtime; window.ready = true;</script>",
        ),
        type: "text/html",
      },
    ],
    [
      // The frame as bytes rather than as a JSON array of 307,200 numbers over the bridge.
      "/frame.gray",
      { body: Buffer.from(FRAME_BYTES), type: "application/octet-stream" },
    ],
    ["/target.json", { body: Buffer.from(JSON.stringify(TARGET_FILE)), type: "application/json" }],
    ["/camera-page.html", { body: Buffer.from(CAMERA_PAGE), type: "text/html" }],
    ["/manifest.json", { body: Buffer.from(JSON.stringify(CAMERA_MANIFEST)), type: "application/json" }],
    ["/overlay.svg", { body: Buffer.from(OVERLAY), type: "image/svg+xml" }],
  ]);
  // The whole runtime build, at the root, because the worker resolves the shared chunk
  // against its own URL. Serving only worker.js gives a worker that cannot import.
  const emitted = (await readdir(RUNTIME_DIST)).filter((name) => name.endsWith(".js"));
  if (!emitted.includes("worker.js")) {
    throw new Error(`the runtime build at ${RUNTIME_DIST} has no worker.js, so build before running this`);
  }
  for (const name of emitted) {
    files.set(`/${name}`, { body: await readFile(join(RUNTIME_DIST, name)), type: "text/javascript" });
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
  origin = `http://127.0.0.1:${address.port}`;
  close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}, 240_000);

afterAll(async () => {
  // Closed here rather than through `close`, because `close` is assigned at the end of a
  // hook that reads from disk first, so a missing build left three browsers with nothing
  // to close them. Playwright does clean up its own children on exit; this is about the
  // hook being skipped rather than about the process hanging.
  for (const [, instance] of started) await instance.close();
  await close?.();
});

describe("the same artwork in every engine", () => {
  it("compared the engines this machine says it must", () => {
    const names = started.map(([name]) => name);
    const unknown = REQUIRED.filter((name) => !ENGINES.some(([known]) => known === name));
    expect(unknown, "TAGGANT_REQUIRE_ENGINES names engines this file does not know about").toEqual([]);
    const missing = REQUIRED.filter((name) => !names.includes(name));
    expect(
      missing,
      `TAGGANT_REQUIRE_ENGINES asks for ${REQUIRED.join(", ")} and these did not launch, so this run compared fewer engines than it claims`,
    ).toEqual([]);
    // A machine with nothing installed would otherwise report this file as passing while
    // comparing the build against itself in Node.
    expect(started.length, "no browser engine could be launched, so nothing was compared").toBeGreaterThan(0);
  });

  // The pair is passed through rather than the name, because looking the browser back up by
  // name would test one engine twice and skip another if two ever carried the same name.
  it.each(started)(
    "describes it identically in Node and in %s",
    async (engine, browser) => {
      const art = artwork(ART.width, ART.height);
      const inNode = buildTrackingFeatures(art).map((feature) => ({
        x: feature.x,
        y: feature.y,
        angle: feature.angle,
        strength: feature.strength,
        descriptor: [...feature.descriptor],
      }));

      const page = await browser.newPage();
      await page.goto(`${origin}/page.html`);
      await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);

      const inBrowser = await page.evaluate(
        ({ width, height, data }) => {
          const vision = (window as unknown as { vision: typeof import("@taggant/vision") }).vision;
          const image = { width, height, data: Uint8Array.from(data) };
          return vision.buildTrackingFeatures(image).map((feature) => ({
            x: feature.x,
            y: feature.y,
            angle: feature.angle,
            strength: feature.strength,
            descriptor: [...feature.descriptor],
          }));
        },
        { width: art.width, height: art.height, data: [...art.data] },
      );

      // Without this, artwork that yields nothing passes: every counter below stays at zero
      // and the length check reads 0 against 0. The same shape of hole as a generated list
      // that generates no cases, one layer further in.
      expect(inNode.length, "the artwork produced no features, so nothing was compared").toBeGreaterThan(100);
      expect(inBrowser.length).toBe(inNode.length);

      let compared = 0;
      let differingDescriptors = 0;
      let differingPositions = 0;
      let differingAngles = 0;
      let differingStrengths = 0;
      let firstReport = "";
      for (let i = 0; i < inNode.length; i++) {
        const a = inNode[i];
        const b = inBrowser[i];
        if (!a || !b) continue;
        compared++;
        if (a.x !== b.x || a.y !== b.y) differingPositions++;
        if (a.angle !== b.angle) differingAngles++;
        if (a.strength !== b.strength) differingStrengths++;
        if (a.descriptor.join(",") !== b.descriptor.join(",")) {
          differingDescriptors++;
          if (!firstReport) {
            firstReport = `i=${i} angle ${a.angle} vs ${b.angle} | strength ${a.strength} vs ${b.strength} | pos ${a.x},${a.y} vs ${b.x},${b.y}`;
          }
        }
      }
      // Always printed, because a passing run is the only place the agreement between the
      // build and each engine is actually measured, and a number nobody can read is not
      // evidence of anything.
      console.log(
        `${engine}: ${inNode.length} features, differing positions ${differingPositions}, angles ${differingAngles}, strengths ${differingStrengths}, descriptors ${differingDescriptors}`,
      );
      if (firstReport) console.log(firstReport);

      // The counters above only mean something if the loop reached every feature. A skipped
      // element would leave all four at zero and read as agreement.
      expect(compared, "some features were skipped rather than compared").toBe(inNode.length);

      // The stored angle is allowed to differ: it is the raw measurement, and the rotation
      // actually used is rounded to a grid far coarser than the difference. Chromium and
      // WebKit each differ on dozens of the angles and agree on every descriptor, which is
      // the quantisation working; Firefox has agreed on every angle outright. Those counts
      // are printed rather than asserted, because they belong to the engine builds.
      expect(differingStrengths).toBe(0);
      expect(differingPositions).toBe(0);
      expect(differingDescriptors).toBe(0);
      await page.close();
    },
    120_000,
  );

  /**
   * Recognition happens in a module worker, and where a browser will not give one the
   * runtime answers on the page's thread instead. That fallback is deliberate and it is
   * quiet: the page keeps working and starts freezing for the length of a recognition
   * call, which is the failure a viewer on a phone would meet and nobody would report.
   * Safari was the reason to doubt it, module workers having arrived there late.
   *
   * Driven through the runtime's own `createRecogniser`, which is the only way to check
   * the things that actually go wrong here: how it resolves the worker URL, how it
   * serialises a target across the wire, how it correlates a reply with the frame it
   * answers, and whether it fell back. Every one of those was invisible to the version of
   * this test that started a worker by a path of its own and read the first message back.
   *
   * The pose is checked against the answer, because the frame was built by placing the
   * artwork at a known point. A worker that ignored the frame entirely and returned nine
   * numbers passed the previous version of this test, in all three engines, and printed
   * the same inlier count that was quoted as evidence it worked.
   */
  it.each(started)(
    "recognises through the runtime's own worker in %s",
    async (engine, browser) => {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      try {
        await page.goto(`${origin}/worker-page.html`);
        await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);

        const answer = await page.evaluate(
          async ({ frame, art }) => {
            const runtime = (window as unknown as { runtime: typeof import("@taggant/runtime") }).runtime;
            const stored = await (await fetch("/target.json")).json();
            const target = runtime.fromTargetFile(stored);
            const bytes = new Uint8Array(await (await fetch("/frame.gray")).arrayBuffer());

            const recogniser = runtime.createRecogniser([target]);
            // The frame is the camera's size; the target's corners below are the artwork's.
            // Describing one with the other's numbers makes recognition fail, which it did.
            const poses = await recogniser.submit({ width: frame.width, height: frame.height, data: bytes });
            // Read after the frame has been answered, not at construction. A worker that
            // cannot be fetched constructs without complaint and reports itself threaded
            // until the error arrives, so asking at the start is asking at the one moment
            // the answer cannot be false.
            const threaded = recogniser.threaded;
            recogniser.stop();

            const pose = poses?.[0];
            const homography = pose?.homography ?? null;
            const map = (x: number, y: number): [number, number] => {
              if (!homography || homography.length !== 9) return [Number.NaN, Number.NaN];
              const at = (i: number) => homography[i] ?? 0;
              const w = at(6) * x + at(7) * y + at(8);
              return [(at(0) * x + at(1) * y + at(2)) / w, (at(3) * x + at(4) * y + at(5)) / w];
            };
            return {
              count: poses?.length ?? -1,
              id: pose?.id ?? "",
              inliers: pose?.inliers ?? 0,
              threaded,
              bytes: bytes.length,
              topLeft: map(0, 0),
              bottomRight: map(art.width, art.height),
            };
          },
          { frame: CAMERA, art: ART },
        );

        const round = ([x, y]: [number, number]) => `${x.toFixed(1)},${y.toFixed(1)}`;
        console.log(
          `${engine}: worker ${answer.threaded ? "in a thread" : "ON THE PAGE THREAD"}, ${answer.inliers} inliers, artwork corners at ${round(answer.topLeft)} and ${round(answer.bottomRight)}`,
        );

        expect(pageErrors).toEqual([]);
        expect(answer.bytes).toBe(CAMERA.width * CAMERA.height);
        expect(answer.count, "the runtime returned no pose for the only target it was given").toBe(1);
        expect(answer.id).toBe("front");
        // The fallback is silent by design, so it has to be asked about rather than waited
        // for. This is the assertion that the worker did the work.
        expect(answer.threaded, "recognition fell back to the page's thread in this engine").toBe(true);

        // Against the answer. The artwork was placed at a known point at its own scale, so
        // its corners have to come back there. Nine numbers that are not a pose land
        // somewhere else entirely, which is what this catches.
        expect(answer.topLeft[0]).toBeCloseTo(PLACED.x, 0);
        expect(answer.topLeft[1]).toBeCloseTo(PLACED.y, 0);
        expect(answer.bottomRight[0]).toBeCloseTo(PLACED.x + ART.width, 0);
        expect(answer.bottomRight[1]).toBeCloseTo(PLACED.y + ART.height, 0);
        expect(answer.inliers).toBeGreaterThanOrEqual(10);
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  /**
   * The camera, in every engine that has one, without a camera.
   *
   * This path used to be checked in Chromium alone, because Chromium is the only engine
   * that can be handed a video file to play as a camera. The first attempt to widen it used
   * Firefox's fake device preference, and that was a mistake worth recording: the only
   * thing between the test and a contributor's real webcam was a preference that Firefox
   * accepts silently whether or not it exists, alongside a second preference removing the
   * permission prompt. It did open the repository owner's webcam once during development.
   *
   * So no engine is asked for a camera here. `navigator.mediaDevices` is replaced before any
   * page script runs, with a `getUserMedia` that returns a canvas the artwork has been drawn
   * into. Hardware is not reachable in any preference state, and the frame contains the
   * artwork, so the whole path runs rather than only its beginning: a stream is obtained,
   * the runtime starts its own worker, the loop recognises, and the content is placed where
   * the artwork actually is.
   */
  it.each(started)(
    "puts content on the artwork from a camera in %s",
    async (engine, browser) => {
      const context = await browser.newContext({ viewport: CAMERA });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      try {
        // Before any page script. There is no path from here to a device.
        await page.addInitScript(installCanvasCamera, FRAME_BASE64);

        await page.goto(`${origin}/camera-page.html`);
        await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);

        const mounted = await page.evaluate(async () => {
          const runtime = (window as unknown as { runtime: typeof import("@taggant/runtime") }).runtime;
          const stored = await (await fetch("/target.json")).json();
          const manifest = await (await fetch("/manifest.json")).json();
          try {
            const experience = await runtime.mountExperience({
              manifest,
              targets: [runtime.fromTargetFile(stored)],
              container: document.getElementById("scene") as HTMLElement,
              options: {
                onProblem: (message: string) =>
                  (window as unknown as { taggantProblems: string[] }).taggantProblems.push(message),
              },
            });
            (window as unknown as { experience: unknown }).experience = experience;
            return { mounted: true, state: experience.state, failure: "" };
          } catch (error) {
            return { mounted: false, state: "", failure: String(error) };
          }
        });

        // Whichever the runtime settles on. Which of the two is correct is not this test's
        // to assume: it is decided below by what the stub proved about the engine.
        await page
          .waitForFunction(
            () => {
              const state = document.querySelector("#scene")?.getAttribute("data-state");
              return state === "tracking" || state === "error" || state === "denied";
            },
            undefined,
            { timeout: 90_000 },
          )
          .catch(async (error) => {
            const stuck = await page.evaluate(() => ({
              state: document.querySelector("#scene")?.getAttribute("data-state") ?? "none",
              camera: (window as unknown as { cameraDiagnostics?: CameraDiagnostics }).cameraDiagnostics,
            }));
            throw new Error(
              `${engine} never settled: stopped at "${stuck.state}", camera ${JSON.stringify(stuck.camera)}, page errors ${JSON.stringify(pageErrors)} (${String(error).slice(0, 120)})`,
            );
          });

        const camera = await page.evaluate(
          () => (window as unknown as { cameraDiagnostics?: CameraDiagnostics }).cameraDiagnostics,
        );
        // What the page settled on, which is the only honest way to know whether this engine
        // can use a canvas as a camera: both APIs are present in WebKit on Linux and the
        // stream may never become a picture there, and a trial with a video element of its
        // own turned out to be stricter than the runtime's and to report engines as
        // incapable where the runtime might not have been.
        const settledState = await page.evaluate(
          () => document.querySelector("#scene")?.getAttribute("data-state") ?? "",
        );
        const usable = settledState === "tracking";
        if (engine === MUST_TAKE_THE_CAMERA_PATH) {
          expect(usable, `${engine} could not be given a canvas camera: ${JSON.stringify(camera)}`).toBe(
            true,
          );
        }

        if (!usable) {
          // An engine that cannot be given a camera has to say so rather than leave a page
          // that promised one sitting on Starting. Mounting still resolves, which is
          // deliberate: the runtime reports the failure as state so a page can show it and
          // follow a fallback, instead of throwing at whoever mounted it.
          const reported = await page.evaluate(() => ({
            state: document.querySelector("#scene")?.getAttribute("data-state") ?? "",
            threaded: (window as unknown as { experience?: { threaded: boolean } }).experience?.threaded,
          }));
          console.log(
            `${engine}: a canvas was not a camera here, runtime reported ${reported.state} after ${camera?.called ?? 0} request(s), stream ${camera?.tracks || "none"} ${camera?.settings || ""}`,
          );
          expect(mounted.mounted, `mounting threw instead of reporting: ${mounted.failure}`).toBe(true);
          expect(reported.state, "the container has to carry the state so a page can show it").toBe("error");
          // And it must not claim a thread it never started.
          expect(reported.threaded).toBe(false);
          expect(pageErrors).toEqual([]);
          return;
        }

        const overlay = page.locator('[data-taggant-target="front"]');
        expect(await overlay.count()).toBe(1);
        const box = await overlay.boundingBox();
        if (!box) throw new Error("expected the overlay to have a box");

        // Read now rather than at mount. A worker that cannot be fetched constructs without
        // complaint and reports itself threaded until the error arrives, so the value at
        // mount is the one moment it cannot be false.
        const settled = await page.evaluate(() => ({
          threaded: (window as unknown as { experience: { threaded: boolean } }).experience.threaded,
          problems: (window as unknown as { taggantProblems: string[] }).taggantProblems,
        }));

        console.log(
          `${engine}: tracking, content at ${box.x.toFixed(0)},${box.y.toFixed(0)} against artwork at ${PLACED.x},${PLACED.y}, worker ${settled.threaded ? "in a thread" : "ON THE PAGE THREAD"}`,
        );
        expect(Math.abs(box.x - PLACED.x)).toBeLessThan(40);
        expect(Math.abs(box.y - PLACED.y)).toBeLessThan(40);
        // And the frames came from the canvas rather than from anywhere else. Read on the
        // success path, because a diagnostic only read when a test fails is not evidence.
        expect(camera?.called ?? 0, "the stub was never asked for a camera").toBeGreaterThan(0);
        expect(settled.threaded, "recognition fell back to the page's thread in this engine").toBe(true);
        expect(settled.problems).toEqual([]);
        expect(pageErrors).toEqual([]);
      } finally {
        await context.close();
      }
    },
    120_000,
  );
});

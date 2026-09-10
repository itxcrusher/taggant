import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const { buildTrackingFeatures } = (await import(pathToFileURL(VISION).href).catch((error) => {
  throw new Error(
    `the vision build at ${VISION} could not be loaded, and this test compares it against itself in a browser, so build before running it: ${String(error)}`,
  );
})) as typeof import("@taggant/vision");

const ART = { width: 320, height: 240 };

/**
 * How the runtime finds its worker, in one line, served from beside `worker.js` so that
 * `import.meta.url` resolves from the same place the runtime's own module does. What has to
 * work in a browser is not a path a test knows, it is this resolution.
 */
const RESOLVE = `export function startWorkerTheWayTheRuntimeDoes() {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}
window.startWorkerTheWayTheRuntimeDoes = startWorkerTheWayTheRuntimeDoes;
`;

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
      "/worker-page.html",
      {
        body: Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>worker</title>' +
            '<script type="module">import "/resolve.js"; window.ready = true;</script>',
        ),
        type: "text/html",
      },
    ],
    [
      // Served beside worker.js, so `new URL("./worker.js", import.meta.url)` resolves from
      // here exactly as it does from the runtime's own module. That one line is how the
      // runtime finds its worker, and it is the part that has to work in a browser rather
      // than in a bundler.
      "/resolve.js",
      { body: Buffer.from(RESOLVE), type: "text/javascript" },
    ],
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
   * So the worker is driven directly, in every engine, with a real target and a frame the
   * artwork is actually in, and it has to answer with a pose. Posting an empty target list
   * gets an answer out of it too, which proves only that it loaded.
   */
  it.each(started)(
    "recognises through a module worker, resolved the way the runtime resolves it, in %s",
    async (_engine, browser) => {
      const art = artwork(ART.width, ART.height);
      const frame = inView(art, 640, 480, 80, 60);
      const target = {
        id: "front",
        width: art.width,
        height: art.height,
        features: buildTrackingFeatures(art).map((feature) => ({
          x: feature.x,
          y: feature.y,
          scale: feature.scale,
          angle: feature.angle,
          strength: feature.strength,
          descriptor: [...feature.descriptor],
        })),
      };

      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      await page.goto(`${origin}/worker-page.html`);
      await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);

      const answer = await page.evaluate(
        async ({ serialised, width, height, data }) =>
          await new Promise<{ ok: boolean; detail: string; inliers: number; matrix: number }>((resolve) => {
            let worker: Worker;
            try {
              // Resolved against a module's own URL, which is how the runtime finds it, not
              // by a path this test happens to know.
              worker = (
                window as unknown as { startWorkerTheWayTheRuntimeDoes: () => Worker }
              ).startWorkerTheWayTheRuntimeDoes();
            } catch (error) {
              resolve({
                ok: false,
                detail: `the worker would not start: ${String(error)}`,
                inliers: 0,
                matrix: 0,
              });
              return;
            }
            const giveUp = setTimeout(() => {
              worker.terminate();
              resolve({
                ok: false,
                detail: "the worker did not answer within ten seconds",
                inliers: 0,
                matrix: 0,
              });
            }, 10_000);
            worker.onerror = (event) => {
              clearTimeout(giveUp);
              resolve({
                ok: false,
                detail: `the worker failed: ${String((event as ErrorEvent).message ?? event.type)}`,
                inliers: 0,
                matrix: 0,
              });
            };
            worker.onmessage = (event: MessageEvent<{ type: string; poses?: unknown[] }>) => {
              clearTimeout(giveUp);
              worker.terminate();
              const pose = (event.data.poses ?? [])[0] as
                | { id: string; homography: number[] | null; inliers: number }
                | undefined;
              resolve({
                ok: event.data.type === "result" && pose?.id === "front",
                detail: JSON.stringify(event.data).slice(0, 160),
                inliers: pose?.inliers ?? 0,
                matrix: pose?.homography?.length ?? 0,
              });
            };
            worker.postMessage({ type: "targets", targets: [serialised] });
            const bytes = Uint8Array.from(data);
            worker.postMessage({ type: "frame", id: 7, width, height, data: bytes.buffer }, [bytes.buffer]);
          }),
        { serialised: target, width: frame.width, height: frame.height, data: [...frame.data] },
      );

      // Printed on every run, because a pass is the only place this is measured.
      console.log(`${_engine}: worker answered with ${answer.inliers} inliers`);
      expect(pageErrors).toEqual([]);
      expect(answer.ok, answer.detail).toBe(true);
      // A pose, not merely a reply. The ten inlier floor is the runtime's own, so anything
      // that answers at all answers with at least that many or with nothing.
      expect(answer.matrix, `no homography came back: ${answer.detail}`).toBe(9);
      expect(answer.inliers).toBeGreaterThanOrEqual(10);
      await page.close();
    },
    120_000,
  );
});

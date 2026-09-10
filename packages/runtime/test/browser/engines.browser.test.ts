import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artwork } from "./feed.js";

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

/** Every engine Playwright can start here. A machine without one skips it, visibly. */
const ENGINES: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

/** Empty unless a machine says otherwise. CI says all three. */
const REQUIRED = (process.env.TAGGANT_REQUIRE_ENGINES ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

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
});

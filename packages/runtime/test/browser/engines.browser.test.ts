import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrackingFeatures } from "@taggant/vision";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artwork } from "./feed.js";

/**
 * The compiler runs in Node and the runtime runs in a browser, and the whole system rests
 * on both producing the same descriptors from the same artwork. That is a claim about two
 * engines, so it is checked in two engines rather than argued from the source being shared.
 *
 * It did not hold. Measured on the same bytes, `Math.atan2` differed by one unit in the
 * last place between Node and Chromium, which rotated the sampling pattern fractionally,
 * moved samples across pixel boundaries, and changed 28 of 379 descriptors by up to 12
 * bits. Recognition survived it, because 12 bits is well inside the distance a match is
 * accepted at, but the closest distinct features on real artwork sit 7 bits apart, so a
 * shift like that is enough to hand a match to the wrong feature.
 *
 * Every engine that can be launched is checked, not only the one where the problem was
 * found. On the artwork below, Chromium and WebKit each still disagree with Node about 63
 * of 356 angles and produce identical descriptors anyway, which is the quantisation doing
 * exactly what it was added for; Firefox agrees with Node on every angle outright. Those
 * counts are printed on every run rather than asserted, because they are a property of the
 * engines rather than of this project, and a version bump moving them is not a defect.
 */

const here = dirname(fileURLToPath(import.meta.url));
const VISION = join(here, "../../../vision/dist/index.js");

const ART = { width: 320, height: 240 };

/** Every engine Playwright can start here. A machine without one skips it, visibly. */
const ENGINES: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

/**
 * Launched here rather than in `beforeAll`, because the cases below are generated from
 * this list and a `describe` body runs before any hook. Filled in a hook, it was empty at
 * collection time, so the file generated no comparisons at all and reported itself green
 * having compared Node against nothing.
 */
const started: [string, Browser][] = [];
for (const [name, type] of ENGINES) {
  try {
    started.push([name, await type.launch()]);
  } catch (error) {
    // Not installed, or missing a host library. Said out loud rather than silently
    // narrowing what this file claims to have checked.
    console.warn(
      `engines: ${name} could not be launched, so it was not compared (${String(error).slice(0, 90)})`,
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
  // The browsers are closed here rather than in `close`, because `close` is assigned at the
  // end of a hook that can throw before reaching it (the vision build is read there), and a
  // browser left running holds the process open.
  for (const [, instance] of started) await instance.close();
  await close?.();
});

describe("the same artwork in every engine", () => {
  it("was compared against at least one browser", () => {
    // A machine with nothing installed would otherwise report this file as passing while
    // comparing Node against Node.
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

      let differingDescriptors = 0;
      let differingPositions = 0;
      let differingAngles = 0;
      let differingStrengths = 0;
      let firstReport = "";
      for (let i = 0; i < inNode.length; i++) {
        const a = inNode[i];
        const b = inBrowser[i];
        if (!a || !b) continue;
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
      // compiler and each engine is actually measured, and a number nobody can read is not
      // evidence of anything.
      console.log(
        `${engine}: ${inNode.length} features, differing positions ${differingPositions}, angles ${differingAngles}, strengths ${differingStrengths}, descriptors ${differingDescriptors}`,
      );
      if (firstReport) console.log(firstReport);

      // The stored angle is allowed to differ: it is the raw measurement, and the rotation
      // actually used is rounded to a grid far coarser than the difference. What must not
      // differ is anything a match is made from.
      expect(differingStrengths).toBe(0);
      expect(differingPositions).toBe(0);
      expect(differingDescriptors).toBe(0);
      await page.close();
    },
    120_000,
  );
});

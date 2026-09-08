import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrackingFeatures } from "@taggant/vision";
import { type Browser, chromium } from "playwright";
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
 */

const here = dirname(fileURLToPath(import.meta.url));
const VISION = join(here, "../../../vision/dist/index.js");

const ART = { width: 320, height: 240 };

let browser: Browser | undefined;
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
  browser = await chromium.launch();
  close = async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe("the same artwork in two engines", () => {
  it("describes it identically in Node and in a browser", async () => {
    if (!browser) throw new Error("no browser");
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
    if (differingDescriptors > 0 || differingPositions > 0) {
      // Printed only when it matters, and with enough to tell which stage drifted.
      console.log(
        `positions ${differingPositions}, angles ${differingAngles}, strengths ${differingStrengths}, descriptors ${differingDescriptors}`,
      );
      console.log(firstReport);
    }

    // The stored angle is allowed to differ: it is the raw measurement, and the rotation
    // actually used is rounded to a grid far coarser than the difference. What must not
    // differ is anything a match is made from.
    expect(differingStrengths).toBe(0);
    expect(differingPositions).toBe(0);
    expect(differingDescriptors).toBe(0);
    await page.close();
  }, 120_000);
});

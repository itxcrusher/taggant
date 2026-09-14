import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GrayscaleImage, locate, resample } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import { compileTarget } from "../src/compile.js";
import { loadGrayscale } from "../src/load.js";
import { FRAME_WIDTH_MM_AT_1M, RECOGNISED_PIXELS_ACROSS_FRAME } from "../src/report.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/postcard");

/**
 * The check the minimum print width never had: print at it, and look.
 *
 * Everything else about that number was verified against something that agreed with it. The
 * tests asserted the figures the README quoted, the README quoted the compiler, the project
 * page quoted the README, and the compiler was wrong, so all four were wrong together and
 * every check passed. Nothing in that loop ever put a mark of the stated size in front of the
 * recogniser, which is the only thing the number is a claim about.
 *
 * **What this can and cannot prove.** The width in millimetres is pixels divided by
 * `FRAME_WIDTH_MM_AT_1M`, and the simulation below multiplies by the same constant to work
 * out how big to draw the mark, so the two cancel and every case here passes for any value
 * of it. Measured: at an assumed 30 degree field the report prints 68 mm and this puts 321
 * px across the mark; at 120 degrees it prints 439 mm and this puts 320 px across. **So this
 * file tests the pixel half of the model and not the millimetre half.** The millimetre half
 * rests on one assumption about the camera's field of view, which no test can settle and
 * which `site/measure/` exists to replace with a measurement from a real device.
 *
 * What is simulated is the geometry and nothing else: a print of a given width, at a given
 * distance, occupies a known fraction of the camera's picture, and the runtime reduces that
 * picture to a fixed pixel width before it recognises anything. Lighting, focus, motion,
 * angle and paper are not here, and they only make it harder, so the headroom measured below
 * is the best case rather than the typical one.
 */
describe("the minimum print width, driven through the recogniser", () => {
  /** The artwork as it would arrive at the matcher, printed this wide and read from this far. */
  function asPhotographed(artwork: GrayscaleImage, printedMm: number, distanceMm: number): GrayscaleImage {
    const frameWidthMm = FRAME_WIDTH_MM_AT_1M * (distanceMm / 1000);
    const across = Math.round((printedMm / frameWidthMm) * RECOGNISED_PIXELS_ACROSS_FRAME);
    // Reduced the way distance reduces, through the same smoothing the runtime's own frames
    // go through. Nearest neighbour would keep detail a lens and a sensor do not deliver and
    // would make the floor look lower than it is.
    const mark = resample(artwork, across / artwork.width);

    const frameWidth = RECOGNISED_PIXELS_ACROSS_FRAME;
    const frameHeight = Math.round(frameWidth * 0.75);
    // Mid grey, so the mark sits on a surface rather than on black. A frame of one value
    // has no corners of its own, which is the neutral case: every feature the matcher finds
    // came from the print.
    const data = new Uint8Array(frameWidth * frameHeight).fill(150);
    const left = Math.round((frameWidth - mark.width) / 2);
    const top = Math.round((frameHeight - mark.height) / 2);
    for (let y = 0; y < mark.height; y++) {
      const intoY = top + y;
      if (intoY < 0 || intoY >= frameHeight) continue;
      for (let x = 0; x < mark.width; x++) {
        const intoX = left + x;
        if (intoX < 0 || intoX >= frameWidth) continue;
        data[intoY * frameWidth + intoX] = mark.data[y * mark.width + x] ?? 150;
      }
    }
    return { width: frameWidth, height: frameHeight, data };
  }

  const artworkFile = async () => readFile(join(EXAMPLE, "artwork.png"));

  it("finds the artwork printed at exactly the width the report asks for", async () => {
    const scanDistanceMm = 190;
    const compiled = await compileTarget(await artworkFile(), { id: "front", scanDistanceMm });
    const width = compiled.report.minimumWidthMm;
    expect(width, "the example artwork should pass, so there should be a width to check").not.toBeNull();

    const frame = asPhotographed(await loadGrayscale(await artworkFile()), width ?? 0, scanDistanceMm);
    const result = locate(frame, compiled);
    expect(
      result.found,
      `a print ${width} mm wide read from ${scanDistanceMm} mm was not found, so the width the compiler prints is one a press run would waste`,
    ).toBe(true);
  });

  it("sits just above the width where recognition actually stops, in both directions", async () => {
    // Two-sided on purpose, because one side alone proves almost nothing. That the mark is
    // found at the stated width would hold for a minimum of one metre; that it is missed at
    // half the stated width would hold for a minimum far larger than anyone needs to print.
    // The first version of this test probed at half, where the real floor turned out to be
    // at 0.85, so the model could have been 1.7 times too conservative with both assertions
    // passing and a printer told to print 70 per cent wider than necessary.
    //
    // So the floor is measured rather than guessed: walk down until it is lost, and require
    // the stated width to be within a factor the printer would not notice.
    const scanDistanceMm = 190;
    const compiled = await compileTarget(await artworkFile(), { id: "front", scanDistanceMm });
    const width = compiled.report.minimumWidthMm ?? 0;
    const artwork = await loadGrayscale(await artworkFile());

    let smallestFound = 1;
    for (const fraction of [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5]) {
      if (!locate(asPhotographed(artwork, width * fraction, scanDistanceMm), compiled).found) break;
      smallestFound = fraction;
    }

    expect(
      smallestFound,
      `recognition still worked at ${Math.round(smallestFound * 100)}% of the ${width} mm the report asks for, so the report is telling printers to print larger than they need`,
    ).toBeGreaterThan(0.7);
    expect(
      smallestFound,
      `recognition survived every size tried down to ${Math.round(smallestFound * 100)}%, so this found no floor at all and proves nothing about the width`,
    ).toBeLessThan(1);
  });

  it("is not found at the stated width when read from further than it was compiled for", async () => {
    // The width and the distance travel together, and this is the reason. A piece made to
    // the 190 mm answer and then read from arm's length fills less of the picture, puts
    // fewer pixels across itself, and is not found. Photographing at the distance it was
    // compiled for is the case above; this is the one that shows the pairing matters.
    const compiledFor = 190;
    const compiled = await compileTarget(await artworkFile(), { id: "front", scanDistanceMm: compiledFor });
    const width = compiled.report.minimumWidthMm ?? 0;
    const artwork = await loadGrayscale(await artworkFile());

    expect(locate(asPhotographed(artwork, width, compiledFor), compiled).found).toBe(true);
    expect(
      locate(asPhotographed(artwork, width, 400), compiled).found,
      `a print made to the ${compiledFor} mm answer was still found from 400 mm, so the distance does not change the answer and the report should not be asking for one`,
    ).toBe(false);
  });

  it("asks for proportionally more width the further away the print will be read", async () => {
    // Twice as far, twice as wide, because the mark has to fill the same fraction of a
    // picture that now covers twice as much of the world. If this ever stops holding, the
    // model has grown a term that is not in the geometry.
    const near = await compileTarget(await artworkFile(), { id: "front", scanDistanceMm: 200 });
    const far = await compileTarget(await artworkFile(), { id: "front", scanDistanceMm: 400 });
    const ratio = (far.report.minimumWidthMm ?? 0) / (near.report.minimumWidthMm ?? 1);
    expect(ratio).toBeGreaterThan(1.98);
    expect(ratio).toBeLessThan(2.02);
  });
});

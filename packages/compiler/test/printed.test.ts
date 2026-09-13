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
 * every check passed. Nothing in the loop ever put a mark of the stated size in front of the
 * recogniser, which is the only thing the number is a claim about.
 *
 * What is simulated here is the geometry and nothing else: a print of a given width, at a
 * given distance, occupies a known fraction of the camera's picture, and the runtime reduces
 * that picture to a fixed pixel width before it recognises anything. So a width in
 * millimetres becomes a count of pixels across the mark, and that count is what the matcher
 * is given. Lighting, focus, motion, angle and paper are not here; they only make it harder,
 * which is the safe direction for a floor to be wrong in.
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

  it("does not find it printed well below that width, so the width is a floor and not a guess", async () => {
    // Without this the test above passes for a minimum of one millimetre or of one metre.
    // A number is only a minimum if going under it costs you the match.
    const scanDistanceMm = 190;
    const compiled = await compileTarget(await artworkFile(), { id: "front", scanDistanceMm });
    const width = compiled.report.minimumWidthMm ?? 0;
    const artwork = await loadGrayscale(await artworkFile());

    const half = locate(asPhotographed(artwork, width * 0.5, scanDistanceMm), compiled);
    expect(
      half.found,
      `printed at half the stated minimum it was still found with ${half.inliers} inliers, so the stated minimum is well above the real floor and printers are being told to print larger than they need`,
    ).toBe(false);
  });

  it("holds at a distance it was not computed for, because the geometry is the whole claim", async () => {
    // The width and the distance travel together for a reason. Compile for arm's length,
    // print at the width that comes back, read it from arm's length: the fraction of the
    // picture the mark fills is the same, and so is the answer.
    const scanDistanceMm = 400;
    const compiled = await compileTarget(await artworkFile(), { id: "front", scanDistanceMm });
    const width = compiled.report.minimumWidthMm;
    expect(width).not.toBeNull();

    const frame = asPhotographed(await loadGrayscale(await artworkFile()), width ?? 0, scanDistanceMm);
    expect(
      locate(frame, compiled).found,
      `a print ${width} mm wide read from ${scanDistanceMm} mm was not found`,
    ).toBe(true);
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

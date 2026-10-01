import { type GrayscaleImage, type TargetFeature, locate, resample, sample } from "@taggant/vision";
import { RECOGNISED_PIXELS_ACROSS_FRAME } from "./report.js";

/**
 * Turns of the print the recogniser is shown, in degrees.
 *
 * The count of agreeing points moves by about a fifth as a print turns, and not in the same
 * direction for every design, so a check made in one pose passes artwork whose margin is gone
 * in another. Measured on generated artwork printed twice: 28 points upright, 19 at sixty
 * degrees, against a line of twenty that sat between them. A person holds a label, a bottle or
 * a card at whatever angle it comes to hand, so the worst of these is the honest figure.
 */
const TURNS = [0, 30, 60, 90] as const;

/**
 * Show the recogniser the artwork at a given width, the way a camera would hand it over.
 *
 * The report decides readiness by asking this, at the widths it is considering. What is
 * simulated is the geometry and nothing else: the artwork reduced to that many pixels across,
 * through the same smoothing the runtime's own frames go through, turned, and centred in a
 * frame the width the runtime recognises at, on mid grey so the mark sits on a surface and
 * every feature found came from the print. Lighting, focus, motion, angle and paper are not
 * here and only make it harder, which is why the report asks for twice the recogniser's floor
 * rather than for the floor.
 *
 * The unturned pose is the construction `test/printed.test.ts` uses, written twice on purpose:
 * that test is the independent check on this one, and a test that shared the code under test
 * would agree with it whatever it did.
 *
 * Returns the worst pose: found only when every turn was found, and the smallest number of
 * points that agreed.
 */
export function recognitionOf(
  image: GrayscaleImage,
  features: TargetFeature[],
): (pixelsAcross: number) => { found: boolean; inliers: number } {
  const target = { id: "readiness", width: image.width, height: image.height, features };
  return (pixelsAcross) => {
    const mark = resample(image, pixelsAcross / image.width);
    let found = true;
    let inliers = Number.POSITIVE_INFINITY;
    for (const degrees of TURNS) {
      const result = locate(photographed(mark, degrees), target);
      if (!result.found) {
        found = false;
        inliers = 0;
        break;
      }
      inliers = Math.min(inliers, result.inliers);
    }
    return { found, inliers: Number.isFinite(inliers) ? inliers : 0 };
  };
}

/** The mark turned about its centre and placed in the middle of a frame, on mid grey. */
function photographed(mark: GrayscaleImage, degrees: number): GrayscaleImage {
  const frameWidth = RECOGNISED_PIXELS_ACROSS_FRAME;
  const frameHeight = Math.round(frameWidth * 0.75);
  const data = new Uint8Array(frameWidth * frameHeight).fill(150);
  if (degrees === 0) {
    // Copied rather than sampled, so the upright pose is exactly the construction the
    // independent test makes and not a resampling of it.
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
  const turn = (degrees * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const cx = frameWidth / 2;
  const cy = frameHeight / 2;
  const mx = mark.width / 2;
  const my = mark.height / 2;
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      // From the frame back into the mark: undo the turn about the frame's centre.
      const u = cos * (x - cx) + sin * (y - cy) + mx;
      const v = -sin * (x - cx) + cos * (y - cy) + my;
      if (u < 0 || v < 0 || u > mark.width - 1 || v > mark.height - 1) continue;
      data[y * frameWidth + x] = Math.round(sample(mark, u, v));
    }
  }
  return { width: frameWidth, height: frameHeight, data };
}

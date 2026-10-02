import {
  type GrayscaleImage,
  type TargetFeature,
  applyHomography,
  locate,
  resample,
  sample,
  smooth,
} from "@taggant/vision";
import { RECOGNISED_PIXELS_ACROSS_FRAME, type View } from "./report.js";

/**
 * Turns of the print the recogniser is shown, in degrees.
 *
 * The count of agreeing points moves by about a fifth as a print turns, and not in the same
 * direction for every design, so a check made in one pose passes artwork whose margin is gone
 * in another. Measured on generated artwork printed twice: 28 points upright, 19 at sixty
 * degrees, against a line of twenty that sat between them. A person holds a label, a bottle or
 * a card at whatever angle it comes to hand. And it is the turns that show a design put on the
 * wrong copy of itself: with two of these four instead of all of them, four of five sheets of
 * four identical designs were called ready.
 */
const TURNS = [0, 30, 60, 90] as const;

/**
 * How far from where the artwork is a pose may put it, as a share of the artwork's width,
 * before it counts as found in the wrong place.
 *
 * Measured over 3 067 found views of 24 pieces: every pose of a design that does not repeat
 * itself was within 0.1 of the artwork's width at the sizes where it fits the frame, most of
 * them within 0.01, and every pose that put a repeated design on another copy of itself was 0.13
 * or more out, most of them 0.35 to 0.71. Imprecision and the wrong place are different
 * failures, and this tells them apart: a pose a few per cent out draws content a little off, and
 * one a third of the way across draws it on the wrong label.
 */
export const MISPLACED_BEYOND = 0.1;

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
 * Says, for each turn, whether the artwork was found, with how many points agreeing, and whether
 * the pose put it somewhere other than where it is.
 *
 * Asynchronous because a server calls it. Each look is a few hundred milliseconds of work that
 * cannot be divided, and a compile asks for dozens of them; run back to back they held a console
 * for eight seconds on a sheet of four postcards, while an unrelated page waited seventeen. It
 * goes back to the event loop before each look, so nothing else waits longer than one.
 */
export function recognitionOf(
  image: GrayscaleImage,
  features: TargetFeature[],
): (pixelsAcross: number) => Promise<View[]> {
  const target = { id: "readiness", width: image.width, height: image.height, features };
  const corners: Array<[number, number]> = [
    [0, 0],
    [image.width - 1, 0],
    [0, image.height - 1],
    [image.width - 1, image.height - 1],
  ];
  return async (pixelsAcross) => {
    const mark = markAt(image, pixelsAcross);
    const views: View[] = [];
    for (const degrees of TURNS) {
      await new Promise((settle) => setImmediate(settle));
      const { frame, truth } = photographed(mark, degrees, image);
      const result = locate(frame, target);
      let misplaced = false;
      if (result.found && result.homography) {
        for (const [x, y] of corners) {
          const [foundX, foundY] = applyHomography(result.homography, x, y);
          const [trueX, trueY] = truth(x, y);
          if (Math.hypot(foundX - trueX, foundY - trueY) > MISPLACED_BEYOND * mark.width) misplaced = true;
        }
      }
      views.push({ found: result.found, inliers: result.found ? result.inliers : 0, misplaced });
    }
    return views;
  };
}

/**
 * The artwork with this many pixels across it, as a camera would deliver it.
 *
 * A camera never hands over the artwork's own pixels. Below the analysed width the reduction
 * smooths it on the way down; at that width or above it did not, and the copy was sharper than
 * any frame: the postcard was found with 22 points at 640 pixels across and 13 at 639.
 */
export function markAt(image: GrayscaleImage, pixelsAcross: number): GrayscaleImage {
  const mark = resample(image, pixelsAcross / image.width);
  return pixelsAcross >= image.width ? smooth(mark) : mark;
}

/**
 * The mark turned about its centre and placed in the middle of a frame, on mid grey, and where
 * that puts each point of the artwork.
 */
function photographed(
  mark: GrayscaleImage,
  degrees: number,
  artwork: { width: number; height: number },
): { frame: GrayscaleImage; truth: (x: number, y: number) => [number, number] } {
  const frameWidth = RECOGNISED_PIXELS_ACROSS_FRAME;
  const frameHeight = Math.round(frameWidth * 0.75);
  const data = new Uint8Array(frameWidth * frameHeight).fill(150);
  const sx = mark.width / artwork.width;
  const sy = mark.height / artwork.height;
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
    return {
      frame: { width: frameWidth, height: frameHeight, data },
      truth: (x, y) => [x * sx + left, y * sy + top],
    };
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
  return {
    frame: { width: frameWidth, height: frameHeight, data },
    // The same turn forwards: where a point of the artwork lands in the frame.
    truth: (x, y) => {
      const u = x * sx - mx;
      const v = y * sy - my;
      return [cos * u - sin * v + cx, sin * u + cos * v + cy];
    },
  };
}

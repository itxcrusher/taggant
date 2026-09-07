import type { Homography } from "@taggant/vision";

export interface Size {
  width: number;
  height: number;
}

/**
 * Turn a pose into the CSS transform that puts content on the artwork.
 *
 * The homography maps artwork coordinates to coordinates in the frame the tracker was
 * given, and that frame is deliberately smaller than what the viewer sees, because
 * tracking a full resolution frame costs more than it buys. So the mapping has to be
 * scaled from the size it was measured at to the size it is drawn at, or the content sits
 * in the right shape at the wrong size, which reads as the tracker being broken.
 *
 * CSS wants a four by four in column major order. A plane mapping fills it out as the
 * identity in z, with the third row and column carrying nothing and the perspective terms
 * landing in w.
 */
export function cssMatrixFor(homography: Homography, processed: Size, displayed: Size): string {
  if (!(processed.width > 0) || !(processed.height > 0)) {
    throw new RangeError(
      `the processed frame must have a positive size, got ${processed.width} x ${processed.height}`,
    );
  }
  const sx = displayed.width / processed.width;
  const sy = displayed.height / processed.height;

  const a = (homography[0] ?? 0) * sx;
  const b = (homography[1] ?? 0) * sx;
  const c = (homography[2] ?? 0) * sx;
  const d = (homography[3] ?? 0) * sy;
  const e = (homography[4] ?? 0) * sy;
  const f = (homography[5] ?? 0) * sy;
  const g = homography[6] ?? 0;
  const h = homography[7] ?? 0;
  const i = homography[8] ?? 1;

  // Columns, in the order CSS reads them.
  const values = [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, i];
  return `matrix3d(${values.map((value) => round(value)).join(", ")})`;
}

/** Six decimals: enough that a pixel never visibly moves, short enough to read. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

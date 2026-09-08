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
 * carried from the size it was measured at to where the picture actually lands on screen.
 *
 * That last part is the whole of the difficulty. The camera picture is shown with
 * `object-fit: cover`, which scales it by one factor in both directions and crops whatever
 * does not fit. Scaling the pose by width and height separately is the arithmetic for
 * `object-fit: fill`, and the two agree only when the container happens to have the
 * camera's shape. On a phone held upright it never does: measured in a browser, a portrait
 * container put the content 131 px to the side of the artwork at 42% of its width.
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

  const cover = coverFit(processed, displayed);
  const scale = cover.scale;
  const ox = cover.offsetX;
  const oy = cover.offsetY;

  // The pose, then the cover fit: [[s,0,ox],[0,s,oy],[0,0,1]] times the homography. The
  // perspective row carries through untouched, and the offsets pick up its terms, which is
  // why this cannot be written as a scale on the first two rows plus a translate.
  const h = (index: number): number => homography[index] ?? (index === 8 ? 1 : 0);
  const a = scale * h(0) + ox * h(6);
  const b = scale * h(1) + ox * h(7);
  const c = scale * h(2) + ox * h(8);
  const d = scale * h(3) + oy * h(6);
  const e = scale * h(4) + oy * h(7);
  const f = scale * h(5) + oy * h(8);
  const g = h(6);
  const i = h(7);
  const j = h(8);

  // Columns, in the order CSS reads them.
  const values = [a, d, 0, g, b, e, 0, i, 0, 0, 1, 0, c, f, 0, j];
  return `matrix3d(${values.map((value) => round(value)).join(", ")})`;
}

/**
 * Where a picture lands when it is shown with `object-fit: cover`.
 *
 * One scale for both directions, the larger of the two so the container is filled, and the
 * overflow split evenly either side, which is what a default `object-position` does.
 */
export function coverFit(source: Size, container: Size): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.max(container.width / source.width, container.height / source.height);
  return {
    scale,
    offsetX: (container.width - source.width * scale) / 2,
    offsetY: (container.height - source.height * scale) / 2,
  };
}

/** Six decimals: enough that a pixel never visibly moves, short enough to read. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

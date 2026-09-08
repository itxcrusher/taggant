import type { Corner } from "./features.js";
import { type GrayscaleImage, sample } from "./image.js";
import { DESCRIPTOR_BITS, PATCH_RADIUS, TEST_PAIRS } from "./pattern.js";

export interface DescribedCorner extends Corner {
  /** Radians. The dominant direction of the patch, so rotating the print does not change the bits. */
  angle: number;
  /** 256 bits, as eight unsigned 32 bit words. */
  descriptor: Uint32Array;
}

/**
 * Below this the patch has no direction worth calling dominant.
 *
 * Measured rather than picked: a rotationally symmetric mark reads 0, and the weakest
 * corner on the test artwork reads 0.025.
 */
const MIN_ORIENTATION_BIAS = 0.01;

/**
 * Direction from the centre of the patch to its intensity centroid, and how strongly the
 * patch commits to it.
 *
 * Without this the descriptor is only comparable when the print is held at the angle it
 * was compiled at, which no one does.
 */
function orientation(image: GrayscaleImage, cx: number, cy: number): { angle: number; bias: number } {
  let mx = 0;
  let my = 0;
  let total = 0;
  const r2 = PATCH_RADIUS * PATCH_RADIUS;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const v = sample(image, cx + dx, cy + dy);
      mx += dx * v;
      my += dy * v;
      total += v;
    }
  }
  // How far off centre the patch's mass sits, as a fraction of how far off centre it
  // could sit. Near zero means the patch has no dominant direction at all.
  const bias = total > 0 ? Math.hypot(mx, my) / (total * PATCH_RADIUS) : 0;
  return { angle: Math.atan2(my, mx), bias };
}

/**
 * Turn corners into descriptors that can be compared across images.
 *
 * Corners closer to the border than the patch are dropped rather than described from
 * clamped pixels, because a descriptor built from an edge that repeats itself matches
 * everything.
 */
/**
 * Orientations the sampling pattern is allowed to be rotated to.
 *
 * The angle comes out of Math.atan2, which differs by one unit in the last place between
 * JavaScript engines. Measured on the same bytes: 58 of 379 angles differed between Node
 * and Chromium, which moved samples across pixel boundaries and changed 28 descriptors by
 * up to 12 bits. That is well inside the distance a match is accepted at, so recognition
 * still worked, but the first percentile of distances between distinct features on real
 * artwork is 7 bits, so a 12 bit shift is enough to hand a match to the wrong feature.
 *
 * Rounding to a fixed number of steps removes it: a difference in the last place cannot
 * change which step an angle falls in, except for the vanishing case of an angle sitting
 * exactly on a boundary. The grid is far finer than it needs to be for that, because a
 * difference in the last place is around 1e-16 and a step here is 1.5e-3, and a coarser
 * grid costs real discrimination: at 256 steps two unrelated corners on the test texture
 * came 10 bits closer together.
 */
const ORIENTATION_STEPS = 1048576;
const STEP = (Math.PI * 2) / ORIENTATION_STEPS;

/**
 * How finely the rotation itself is rounded.
 *
 * Rounding the angle is not enough on its own: the sine and cosine of the rounded angle
 * are transcendental too and also differ in the last place between engines, which was
 * still moving samples across pixel boundaries. Rounding the two multipliers to a grid
 * this coarse is far below anything that can change a sample and far above anything a last
 * place difference can reach.
 */
const ROTATION_GRID = 1 << 20;

/** The rotation for a corner, rounded so that any engine computes the same one. */
function rotationFor(angle: number): { cos: number; sin: number } {
  const quantised = Math.round(angle / STEP) * STEP;
  return {
    cos: Math.round(Math.cos(quantised) * ROTATION_GRID) / ROTATION_GRID,
    sin: Math.round(Math.sin(quantised) * ROTATION_GRID) / ROTATION_GRID,
  };
}

export function describeCorners(image: GrayscaleImage, corners: Corner[]): DescribedCorner[] {
  const described: DescribedCorner[] = [];
  for (const corner of corners) {
    if (
      corner.x < PATCH_RADIUS ||
      corner.y < PATCH_RADIUS ||
      corner.x >= image.width - PATCH_RADIUS ||
      corner.y >= image.height - PATCH_RADIUS
    ) {
      continue;
    }
    const { angle, bias } = orientation(image, corner.x, corner.y);
    // A patch with no dominant direction has an arbitrary angle, and noise flips it from
    // one frame to the next, so its descriptor matches nothing reliably. A filled circle
    // or any rotationally symmetric mark reads exactly zero here; on real artwork the
    // lowest measured was 0.025, so this drops the degenerate case and nothing else.
    if (bias < MIN_ORIENTATION_BIAS) continue;
    const { cos, sin } = rotationFor(angle);
    const descriptor = new Uint32Array(DESCRIPTOR_BITS / 32);
    for (let bit = 0; bit < DESCRIPTOR_BITS; bit++) {
      const i = bit * 4;
      const ax = TEST_PAIRS[i] ?? 0;
      const ay = TEST_PAIRS[i + 1] ?? 0;
      const bx = TEST_PAIRS[i + 2] ?? 0;
      const by = TEST_PAIRS[i + 3] ?? 0;
      const pa = sample(image, corner.x + ax * cos - ay * sin, corner.y + ax * sin + ay * cos);
      const pb = sample(image, corner.x + bx * cos - by * sin, corner.y + bx * sin + by * cos);
      const word = bit >>> 5;
      if (pa < pb) descriptor[word] = ((descriptor[word] ?? 0) | (1 << (bit & 31))) >>> 0;
    }
    described.push({ ...corner, angle, descriptor });
  }
  return described;
}

/** Bits that differ between two descriptors. The only distance that means anything here. */
export function hamming(a: Uint32Array, b: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    let v = ((a[i] ?? 0) ^ (b[i] ?? 0)) >>> 0;
    v = v - ((v >>> 1) & 0x5555_5555);
    v = (v & 0x3333_3333) + ((v >>> 2) & 0x3333_3333);
    total += (((v + (v >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
  }
  return total;
}

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
 * Direction from the centre of the patch to its intensity centroid.
 *
 * Without this the descriptor is only comparable when the print is held at the angle it
 * was compiled at, which no one does.
 */
function orientation(image: GrayscaleImage, cx: number, cy: number): number {
  let mx = 0;
  let my = 0;
  const r2 = PATCH_RADIUS * PATCH_RADIUS;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const v = sample(image, cx + dx, cy + dy);
      mx += dx * v;
      my += dy * v;
    }
  }
  return Math.atan2(my, mx);
}

/**
 * Turn corners into descriptors that can be compared across images.
 *
 * Corners closer to the border than the patch are dropped rather than described from
 * clamped pixels, because a descriptor built from an edge that repeats itself matches
 * everything.
 */
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
    const angle = orientation(image, corner.x, corner.y);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
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

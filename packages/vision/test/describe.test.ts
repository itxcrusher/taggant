import { describe, expect, it } from "vitest";
import { describeCorners, hamming } from "../src/describe.js";
import { type Corner, detectCorners } from "../src/features.js";
import type { GrayscaleImage } from "../src/image.js";

/**
 * Irregular blots: directional at every corner, which is the property artwork needs and a
 * checkerboard lacks. A crossing in a checkerboard is symmetric, so its patch has no
 * dominant direction and no stable descriptor, which is why one is not used here.
 */
function artwork(size: number): GrayscaleImage {
  const data = new Uint8Array(size * size).fill(210);
  let seed = 20260907;
  for (let i = 0; i < 70; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const r = 5 + (seed % 12);
    const value = seed % 2 === 0 ? 25 : 120;
    for (let y = Math.max(0, cy - r); y < Math.min(size, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(size, cx + r); x++) {
        // Half of each blot only, so no blot is rotationally symmetric.
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= cx - r / 2) data[y * size + x] = value;
      }
    }
  }
  return { width: size, height: size, data };
}

/** Rotate a quarter turn: the pixel at (x, y) moves to (height - 1 - y, x). */
function rotate90(image: GrayscaleImage): GrayscaleImage {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[x * height + (height - 1 - y)] = data[y * width + x] ?? 0;
  }
  return { width: height, height: width, data: out };
}

function nearest(corners: Corner[], x: number, y: number): Corner | undefined {
  let best: Corner | undefined;
  let distance = 4;
  for (const corner of corners) {
    const d = Math.hypot(corner.x - x, corner.y - y);
    if (d < distance) {
      distance = d;
      best = corner;
    }
  }
  return best;
}

const SIZE = 160;
const image = artwork(SIZE);
const corners = detectCorners(image);

describe("describeCorners", () => {
  it("produces one 256 bit descriptor per corner, as eight words", () => {
    const described = describeCorners(image, corners);
    expect(described.length).toBeGreaterThan(10);
    for (const corner of described) expect(corner.descriptor.length).toBe(8);
  });

  it("drops corners too close to the border to describe", () => {
    expect(describeCorners(image, [{ x: 2, y: 40, strength: 1 }]).length).toBe(0);
  });

  it("describes a corner and its rotated twin the same way", () => {
    const rotated = rotate90(image);
    const rotatedCorners = detectCorners(rotated);
    let compared = 0;
    for (const corner of describeCorners(image, corners)) {
      // The same physical point, where the quarter turn puts it.
      const twin = nearest(rotatedCorners, SIZE - 1 - corner.y, corner.x);
      if (!twin) continue;
      const described = describeCorners(rotated, [twin])[0];
      if (!described) continue;
      compared++;
      expect(hamming(corner.descriptor, described.descriptor)).toBeLessThan(72);
    }
    // Without orientation these would sit near 128 bits apart, which is chance.
    expect(compared).toBeGreaterThan(5);
  });

  it("keeps unrelated corners far apart, or matching would be meaningless", () => {
    const described = describeCorners(image, corners);
    const a = described[0];
    const b = described[described.length - 1];
    if (!a || !b) throw new Error("expected two corners");
    expect(hamming(a.descriptor, b.descriptor)).toBeGreaterThan(60);
  });
});

describe("hamming", () => {
  it("is zero for a descriptor against itself", () => {
    const d = new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(hamming(d, d)).toBe(0);
  });

  it("counts every differing bit, including the top one", () => {
    const a = new Uint32Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const b = new Uint32Array([0xffff_ffff, 0, 0, 0, 0, 0, 0, 0x8000_0000]);
    expect(hamming(a, b)).toBe(33);
  });
});

describe("describeCorners on patches with no direction", () => {
  /** A filled circle: rotationally symmetric, so its patch has no dominant direction. */
  function disc(size: number, r: number): GrayscaleImage {
    const data = new Uint8Array(size * size).fill(230);
    const c = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x - c) ** 2 + (y - c) ** 2 <= r * r) data[y * size + x] = 30;
      }
    }
    return { width: size, height: size, data };
  }

  it("drops a symmetric patch rather than giving it an arbitrary angle", () => {
    // Without this the angle is atan2(0, 0), which is zero, and noise flips it between
    // frames, so the descriptor matches nothing reliably.
    expect(describeCorners(disc(80, 20), [{ x: 40, y: 40, strength: 1 }]).length).toBe(0);
  });

  it("still describes an ordinary directional corner", () => {
    const size = 80;
    const data = new Uint8Array(size * size).fill(230);
    for (let y = 40; y < size; y++) for (let x = 40; x < size; x++) data[y * size + x] = 30;
    expect(describeCorners({ width: size, height: size, data }, [{ x: 40, y: 40, strength: 1 }]).length).toBe(
      1,
    );
  });
});

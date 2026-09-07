import { describe, expect, it } from "vitest";
import { describeCorners, hamming } from "../src/describe.js";
import type { GrayscaleImage } from "../src/image.js";

/** Deliberately asymmetric, so the patch has a real dominant direction to find. */
function texture(size: number): GrayscaleImage {
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wedge = x * 2 + y;
      data[y * size + x] =
        (Math.floor(x / 7) + Math.floor(y / 5)) % 2 === 0 ? 20 + (wedge % 60) : 235 - (wedge % 60);
    }
  }
  return { width: size, height: size, data };
}

/** Rotate a quarter turn clockwise: the pixel at (x, y) moves to (height - 1 - y, x). */
function rotate90(image: GrayscaleImage): GrayscaleImage {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[x * height + (height - 1 - y)] = data[y * width + x] ?? 0;
    }
  }
  return { width: height, height: width, data: out };
}

describe("describeCorners", () => {
  it("produces one 256 bit descriptor per corner, as eight words", () => {
    const described = describeCorners(texture(80), [{ x: 40, y: 40, strength: 1 }]);
    expect(described.length).toBe(1);
    expect(described[0]?.descriptor.length).toBe(8);
  });

  it("drops corners too close to the border to describe", () => {
    expect(describeCorners(texture(80), [{ x: 2, y: 40, strength: 1 }]).length).toBe(0);
  });

  it("describes a corner and its rotated twin the same way", () => {
    const image = texture(121);
    const rotated = rotate90(image);
    const a = describeCorners(image, [{ x: 60, y: 60, strength: 1 }])[0];
    const b = describeCorners(rotated, [{ x: 60, y: 60, strength: 1 }])[0];
    if (!a || !b) throw new Error("expected both corners to be describable");
    // A quarter turn lands on whole pixels, so with orientation working this is exact.
    // Without it the two descriptors would sit near 128, which is chance.
    expect(hamming(a.descriptor, b.descriptor)).toBeLessThan(24);
  });

  it("turns with the patch, so the angle carries the rotation", () => {
    const image = texture(121);
    const a = describeCorners(image, [{ x: 60, y: 60, strength: 1 }])[0];
    const b = describeCorners(rotate90(image), [{ x: 60, y: 60, strength: 1 }])[0];
    if (!a || !b) throw new Error("expected both corners to be describable");
    const turned = ((((a.angle - b.angle) * 180) / Math.PI + 540) % 360) - 180;
    expect(Math.abs(Math.abs(turned) - 90)).toBeLessThan(5);
  });

  it("keeps unrelated corners far apart, or matching would be meaningless", () => {
    const image = texture(121);
    const a = describeCorners(image, [{ x: 60, y: 60, strength: 1 }])[0];
    const other = describeCorners(image, [{ x: 30, y: 88, strength: 1 }])[0];
    if (!a || !other) throw new Error("expected both corners to be describable");
    expect(hamming(a.descriptor, other.descriptor)).toBeGreaterThan(80);
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

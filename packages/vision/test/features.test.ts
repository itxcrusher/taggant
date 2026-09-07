import { describe, expect, it } from "vitest";
import { detectCorners } from "../src/features.js";
import type { GrayscaleImage } from "../src/image.js";

function blank(width: number, height: number, value = 128): GrayscaleImage {
  return { width, height, data: new Uint8Array(width * height).fill(value) };
}

function withSquare(image: GrayscaleImage, x0: number, y0: number, size: number): GrayscaleImage {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      image.data[y * image.width + x] = 255;
    }
  }
  return image;
}

describe("detectCorners", () => {
  it("finds nothing in a flat field", () => {
    const corners = detectCorners(blank(120, 120));
    expect(corners.length).toBe(0);
  });

  it("finds corners on a high-contrast square", () => {
    const image = withSquare(blank(120, 120), 40, 40, 30);
    const corners = detectCorners(image);
    expect(corners.length).toBeGreaterThanOrEqual(4);
  });

  it("returns corners sorted by descending strength", () => {
    const image = withSquare(blank(160, 160), 30, 30, 40);
    const corners = detectCorners(image);
    for (let i = 1; i < corners.length; i++) {
      expect(corners[i - 1]?.strength).toBeGreaterThanOrEqual(corners[i]?.strength ?? 0);
    }
  });

  it("honours the maximum count", () => {
    const image = withSquare(blank(200, 200), 20, 20, 90);
    expect(detectCorners(image, { maxCorners: 5 }).length).toBeLessThanOrEqual(5);
  });

  it("keeps corners at least minDistance apart", () => {
    const image = withSquare(blank(200, 200), 20, 20, 90);
    const corners = detectCorners(image, { minDistance: 20 });
    for (let i = 0; i < corners.length; i++) {
      for (let j = i + 1; j < corners.length; j++) {
        const a = corners[i];
        const b = corners[j];
        if (!a || !b) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(20);
      }
    }
  });
});

/** Broad, low-contrast texture: the ordinary content of a printed pack. */
function texture(width: number, height: number): GrayscaleImage {
  const data = new Uint8Array(width * height).fill(128);
  let seed = 7;
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % width;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % height;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const r = 3 + (seed % 7);
    const value = seed % 2 === 0 ? 96 : 168;
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data[y * width + x] = value;
      }
    }
  }
  return { width, height, data };
}

/** A barcode: pure black on pure white, which every product pack legally has to carry. */
function withBarcode(image: GrayscaleImage, x0: number, y0: number, size: number): GrayscaleImage {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      image.data[y * image.width + x] = (x - x0) % 4 < 2 ? 0 : 255;
    }
  }
  return image;
}

describe("detectCorners against real print artwork", () => {
  it("does not lose the artwork when a barcode is added to it", () => {
    const plain = detectCorners(texture(600, 600));
    const withCode = detectCorners(withBarcode(texture(600, 600), 20, 20, 60));
    // Adding detail to artwork must not take features away from the rest of it.
    expect(withCode.length).toBeGreaterThan(plain.length * 0.8);
  });

  it("still finds features away from the barcode", () => {
    const corners = detectCorners(withBarcode(texture(600, 600), 20, 20, 60));
    const outside = corners.filter((corner) => corner.x > 100 || corner.y > 100);
    expect(outside.length).toBeGreaterThan(corners.length / 2);
  });

  it("spreads a small budget over the artwork instead of spending it at the top", () => {
    const corners = detectCorners(texture(512, 512), { maxCorners: 60 });
    const lowest = Math.max(...corners.map((corner) => corner.y));
    expect(lowest).toBeGreaterThan(380);
  });

  it("scores a corner on the trim edge the same as one in the middle", () => {
    const edge = withSquare(blank(120, 120), 1, 1, 38);
    const middle = withSquare(blank(120, 120), 40, 40, 38);
    const strongestOf = (image: GrayscaleImage) => detectCorners(image)[0]?.strength ?? 0;
    const ratio = strongestOf(edge) / strongestOf(middle);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

describe("detectCorners input checking", () => {
  it("refuses an image whose data is shorter than its dimensions", () => {
    expect(() => detectCorners({ width: 100, height: 100, data: new Uint8Array(50) })).toThrow(/needs 10000/);
  });

  it("refuses options that would silently disable the spacing check", () => {
    const image = withSquare(blank(120, 120), 40, 40, 30);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => detectCorners(image, { minDistance: bad })).toThrow(/minDistance/);
    }
  });

  it("refuses a quality level outside its range", () => {
    const image = withSquare(blank(120, 120), 40, 40, 30);
    for (const bad of [-0.1, 1, 2, Number.NaN]) {
      expect(() => detectCorners(image, { qualityLevel: bad })).toThrow(/qualityLevel/);
    }
  });

  it("finds nothing in a flat field even with the quality level at zero", () => {
    expect(detectCorners(blank(120, 120), { qualityLevel: 0 }).length).toBe(0);
  });
});

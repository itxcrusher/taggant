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

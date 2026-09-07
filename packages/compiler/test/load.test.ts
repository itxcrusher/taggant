import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadGrayscale } from "../src/load.js";

async function makeCheckerboard(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = ((x >> 3) + (y >> 3)) % 2 === 0 ? 0 : 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

describe("loadGrayscale", () => {
  it("returns single-channel pixels with the source dimensions", async () => {
    const png = await makeCheckerboard(640, 480);
    const image = await loadGrayscale(png);
    expect(image.width).toBe(640);
    expect(image.height).toBe(480);
    expect(image.data.length).toBe(640 * 480);
  });

  it("downscales when the longest edge exceeds the limit, preserving aspect", async () => {
    const png = await makeCheckerboard(2000, 1000);
    const image = await loadGrayscale(png, { maxEdge: 1000 });
    expect(image.width).toBe(1000);
    expect(image.height).toBe(500);
  });

  it("rejects an image smaller than the minimum usable size", async () => {
    const png = await makeCheckerboard(64, 48);
    await expect(loadGrayscale(png, { minEdge: 128 })).rejects.toThrow(/at least 128/);
  });
});

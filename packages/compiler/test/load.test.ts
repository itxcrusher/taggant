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

describe("loadGrayscale against the files print actually arrives as", () => {
  it("composites transparency onto the stock, so a blank sheet reads as blank", async () => {
    const width = 320;
    const height = 320;
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const y = Math.floor(i / width);
      const hidden = ((x >> 4) + (y >> 4)) % 2 === 0 ? 20 : 235;
      rgba[i * 4] = hidden;
      rgba[i * 4 + 1] = hidden;
      rgba[i * 4 + 2] = hidden;
      rgba[i * 4 + 3] = 0;
    }
    const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    const image = await loadGrayscale(png);
    expect(new Set(image.data).size).toBe(1);
  });

  it("applies EXIF orientation, so the size is the one every viewer shows", async () => {
    const width = 400;
    const height = 300;
    const pixels = Buffer.alloc(width * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i % 97 < 40 ? 30 : 220;
    const jpeg = await sharp(pixels, { raw: { width, height, channels: 1 } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const image = await loadGrayscale(jpeg, { minEdge: 100 });
    expect(image.width).toBe(300);
    expect(image.height).toBe(400);
  });

  it("applies the shortest edge rule to the size it will analyse, not the size that arrived", async () => {
    const strip = await makeCheckerboard(4000, 300);
    await expect(loadGrayscale(strip)).rejects.toThrow(/once scaled for analysis, and this is 90 px/);
  });
});

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compileTarget } from "../src/compile.js";

async function noisyArtwork(width = 512, height = 512): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    pixels[i] = ((x >> 4) + (y >> 4)) % 2 === 0 ? 30 : 220;
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

describe("compileTarget", () => {
  it("produces a target with an id, dimensions, features and a report", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    expect(target.id).toBe("front-panel");
    expect(target.width).toBeGreaterThan(0);
    expect(target.features.length).toBeGreaterThan(0);
    expect(target.report.score).toBeGreaterThan(0);
  });

  it("records the format version so a runtime can refuse what it cannot read", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    expect(target.formatVersion).toBe(1);
  });

  it("serialises to JSON and back without losing features", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    const round = JSON.parse(JSON.stringify(target));
    expect(round.features.length).toBe(target.features.length);
  });
});

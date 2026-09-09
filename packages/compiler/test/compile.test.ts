import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compileTarget } from "../src/compile.js";

/**
 * Irregular artwork, deliberately not a checkerboard.
 *
 * A checkerboard is the canonical untrackable image target: every crossing looks like
 * every other, so no matcher can tell them apart, and each one is symmetric, so no patch
 * has a stable direction. Testing the compiler against one measured whether it produced
 * numbers, not whether the numbers meant anything.
 */
async function noisyArtwork(width = 512, height = 512): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height, 210);
  let seed = 20260907;
  for (let i = 0; i < 220; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % width;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % height;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const r = 5 + (seed % 14);
    const value = seed % 3 === 0 ? 25 : seed % 3 === 1 ? 90 : 160;
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        // Half discs, so no blot is rotationally symmetric.
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= cx - r / 2) pixels[y * width + x] = value;
      }
    }
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

  it("carries a descriptor for every feature, because corners alone match nothing", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    for (const feature of target.features) {
      expect(feature.descriptor).toBeInstanceOf(Uint32Array);
      expect(feature.descriptor.length).toBe(8);
    }
  });

  it("describes the artwork at several sizes, so distance does not lose it", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    const scales = new Set(target.features.map((feature) => feature.scale));
    expect(scales.size).toBeGreaterThan(1);
    expect(scales.has(1)).toBe(true);
  });

  it("counts each place on the artwork once in the report, not once per size", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    expect(target.report.featureCount).toBeLessThan(target.features.length);
    expect(target.report.featureCount).toBe(target.features.filter((f) => f.scale === 1).length);
  });

  it("records the format version so a runtime can refuse what it cannot read", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    expect(target.formatVersion).toBe(3);
  });

  it("serialises to JSON and back without losing features", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    const round = JSON.parse(JSON.stringify(target));
    expect(round.features.length).toBe(target.features.length);
  });
});

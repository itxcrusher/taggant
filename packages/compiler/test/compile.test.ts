import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SCALES } from "@taggant/vision";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compileTarget, toTargetJson } from "../src/compile.js";
import { targetDigest } from "../src/digest.js";
import { describesTarget, isCurrentReport } from "../src/report.js";

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
    // A report the recogniser was asked about, whatever it answered. This said the score was
    // above zero, which was a stand-in for "there is a report": this artwork is found upright
    // and almost never turned, so it is refused, and a refusal now scores by how far short of
    // agreeing it fell, which here is all the way.
    expect(target.report.recognition).not.toBeNull();
    expect(target.report.score).toBeGreaterThanOrEqual(0);
    expect(target.report.score).toBeLessThanOrEqual(100);
    expect(typeof target.report.pass).toBe("boolean");
  });

  it("carries a descriptor for every feature, because corners alone match nothing", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    // "every feature" is only a claim if there were features. Compiling to nothing would
    // otherwise satisfy this.
    expect(target.features.length, "the artwork compiled to no features").toBeGreaterThan(0);
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
    // And only the sizes a target covers. The smaller ones the artwork is described at for the
    // repetition measure are not what a camera is matched against, and do not ship.
    for (const scale of scales) expect(DEFAULT_SCALES).toContain(scale);
  });

  it("counts each place on the artwork once in the report, not once per size", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    expect(target.report.featureCount).toBeLessThan(target.features.length);
    expect(target.report.featureCount).toBe(target.features.filter((f) => f.scale === 1).length);
  });

  it("records the format version so a runtime can refuse what it cannot read", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    expect(target.formatVersion).toBe(2);
  });

  it("serialises to JSON and back without losing features", async () => {
    const target = await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 });
    const round = JSON.parse(JSON.stringify(target));
    expect(round.features.length).toBe(target.features.length);
  });

  it("writes into its report the fingerprint of the target as the file holds it, and of no other", async () => {
    const stored = JSON.parse(
      JSON.stringify(
        toTargetJson(await compileTarget(await noisyArtwork(), { id: "front-panel", scanDistanceMm: 400 })),
      ),
    );
    expect(isCurrentReport(stored.report)).toBe(true);
    expect(stored.report.targetDigest).toBe(targetDigest(stored));
    expect(describesTarget(stored)).toBe(true);
    // Another target with the same width, the same sizes and the same count of features at full
    // size, which is all the report's own figures can tell: one bit of one descriptor apart.
    const first = stored.features[0];
    const other = {
      ...stored,
      features: [
        { ...first, descriptor: [(first.descriptor[0] ^ 1) >>> 0, ...first.descriptor.slice(1)] },
        ...stored.features.slice(1),
      ],
    };
    expect(describesTarget(other)).toBe(false);
    // Nor with one feature moved a pixel, or the artwork a pixel taller.
    expect(
      describesTarget({ ...stored, features: [{ ...first, x: first.x + 1 }, ...stored.features.slice(1)] }),
    ).toBe(false);
    expect(describesTarget({ ...stored, height: stored.height + 1 })).toBe(false);
  });

  it("ties a refusal to its own target when the artwork holds no features at full size", async () => {
    // Soft artwork, the example postcard blurred: refused for too few features, it holds none at
    // full size, and a refusal confirms no size, keeping the full size as its own. Its report
    // was called another target's, and compiling again could not clear it.
    const postcard = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/postcard/artwork.png");
    const soft = await sharp(postcard).blur(8).png().toBuffer();
    const stored = JSON.parse(
      JSON.stringify(toTargetJson(await compileTarget(soft, { id: "soft", scanDistanceMm: 190 }))),
    );
    expect(stored.report.pass).toBe(false);
    expect(stored.report.smallestUsableScale).toBe(1);
    expect(stored.features.some((feature: { scale: number }) => feature.scale === 1)).toBe(false);
    expect(isCurrentReport(stored.report)).toBe(true);
    expect(describesTarget(stored)).toBe(true);
    // A passing report is still held to a size the target holds features at.
    const claimed = { ...stored, report: { ...stored.report, pass: true } };
    expect(describesTarget(claimed)).toBe(false);
  });
});

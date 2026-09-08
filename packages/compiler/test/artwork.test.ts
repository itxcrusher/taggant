import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compileTarget } from "../src/compile.js";

/**
 * Generated artwork, so the property under test is the only thing that changes.
 *
 * Hand built corner lists cannot check a claim about artwork. A fixture built from the
 * same model as the code under test agrees with it whether or not the model is right, so
 * anything the report claims about artwork is claimed here against artwork that went
 * through the whole compiler.
 */
async function artwork(options: {
  blobs: number;
  radius: number;
  size?: number;
}): Promise<Buffer> {
  const size = options.size ?? 600;
  const pixels = Buffer.alloc(size * size).fill(238);
  let seed = 4242;
  for (let i = 0; i < options.blobs; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % size;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const value = seed % 2 === 0 ? 28 : 140;
    const r = options.radius;
    for (let y = Math.max(0, cy - r); y < Math.min(size, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(size, cx + r); x++) {
        // Half moons rather than discs, so the shapes have corners rather than only edges.
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= cx - r / 2) pixels[y * size + x] = value;
      }
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
}

// These compile real images at several sizes, which takes seconds rather than
// milliseconds. Stated here rather than left to the default, where they pass alone and
// time out in a full run, which is the worst way for a test to fail.
describe("the report against real artwork", { timeout: 30_000 }, () => {
  it("does not give bold artwork a bigger minimum print than fine artwork", async () => {
    const bold = await compileTarget(await artwork({ blobs: 40, radius: 40 }), {
      id: "bold",
      scanDistanceMm: 350,
    });
    const fine = await compileTarget(await artwork({ blobs: 900, radius: 6 }), {
      id: "fine",
      scanDistanceMm: 350,
    });
    expect(bold.report.pass).toBe(true);
    expect(fine.report.pass).toBe(true);
    // Both are the same raster and both hold up all the way down, so they should agree.
    // The failure this guards against is the number moving with something that is not a
    // resolution property at all, in either direction.
    expect(bold.report.minimumWidthMm).toBe(fine.report.minimumWidthMm);
  });

  it("gives the same design the same answer whichever size it was exported at", async () => {
    const widths: Array<number | null> = [];
    for (const size of [600, 900]) {
      const target = await compileTarget(
        await artwork({ blobs: 200, radius: Math.round(18 * (size / 600)), size }),
        {
          id: "d",
          scanDistanceMm: 350,
        },
      );
      // Normalised by the raster it was analysed at, the requirement is the same design
      // property whatever the export size.
      widths.push(
        target.report.minimumWidthMm === null
          ? null
          : Math.round((target.report.minimumWidthMm / target.report.analysisWidth) * 1000),
      );
    }
    expect(new Set(widths).size).toBe(1);
  });

  it("asks for more width the further away it will be scanned", async () => {
    const art = await artwork({ blobs: 200, radius: 18 });
    const near = await compileTarget(art, { id: "d", scanDistanceMm: 300 });
    const far = await compileTarget(art, { id: "d", scanDistanceMm: 900 });
    expect(far.report.minimumWidthMm ?? 0).toBeGreaterThan((near.report.minimumWidthMm ?? 0) * 2);
  });

  it("still passes artwork that carries a barcode, which nearly every pack does", async () => {
    const plain = await artwork({ blobs: 200, radius: 18 });
    // A barcode: hard black and white bars, which is what raises the response so far above
    // the rest of the artwork.
    const bars = Buffer.alloc(80 * 80);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) bars[y * 80 + x] = x % 4 < 2 ? 0 : 255;
    const withCode = await sharp(plain)
      .composite([{ input: bars, raw: { width: 80, height: 80, channels: 1 }, top: 20, left: 20 }])
      .png()
      .toBuffer();
    const before = await compileTarget(plain, { id: "a", scanDistanceMm: 350 });
    const after = await compileTarget(withCode, { id: "b", scanDistanceMm: 350 });
    expect(after.report.pass).toBe(true);
    expect(after.report.featureCount).toBeGreaterThan(before.report.featureCount * 0.7);
  });

  it("refuses artwork that repeats, because a pose can land on the wrong copy", async () => {
    const once = await artwork({ blobs: 200, radius: 18, size: 600 });
    const raw = await sharp(once).grayscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = raw.info;
    // The same design printed twice side by side, which is what a sheet of labels is.
    const tiled = Buffer.alloc(width * 2 * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = raw.data[y * width + x] ?? 0;
        tiled[y * width * 2 + x] = value;
        tiled[y * width * 2 + width + x] = value;
      }
    }
    const twice = await sharp(tiled, { raw: { width: width * 2, height, channels: 1 } })
      .png()
      .toBuffer();

    const single = await compileTarget(once, { id: "once", scanDistanceMm: 350 });
    const repeated = await compileTarget(twice, { id: "twice", scanDistanceMm: 350 });

    // The single piece is fine and has to stay fine: a gate that fails everything is not a
    // gate. The repeated one has plenty of features, spread over the whole piece, and no
    // way to tell which copy is being looked at.
    expect(single.report.pass).toBe(true);
    expect(repeated.report.featureCount).toBeGreaterThan(60);
    expect(repeated.report.areasWithFeatures).toBeGreaterThan(8);
    expect(repeated.report.pass).toBe(false);
    expect(repeated.report.reasons).toContain(
      "the artwork repeats itself, so content could be placed on the wrong copy",
    );
    expect(repeated.report.repetition ?? 0).toBeGreaterThan(single.report.repetition ?? 0);
  });
});

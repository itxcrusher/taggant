import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compileTarget } from "../src/compile.js";

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/postcard");

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
    // Both are the same raster and both hold up all the way down, so the corners give them the
    // same width; the failure this guards against is the number moving with something that is
    // not a resolution property, which one earlier formula did, backwards.
    //
    // The width is now the smallest the recogniser confirms, and for these two that is still
    // the first size: the fine artwork with 97 points in its worst turn and the bold with 24,
    // against a line of 20. Forty identical marks give the recogniser less to agree on, so the
    // bold margin is four points. If it ever loses them, its width moving up a size is the
    // recogniser saying so, and the line is not the thing to move.
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

  it("asks a design printed twice for a larger print, and confirms it there", async () => {
    const once = await artwork({ blobs: 200, radius: 18, size: 600 });
    const raw = await sharp(once).grayscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = raw.info;
    // The same design printed twice side by side.
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

    // This used to assert a refusal, "because a pose can land on the wrong copy". Measured at
    // the printed width over 21 poses, seven turns and three offsets, the pose landed on the
    // right copy every time, worst error 2.7 pixels. What repetition does cost is agreement:
    // 19 to 33 points against 115 to 143 for the design once, because a matcher discards a
    // feature whose twin is as good a match. So a piece that is found and placed is not
    // refused; it is confirmed where the recogniser agrees, which for this one is a size above
    // the single design's, by one point at the first size. That margin is too fine to assert,
    // so what is asserted is what is robust: far less agreement, and still confirmed.
    expect(single.report.pass).toBe(true);
    expect(repeated.report.pass).toBe(true);
    const seen = repeated.report.recognition;
    expect(seen?.found).toBe(true);
    expect(seen?.inliers ?? 0).toBeGreaterThanOrEqual(seen?.needed ?? Number.POSITIVE_INFINITY);
    expect(seen?.inliers ?? 0).toBeLessThan(single.report.recognition?.inliers ?? 0);
  });

  it("refuses a sheet of identical labels at every size, which the old repetition gate passed", async () => {
    // Sixteen copies of the example postcard. The repetition figure that decided readiness
    // read 0.31 for this, under its line of 0.6, because it falls as copies are added; the
    // report said ready for press at 185 mm, and at 185 mm the recogniser does not find it.
    const sheet = await sheetOf(4);
    const compiled = await compileTarget(sheet, { id: "sheet", scanDistanceMm: 190 });
    expect(compiled.report.featureCount).toBeGreaterThan(60);
    expect(compiled.report.repetition ?? 1).toBeLessThan(0.6);
    expect(compiled.report.pass).toBe(false);
    expect(compiled.report.minimumWidthMm).toBeNull();
    expect(compiled.report.score).toBeLessThan(60);
    expect(compiled.report.recognition?.inliers ?? 0).toBeLessThan(compiled.report.recognition?.needed ?? 0);
  });

  it("gives a sheet the same verdict whichever size it was exported at", async () => {
    // The export dialogue decided this. Four copies of the postcard read ready for press when
    // exported 4400 or 5300 pixels wide and not ready at 4700, 5000, 5600 and 9600, because the
    // repetition figure moved by more than the gate's whole margin with the export size.
    const sheet = await sheetOf(2);
    for (const edge of [4400, 4700, 5300]) {
      const exported = await sharp(sheet).resize({ width: edge }).png().toBuffer();
      const compiled = await compileTarget(exported, { id: "sheet", scanDistanceMm: 190 });
      expect(compiled.report.pass, `exported ${edge} pixels wide`).toBe(false);
    }
  });
});

/** N by N copies of the example postcard, laid out edge to edge as a sheet of labels is. */
async function sheetOf(n: number): Promise<Buffer> {
  const one = await sharp(join(EXAMPLE_DIR, "artwork.png"))
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = one.info;
  const out = Buffer.alloc(width * n * height * n);
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      for (let y = 0; y < height; y++) {
        one.data.copy(out, (ty * height + y) * width * n + tx * width, y * width, y * width + width);
      }
    }
  }
  return sharp(out, { raw: { width: width * n, height: height * n, channels: 1 } })
    .png()
    .toBuffer();
}

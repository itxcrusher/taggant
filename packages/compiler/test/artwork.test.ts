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
  width?: number;
  height?: number;
}): Promise<Buffer> {
  const width = options.width ?? options.size ?? 600;
  const height = options.height ?? options.size ?? 600;
  const pixels = Buffer.alloc(width * height).fill(238);
  let seed = 4242;
  for (let i = 0; i < options.blobs; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % width;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % height;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const value = seed % 2 === 0 ? 28 : 140;
    const r = options.radius;
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        // Half moons rather than discs, so the shapes have corners rather than only edges.
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= cx - r / 2) pixels[y * width + x] = value;
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

// These compile real images at several sizes, which takes seconds rather than
// milliseconds. Stated here rather than left to the default, where they pass alone and
// time out in a full run, which is the worst way for a test to fail. Two minutes, because a
// compile shows the recogniser twenty looks at the size it confirms and more at the sizes it
// refuses, a few hundred milliseconds each, and a sheet it refuses everywhere is the dearest.
describe("the report against real artwork", { timeout: 120_000 }, () => {
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

  it("refuses a design printed twice, from its features, where the single design passes", async () => {
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

    // This asserted the opposite, that a design printed twice is confirmed a size up, because
    // the poses its looks were measured on landed on the right copy. They mostly do, and a few
    // in a thousand do not, which twenty looks see or miss by chance. What the looks were
    // sampling is read off the features now, and it is not close: the design maps onto itself
    // at about a hundred places, where the single design manages a handful.
    expect(single.report.pass).toBe(true);
    expect(single.report.repetition?.places ?? 99).toBeLessThan(15);
    expect(repeated.report.pass).toBe(false);
    expect(repeated.report.repetition?.places ?? 0).toBeGreaterThanOrEqual(60);
    expect(repeated.report.reasons.join(" ")).toContain("it maps onto itself");
    expect(repeated.report.reasons.join(" ")).toContain("shifting it 50 per cent of its width");
    // Refused before the recogniser was asked anything.
    expect(repeated.report.recognition).toBeNull();
  });

  it("refuses the postcard printed twice at every export width, gutter and layout found ready", async () => {
    // The looks decided this by whether one of twenty landed on the wrong copy, and that turned
    // on the resampling: the postcard printed twice, one above the other, was refused exported
    // 592 pixels wide and ready for press at 640, ready with an eight pixel gutter between the
    // copies, and a sheet of four with a gutter was ready at 232 mm. Each is refused now, for
    // what it is.
    const stacked = await sheetOf(1, 2);
    const cases: Array<[string, Buffer]> = [
      ["exported 592 wide", stacked],
      ["exported 640 wide", await sharp(stacked).resize({ width: 640 }).png().toBuffer()],
      ["exported 1000 wide", await sharp(stacked).resize({ width: 1000 }).png().toBuffer()],
      ["with an 8 px gutter", await sheetOf(1, 2, 8)],
      ["four with an 8 px gutter", await sheetOf(2, 2, 8)],
    ];
    for (const [name, buffer] of cases) {
      const compiled = await compileTarget(buffer, { id: "twice", scanDistanceMm: 190 });
      expect(compiled.report.pass, name).toBe(false);
      expect(compiled.report.reasons.join(" "), name).toContain("it maps onto itself");
    }
  }, 240_000);

  it("refuses a design beside itself turned half way round, which a sheet laid out for cutting has", async () => {
    const once = await artwork({ blobs: 200, radius: 18, size: 600 });
    const turned = await sharp(once).rotate(180).png().toBuffer();
    const pair = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#eeeeee" } })
      .composite([
        { input: once, left: 0, top: 0 },
        { input: turned, left: 600, top: 0 },
      ])
      .png()
      .toBuffer();
    const compiled = await compileTarget(pair, { id: "pair", scanDistanceMm: 350 });
    expect(compiled.report.pass).toBe(false);
    expect(compiled.report.reasons.join(" ")).toContain("turning it 180 degrees");
  });

  it("refuses a sheet of identical labels at every size, which the old repetition gate passed", async () => {
    // Sixteen copies of the example postcard. The figure that decided readiness read 0.31 for
    // this, under its line of 0.6, because it fell as copies were added; the report said ready
    // for press at 185 mm, and at 185 mm the recogniser does not find it.
    const sheet = await sheetOf(4);
    const compiled = await compileTarget(sheet, { id: "sheet", scanDistanceMm: 190 });
    expect(compiled.report.featureCount).toBeGreaterThan(60);
    expect(compiled.report.pass).toBe(false);
    expect(compiled.report.minimumWidthMm).toBeNull();
    expect(compiled.report.score).toBeLessThan(60);
    expect(compiled.report.reasons.join(" ")).toContain("it maps onto itself");
  });

  it("refuses the postcard beside a copy of itself at another size, which the lines let through", async () => {
    // At 60 per cent the move carries 61 of 458 places and at 35 per cent 14 of 505: no line
    // refuses either, both were called ready for press, and a camera brought close to the small
    // copy settles on the large one. The 35 per cent copy pairs only through the smaller sizes the
    // compiler describes the artwork at for this, which the target does not hold.
    for (const factor of [0.6, 0.35]) {
      const compiled = await compileTarget(await besideItself(factor), { id: "pair", scanDistanceMm: 190 });
      const name = `a copy at ${factor * 100} per cent`;
      expect(compiled.report.pass, name).toBe(false);
      expect(compiled.report.minimumWidthMm, name).toBeNull();
      expect(compiled.report.reasons.join(" "), name).toContain("pointed at the part of the artwork");
      expect(compiled.report.repetition?.aimed?.misplaced, name).toBeGreaterThan(0);
    }
  });

  it("judges a look pointed at a design where it is pointed, not at corners far outside the frame", async () => {
    // A design with no copy, whose move between two coincidences carries twelve places, is pointed
    // at. Judged at its corners, hundreds of pixels outside the frame, a pose a few pixels out
    // where the camera was pointed was a hundred out there, and the design was refused exported
    // 400 and 500 pixels wide and ready at 450.
    const tall = await artwork({ blobs: 40, radius: 40, width: 500, height: 800 });
    for (const exported of [400, 500]) {
      const buffer = await sharp(tall).resize({ width: exported }).png().toBuffer();
      const compiled = await compileTarget(buffer, { id: "tall", scanDistanceMm: 190 });
      const name = `exported ${exported} wide`;
      expect(compiled.report.repetition?.aimed, name).not.toBeNull();
      expect(compiled.report.pass, name).toBe(true);
    }
  });

  it("passes the postcard with a part of it copied at its own size, after pointing at both copies", async () => {
    // The rest of the artwork outvotes the copied part wherever the camera is pointed.
    const one = await sharp(join(EXAMPLE_DIR, "artwork.png"))
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = one.info;
    const data = Buffer.from(one.data);
    const side = 180;
    for (let y = 0; y < side; y++) {
      one.data.copy(
        data,
        (height - side - 30 + y) * width + width - side - 30,
        (30 + y) * width + 30,
        (30 + y) * width + 30 + side,
      );
    }
    const partly = await sharp(data, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
    const compiled = await compileTarget(partly, { id: "part", scanDistanceMm: 190 });
    expect(compiled.report.pass).toBe(true);
    expect(compiled.report.repetition?.aimed).toEqual({ sizes: 4, views: 32, misplaced: 0 });
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
  }, 360_000);
});

/** The example postcard and, 16 pixels to its right, a copy of it at `factor` of its size. */
async function besideItself(factor: number): Promise<Buffer> {
  const artwork = join(EXAMPLE_DIR, "artwork.png");
  const { width, height } = await sharp(artwork).metadata();
  const copy = await sharp(artwork)
    .resize({ width: Math.round((width ?? 0) * factor) })
    .png()
    .toBuffer();
  const copyHeight = (await sharp(copy).metadata()).height ?? 0;
  return sharp({
    create: {
      width: (width ?? 0) + 16 + Math.round((width ?? 0) * factor),
      height: height ?? 0,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: artwork, left: 0, top: 0 },
      { input: copy, left: (width ?? 0) + 16, top: Math.round(((height ?? 0) - copyHeight) / 2) },
    ])
    .png()
    .toBuffer();
}

/**
 * Copies of the example postcard laid out edge to edge as a sheet of labels is: `across` by
 * `down`, which is `across` by `across` when only one is given.
 */
async function sheetOf(across: number, down = across, gutter = 0): Promise<Buffer> {
  const one = await sharp(join(EXAMPLE_DIR, "artwork.png"))
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = one.info;
  // White paper between the copies, `gutter` pixels of it, as a sheet of labels has.
  const sheetWidth = width * across + gutter * (across - 1);
  const sheetHeight = height * down + gutter * (down - 1);
  const out = Buffer.alloc(sheetWidth * sheetHeight, 255);
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      for (let y = 0; y < height; y++) {
        one.data.copy(
          out,
          (ty * (height + gutter) + y) * sheetWidth + tx * (width + gutter),
          y * width,
          y * width + width,
        );
      }
    }
  }
  return sharp(out, { raw: { width: sheetWidth, height: sheetHeight, channels: 1 } })
    .png()
    .toBuffer();
}

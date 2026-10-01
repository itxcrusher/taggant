import type { Corner } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  carriesItsDistance,
  describeWidth,
  distanceBehind,
  isCurrentReport,
} from "../src/report.js";

/**
 * A stand-in for the recogniser that finds the artwork at any width.
 *
 * These tests are about the width arithmetic and the corner gates, built from synthetic
 * corners with no pixels to show anybody. Readiness is the recogniser's answer, so they have to
 * say what they assumed it would answer, and this is it, by name. The real recogniser is
 * driven against real artwork in `artwork.test.ts` and `printed.test.ts`.
 */
const FOUND_EVERYWHERE = () => ({ found: true, inliers: 99 });

function corners(count: number, spread = 100): Corner[] {
  return Array.from({ length: count }, (_, i) => ({
    x: (i * 37) % spread,
    y: (i * 61) % spread,
    strength: 1000 - i,
  }));
}

describe("buildReport", () => {
  it("fails artwork with too few corners", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(4) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.pass).toBe(false);
    expect(report.reasons).toContain("too few features to track reliably");
  });

  it("passes artwork with plenty of well spread corners", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.pass).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("scores from 0 to 100", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("requires a larger print for a longer scan distance", () => {
    const near = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 300,
      recognises: FOUND_EVERYWHERE,
    });
    const far = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 900,
      recognises: FOUND_EVERYWHERE,
    });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan(near.minimumWidthMm ?? 0);
  });

  it("flags artwork whose features crowd one part of the image", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 60) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.reasons).toContain("features are concentrated in part of the artwork");
  });
});

describe("buildReport input validation", () => {
  it("refuses a scan distance that is not a positive finite number", () => {
    for (const bad of [0, -400, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildReport({
          image: { width: 400, height: 400 },
          levels: [{ scale: 1, corners: corners(10) }],
          scanDistanceMm: bad,
          recognises: FOUND_EVERYWHERE,
        }),
      ).toThrow(/scan distance/i);
    }
  });

  it("refuses an image with no area, rather than reporting on it", () => {
    expect(() =>
      buildReport({
        image: { width: 0, height: 0 },
        levels: [{ scale: 1, corners: corners(10) }],
        scanDistanceMm: 400,
        recognises: FOUND_EVERYWHERE,
      }),
    ).toThrow(/image/i);
  });
});

describe("the numbers a printer acts on", () => {
  it("does not report a print width for artwork with nothing to track", () => {
    const report = buildReport({
      image: { width: 500, height: 500 },
      levels: [{ scale: 1, corners: [] }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.minimumWidthMm).toBeNull();
  });

  it("asks for a larger print when the artwork stops holding up at the smaller sizes", () => {
    // The raster artwork is actually analysed at, so these widths mean what they mean in a
    // real report. At 1000 they did not: everything needed more pixels across the mark than
    // a frame has, which is a real refusal and not what this case is about.
    const image = { width: 640, height: 640 };
    const good = buildReport({
      image,
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    // The same artwork, but the smaller sizes stop carrying detail sooner.
    const fragile = buildReport({
      image,
      levels: [
        { scale: 1, corners: lattice(40, 640) },
        { scale: 0.79, corners: lattice(40, 640) },
        { scale: 0.63, corners: lattice(40, 640) },
        { scale: 0.5, corners: lattice(400, 640) },
      ],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(good.smallestUsableScale).toBe(0.5);
    expect(fragile.smallestUsableScale).toBe(0.63);
    expect(fragile.minimumWidthMm ?? 0).toBeGreaterThan(good.minimumWidthMm ?? 0);
  });

  it("says what the width was derived from, so it cannot be read as a measurement of the design", () => {
    const report = buildReport({
      image: { width: 640, height: 640 },
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    const described = describeWidth(report);
    expect(described).toContain("400 mm away");
    // And which edge. The same postcard reads 147 mm on its side and 104 mm upright, so a width
    // that does not say it is left to right invites a manifest that declares the other edge.
    expect(described).toContain("px across the artwork from left to right");
    expect(report.analysisWidth).toBe(640);
  });

  /**
   * Artwork that holds up only near its own size asks for a big print, and a big print is
   * a legal answer.
   *
   * There was a ceiling here for a day: anything needing more pixels across itself than the
   * frame is wide was refused, on the reasoning that it would have to fill more than the
   * whole picture. The recogniser does not need the whole mark in view. Against this
   * repository's example, at the runtime's own frame width, a mark 506 px across was found
   * with 116 inliers with 95% of its width in frame, and one 640 px across was found with
   * 123 inliers with 75% of it in frame. The ceiling refused artwork that works, and it
   * refused the same file one way up and passed it the other, because the analysis raster
   * fits the longest edge.
   */
  it("names a width larger than the frame rather than refusing it", () => {
    const image = { width: 640, height: 640 };
    const onlyAtFullSize = buildReport({
      image,
      levels: [
        { scale: 1, corners: lattice(40, 640) },
        { scale: 0.79, corners: lattice(400, 640) },
      ],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(onlyAtFullSize.pass).toBe(true);
    // 640 px across the artwork at its smallest usable size, in a frame 480 px wide: the
    // width is the one at which the whole mark spans the picture, and printing larger is
    // read from further back.
    expect(onlyAtFullSize.minimumWidthMm ?? 0).toBeGreaterThan(480 / (480 / (1154.7 * 0.4)));
    expect(onlyAtFullSize.reasons).toEqual([]);
    expect(describeWidth(onlyAtFullSize)).toContain("mm");
  });

  it("does not tell someone whose artwork cannot track that the print is too small", () => {
    // Artwork that fails on features has no usable size below its own, so it trips the size
    // ceiling as well, and the report then carried both complaints. The second one is wrong
    // advice: printing faint artwork larger does not give it features. Only the reason
    // someone can act on should be there, and the first one is it.
    const tooFaint = buildReport({
      image: { width: 640, height: 640 },
      levels: [{ scale: 1, corners: lattice(200, 640) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(tooFaint.pass).toBe(false);
    expect(tooFaint.reasons).toEqual(["too few features to track reliably"]);
  });

  it("scales the width with the scan distance, because a camera further away sees less", () => {
    const image = { width: 640, height: 640 };
    const levels = [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) }));
    const near = buildReport({ image, levels, scanDistanceMm: 300, recognises: FOUND_EVERYWHERE });
    const far = buildReport({ image, levels, scanDistanceMm: 900, recognises: FOUND_EVERYWHERE });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan((near.minimumWidthMm ?? 0) * 2);
  });

  it("never prints a passing verdict under a failing score, or the reverse", () => {
    const image = { width: 1000, height: 1000 };
    for (const spacing of [10, 18, 25, 40, 70, 120, 300]) {
      const report = buildReport({
        image,
        levels: [{ scale: 1, corners: lattice(spacing, 1000) }],
        scanDistanceMm: 400,
        recognises: FOUND_EVERYWHERE,
      });
      expect(report.pass).toBe(report.score >= 60);
    }
  });

  it("does not tell someone with no features that they are concentrated", () => {
    const report = buildReport({
      image: { width: 500, height: 500 },
      levels: [{ scale: 1, corners: [] }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    // Both are true of artwork with nothing on it, and the point of this case is the one
    // that is not said: nothing about features being bunched together, since there are none.
    expect(report.reasons).toContain("too few features to track reliably");
    expect(report.reasons.join(" ")).not.toMatch(/concentrated|corner of the artwork/i);
  });

  it("keeps the area count inside the grid even for coordinates it did not produce", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [
        {
          scale: 1,
          corners: [
            { x: -900, y: -900, strength: 1 },
            { x: 9000, y: 9000, strength: 1 },
            { x: 200, y: 200, strength: 1 },
          ],
        },
      ],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.areasWithFeatures).toBeLessThanOrEqual(report.areas);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

describe("readiness is the recogniser's answer", () => {
  const image = { width: 640, height: 640 };
  const levels = [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) }));

  it("does not pass a report nobody showed to the recogniser", () => {
    // Every way of deciding readiness from corners alone has been measured wrong, the last a
    // repetition figure that passed a sheet of sixteen identical postcards. A report that was
    // never checked says so rather than saying ready.
    const report = buildReport({ image, levels, scanDistanceMm: 300 });
    expect(report.pass).toBe(false);
    expect(report.minimumWidthMm).toBeNull();
    expect(report.recognition).toBeNull();
    expect(report.score).toBeLessThan(60);
    expect(report.reasons.join(" ")).toMatch(/never put in front of the recogniser/);
  });

  it("moves the width up to the first size the recogniser confirms, and says which", () => {
    const asked: number[] = [];
    // Found with plenty only once the mark is at least 400 pixels across.
    const report = buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return pixelsAcross >= 400 ? { found: true, inliers: 60 } : { found: true, inliers: 12 };
      },
    });
    const unconfirmed = buildReport({ image, levels, scanDistanceMm: 300, recognises: FOUND_EVERYWHERE });

    expect(report.pass).toBe(true);
    expect(asked.length).toBeGreaterThan(1);
    expect(asked).toEqual([...asked].sort((a, b) => a - b));
    expect(report.recognition?.pixelsAcross).toBeGreaterThanOrEqual(400);
    expect(report.recognition?.inliers).toBe(60);
    expect(report.minimumWidthMm ?? 0).toBeGreaterThan(unconfirmed.minimumWidthMm ?? 0);
    // The scale it carries is the one its width came from, so the pixel figure printed beside
    // the width is the one that was checked.
    expect(Math.round(report.smallestUsableScale * report.analysisWidth)).toBeGreaterThanOrEqual(400);
    expect(describeWidth(report)).toContain(`${report.minimumWidthMm} mm`);
  });

  it("refuses artwork the recogniser confirms at no size, and says the most it found", () => {
    const report = buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: () => ({ found: true, inliers: 13 }),
    });
    expect(report.pass).toBe(false);
    expect(report.minimumWidthMm).toBeNull();
    expect(report.score).toBeLessThan(60);
    expect(report.recognition?.inliers).toBe(13);
    expect(report.reasons.join(" ")).toMatch(/most it found was 13/);
  });

  it("counts a pose that was not found as nothing agreeing, whatever count came with it", () => {
    const report = buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: () => ({ found: false, inliers: 500 }),
    });
    expect(report.pass).toBe(false);
    expect(report.recognition?.inliers).toBe(0);
  });

  it("stops searching at the first width no manifest can declare", () => {
    // At 5.2 metres the first size needs 4003 mm, which a manifest can carry, and the next
    // needs more than 5000, which it cannot. Refused at the first, the search has to stop
    // there rather than go on asking about widths nobody can print.
    const asked: number[] = [];
    const report = buildReport({
      image,
      levels,
      scanDistanceMm: 5200,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return { found: true, inliers: 5 };
      },
    });
    expect(report.pass).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it("is not asked about widths no manifest can declare", () => {
    const asked: number[] = [];
    // Ten metres needs more than five thousand millimetres at every size, so there is nothing
    // to confirm and the recogniser must not be run for a width nobody can print.
    const report = buildReport({
      image,
      levels,
      scanDistanceMm: 10_000,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return { found: true, inliers: 99 };
      },
    });
    expect(report.pass).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("what a caller may hand the report", () => {
  it("refuses a level whose scale is not a fraction of the artwork", () => {
    // A scale of zero printed "0 mm", minus one printed a negative width, and NaN was written
    // to the target file as null, which the bundler read as nothing to compare.
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(
        () =>
          buildReport({
            image: { width: 640, height: 640 },
            levels: [
              { scale: 1, corners: lattice(40, 640) },
              { scale, corners: lattice(40, 640) },
            ],
            scanDistanceMm: 190,
            recognises: FOUND_EVERYWHERE,
          }),
        `a scale of ${scale} was accepted`,
      ).toThrow(RangeError);
    }
  });

  it("calls repetition unmeasured when there was nothing to measure", () => {
    // An empty list read as 0, so a checkerboard with no usable features printed "0% of
    // features have a look-alike, which is normal".
    const report = buildReport({
      image: { width: 640, height: 640 },
      levels: [{ scale: 1, corners: [] }],
      described: [],
      scanDistanceMm: 190,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.repetition).toBeNull();
  });
});

describe("what a stored report has to hold before it is trusted", () => {
  const current = () =>
    buildReport({
      image: { width: 640, height: 640 },
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 190,
      recognises: FOUND_EVERYWHERE,
    });

  it("trusts a report this build writes, through JSON as it is stored", () => {
    expect(isCurrentReport(JSON.parse(JSON.stringify(current())))).toBe(true);
  });

  it("does not trust the fields one at a time", () => {
    const report = JSON.parse(JSON.stringify(current()));
    // A distance and nothing else was enough for the old guard, and its type said Report.
    expect(carriesItsDistance({ scanDistanceMm: 190 })).toBe(true);
    expect(isCurrentReport({ scanDistanceMm: 190 })).toBe(false);
    for (const [label, broken] of [
      ["no recognition at all", { ...report, recognition: undefined }],
      [
        "a pass the recogniser did not agree with",
        { ...report, recognition: { ...report.recognition, inliers: 3 } },
      ],
      ["a pass with no width", { ...report, minimumWidthMm: null }],
      ["a width that is not a number", { ...report, minimumWidthMm: "147" }],
      ["a negative width", { ...report, minimumWidthMm: -615 }],
      ["a failure that names a width", { ...report, pass: false }],
      ["a verdict that is not a boolean", { ...report, pass: "yes" }],
      ["a distance nobody could hold", { ...report, scanDistanceMm: -5 }],
    ] as const) {
      expect(isCurrentReport(broken), label).toBe(false);
    }
  });

  it("works an old report's distance back out, and answers a current one with its own", () => {
    // The documented case: the old build's 70 mm over 320 px was computed at 350 mm.
    expect(distanceBehind({ minimumWidthMm: 70, smallestUsableScale: 0.5, analysisWidth: 640 })).toBe(350);
    // A current report computed at 190 mm. The old arithmetic over its width gives 735.
    expect(distanceBehind(JSON.parse(JSON.stringify(current())))).toBe(190);
    expect(distanceBehind({ minimumWidthMm: "70", smallestUsableScale: 0.5, analysisWidth: 640 })).toBeNull();
  });
});

/** An evenly spaced grid of features, so the spacing under test is the only variable. */
function lattice(spacing: number, size: number): Corner[] {
  const corners: Corner[] = [];
  for (let y = spacing; y < size; y += spacing) {
    for (let x = spacing; x < size; x += spacing) corners.push({ x, y, strength: 1000 });
  }
  return corners;
}

import type { Corner } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import { buildReport, describeWidth } from "../src/report.js";

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
    });
    expect(report.pass).toBe(false);
    expect(report.reasons).toContain("too few features to track reliably");
  });

  it("passes artwork with plenty of well spread corners", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 400,
    });
    expect(report.pass).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("scores from 0 to 100", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 400,
    });
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("requires a larger print for a longer scan distance", () => {
    const near = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 300,
    });
    const far = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 900,
    });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan(near.minimumWidthMm ?? 0);
  });

  it("flags artwork whose features crowd one part of the image", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 60) }],
      scanDistanceMm: 400,
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
    });
    const described = describeWidth(report, 400);
    expect(described).toContain("400 mm away");
    expect(described).toContain("px across the artwork");
    expect(report.analysisWidth).toBe(640);
  });

  /**
   * Artwork whose detail survives only at or near full size cannot be read at any distance,
   * because the print would have to be wider than the whole picture to put enough pixels
   * across itself. A width printed here would name a size that does not work.
   */
  it("refuses a width when no print size could ever carry enough pixels", () => {
    const image = { width: 640, height: 640 };
    const onlyAtFullSize = buildReport({
      image,
      levels: [
        { scale: 1, corners: lattice(40, 640) },
        { scale: 0.79, corners: lattice(400, 640) },
      ],
      scanDistanceMm: 400,
    });
    expect(onlyAtFullSize.minimumWidthMm).toBeNull();
    expect(onlyAtFullSize.pass).toBe(false);
    expect(onlyAtFullSize.reasons.join(" ")).toMatch(/more than the whole picture/);
    // And it says so rather than printing a number a printer could act on.
    expect(describeWidth(onlyAtFullSize, 400)).toBe("not printable until the artwork passes");
  });

  it("scales the width with the scan distance, because a camera further away sees less", () => {
    const image = { width: 640, height: 640 };
    const levels = [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) }));
    const near = buildReport({ image, levels, scanDistanceMm: 300 });
    const far = buildReport({ image, levels, scanDistanceMm: 900 });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan((near.minimumWidthMm ?? 0) * 2);
  });

  it("never prints a passing verdict under a failing score, or the reverse", () => {
    const image = { width: 1000, height: 1000 };
    for (const spacing of [10, 18, 25, 40, 70, 120, 300]) {
      const report = buildReport({
        image,
        levels: [{ scale: 1, corners: lattice(spacing, 1000) }],
        scanDistanceMm: 400,
      });
      expect(report.pass).toBe(report.score >= 60);
    }
  });

  it("does not tell someone with no features that they are concentrated", () => {
    const report = buildReport({
      image: { width: 500, height: 500 },
      levels: [{ scale: 1, corners: [] }],
      scanDistanceMm: 400,
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
    });
    expect(report.areasWithFeatures).toBeLessThanOrEqual(report.areas);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
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

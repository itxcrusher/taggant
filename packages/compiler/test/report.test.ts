import type { Corner } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import { buildReport } from "../src/report.js";

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
      corners: corners(4),
      scanDistanceMm: 400,
    });
    expect(report.pass).toBe(false);
    expect(report.reasons).toContain("too few features to track reliably");
  });

  it("passes artwork with plenty of well spread corners", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      corners: corners(300, 400),
      scanDistanceMm: 400,
    });
    expect(report.pass).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("scores from 0 to 100", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      corners: corners(300, 400),
      scanDistanceMm: 400,
    });
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("requires a larger print for a longer scan distance", () => {
    const near = buildReport({
      image: { width: 400, height: 400 },
      corners: corners(300, 400),
      scanDistanceMm: 300,
    });
    const far = buildReport({
      image: { width: 400, height: 400 },
      corners: corners(300, 400),
      scanDistanceMm: 900,
    });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan(near.minimumWidthMm ?? 0);
  });

  it("flags artwork whose features crowd one part of the image", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      corners: corners(300, 60),
      scanDistanceMm: 400,
    });
    expect(report.reasons).toContain("features are concentrated in part of the artwork");
  });
});

describe("buildReport input validation", () => {
  it("refuses a scan distance that is not a positive finite number", () => {
    for (const bad of [0, -400, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildReport({ image: { width: 400, height: 400 }, corners: corners(10), scanDistanceMm: bad }),
      ).toThrow(/scan distance/i);
    }
  });

  it("refuses an image with no area, rather than reporting on it", () => {
    expect(() =>
      buildReport({ image: { width: 0, height: 0 }, corners: corners(10), scanDistanceMm: 400 }),
    ).toThrow(/image/i);
  });
});

describe("the numbers a printer acts on", () => {
  it("gives fine artwork a larger minimum print width than bold artwork", () => {
    const image = { width: 1000, height: 1000 };
    const fine = buildReport({ image, corners: lattice(20, 1000), scanDistanceMm: 400 });
    const bold = buildReport({ image, corners: lattice(120, 1000), scanDistanceMm: 400 });
    expect(fine.minimumWidthMm ?? 0).toBeGreaterThan((bold.minimumWidthMm ?? 0) * 2);
  });

  it("does not report a print width for artwork with nothing to track", () => {
    const report = buildReport({ image: { width: 500, height: 500 }, corners: [], scanDistanceMm: 400 });
    expect(report.minimumWidthMm).toBeNull();
    expect(report.detail).toBeNull();
  });

  it("changes the print width when the artwork changes, not only when the flag does", () => {
    const image = { width: 1000, height: 1000 };
    const a = buildReport({ image, corners: lattice(25, 1000), scanDistanceMm: 400 });
    const b = buildReport({ image, corners: lattice(50, 1000), scanDistanceMm: 400 });
    expect(a.minimumWidthMm).not.toBe(b.minimumWidthMm);
  });

  it("never prints a passing verdict under a failing score, or the reverse", () => {
    const image = { width: 1000, height: 1000 };
    for (const spacing of [10, 18, 25, 40, 70, 120, 300]) {
      const report = buildReport({ image, corners: lattice(spacing, 1000), scanDistanceMm: 400 });
      expect(report.pass).toBe(report.score >= 60);
    }
  });

  it("does not tell someone with no features that they are concentrated", () => {
    const report = buildReport({ image: { width: 500, height: 500 }, corners: [], scanDistanceMm: 400 });
    expect(report.reasons).toEqual(["too few features to track reliably"]);
  });

  it("keeps the area count inside the grid even for coordinates it did not produce", () => {
    const report = buildReport({
      image: { width: 400, height: 400 },
      corners: [
        { x: -900, y: -900, strength: 1 },
        { x: 9000, y: 9000, strength: 1 },
        { x: 200, y: 200, strength: 1 },
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

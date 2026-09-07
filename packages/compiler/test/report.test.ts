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
    expect(far.minimumWidthMm).toBeGreaterThan(near.minimumWidthMm);
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

  it("refuses an image with no area, rather than reporting coverage for it", () => {
    expect(() =>
      buildReport({ image: { width: 0, height: 0 }, corners: corners(10), scanDistanceMm: 400 }),
    ).toThrow(/image/i);
  });
});

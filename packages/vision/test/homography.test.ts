import { describe, expect, it } from "vitest";
import {
  type Correspondence,
  type Homography,
  applyHomography,
  estimateHomography,
  homographyFrom,
} from "../src/homography.js";

/** A perspective mapping with translation, scale, rotation and real foreshortening. */
const KNOWN: Homography = Float64Array.from([0.9, -0.35, 120, 0.28, 1.1, -40, 0.0004, 0.0002, 1]);

function corresponding(points: Array<[number, number]>, h: Homography = KNOWN): Correspondence[] {
  return points.map(([x, y]) => {
    const [toX, toY] = applyHomography(h, x, y);
    return { fromX: x, fromY: y, toX, toY };
  });
}

function grid(count: number, size = 400): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let seed = 12345;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const x = (seed % size) + 5;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const y = (seed % size) + 5;
    points.push([x, y]);
  }
  return points;
}

/** Largest distance between where the fit puts a point and where the truth puts it. */
function worstError(fitted: Homography, points: Array<[number, number]>): number {
  let worst = 0;
  for (const [x, y] of points) {
    const [ax, ay] = applyHomography(fitted, x, y);
    const [bx, by] = applyHomography(KNOWN, x, y);
    worst = Math.max(worst, Math.hypot(ax - bx, ay - by));
  }
  return worst;
}

describe("homographyFrom", () => {
  it("recovers a known mapping from exactly four clean correspondences", () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [400, 0],
      [400, 300],
      [0, 300],
    ];
    const fitted = homographyFrom(corresponding(corners));
    if (!fitted) throw new Error("expected a fit");
    expect(worstError(fitted, corners)).toBeLessThan(1e-6);
  });

  it("refuses fewer than four correspondences, which have no unique answer", () => {
    expect(
      homographyFrom(
        corresponding([
          [0, 0],
          [100, 0],
          [0, 100],
        ]),
      ),
    ).toBeNull();
  });

  it("refuses collinear points, which describe a line rather than a plane", () => {
    const line: Array<[number, number]> = [
      [0, 0],
      [100, 100],
      [200, 200],
      [300, 300],
    ];
    expect(homographyFrom(corresponding(line))).toBeNull();
  });

  it("fits a mapping through many points at once", () => {
    const points = grid(30);
    const fitted = homographyFrom(corresponding(points));
    if (!fitted) throw new Error("expected a fit");
    expect(worstError(fitted, points)).toBeLessThan(1e-6);
  });
});

describe("estimateHomography", () => {
  it("recovers the mapping when two correspondences in five are wrong", () => {
    const points = grid(50);
    const pairs = corresponding(points);
    let seed = 999;
    for (let i = 0; i < pairs.length; i += 5) {
      const pair = pairs[i];
      if (!pair) continue;
      seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
      pair.toX = seed % 640;
      seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
      pair.toY = seed % 480;
    }
    const result = estimateHomography(pairs);
    if (!result) throw new Error("expected an estimate");
    expect(result.inliers.length).toBeGreaterThanOrEqual(38);
    expect(worstError(result.homography, points)).toBeLessThan(1);
  });

  it("survives correspondences that are two fifths nonsense", () => {
    const points = grid(60);
    const pairs = corresponding(points);
    let seed = 4242;
    for (let i = 0; i < pairs.length; i++) {
      if (i % 5 >= 3) {
        const pair = pairs[i];
        if (!pair) continue;
        seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
        pair.toX = seed % 640;
        seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
        pair.toY = seed % 480;
      }
    }
    const result = estimateHomography(pairs);
    if (!result) throw new Error("expected an estimate");
    expect(result.inliers.length).toBeGreaterThanOrEqual(30);
    expect(worstError(result.homography, points)).toBeLessThan(2);
  });

  it("returns null with fewer than four correspondences", () => {
    expect(
      estimateHomography(
        corresponding([
          [0, 0],
          [10, 10],
          [20, 5],
        ]),
      ),
    ).toBeNull();
  });

  it("gives the same answer twice, so a failing frame can be replayed", () => {
    const pairs = corresponding(grid(40));
    const a = estimateHomography(pairs);
    const b = estimateHomography(pairs);
    expect([...(a?.homography ?? [])]).toEqual([...(b?.homography ?? [])]);
  });
});

describe("applyHomography", () => {
  it("returns not a number rather than infinity for a point on the horizon", () => {
    const degenerate = Float64Array.from([1, 0, 0, 0, 1, 0, 1, 0, 0]);
    const [x, y] = applyHomography(degenerate, 0, 5);
    expect(Number.isNaN(x)).toBe(true);
    expect(Number.isNaN(y)).toBe(true);
  });
});

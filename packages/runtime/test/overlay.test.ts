import { type Homography, applyHomography } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import { cssMatrixFor } from "../src/overlay.js";

/** Read the sixteen numbers back out of the CSS function. */
function parse(matrix: string): number[] {
  const inside = matrix.slice("matrix3d(".length, -1);
  return inside.split(",").map((part) => Number(part.trim()));
}

/**
 * Apply a CSS matrix3d to a point on the z = 0 plane, exactly as a browser would: column
 * major, then divide through by w.
 */
function project(matrix: string, x: number, y: number): [number, number] {
  const m = parse(matrix);
  const at = (index: number) => m[index] ?? 0;
  const w = at(3) * x + at(7) * y + at(15);
  return [(at(0) * x + at(4) * y + at(12)) / w, (at(1) * x + at(5) * y + at(13)) / w];
}

const POSE: Homography = Float64Array.from([0.86, -0.12, 150, 0.1, 0.92, 70, 0.00028, 0.00012, 1]);
const CORNERS: Array<[number, number]> = [
  [0, 0],
  [320, 0],
  [320, 240],
  [0, 240],
];

describe("cssMatrixFor", () => {
  it("puts the artwork's corners where the pose puts them", () => {
    const matrix = cssMatrixFor(POSE, { width: 640, height: 480 }, { width: 640, height: 480 });
    for (const [x, y] of CORNERS) {
      const [ax, ay] = project(matrix, x, y);
      const [bx, by] = applyHomography(POSE, x, y);
      expect(ax).toBeCloseTo(bx, 3);
      expect(ay).toBeCloseTo(by, 3);
    }
  });

  it("scales from the size the frame was tracked at to the size it is shown at", () => {
    const matrix = cssMatrixFor(POSE, { width: 640, height: 480 }, { width: 1280, height: 960 });
    for (const [x, y] of CORNERS) {
      const [ax, ay] = project(matrix, x, y);
      const [bx, by] = applyHomography(POSE, x, y);
      expect(ax).toBeCloseTo(bx * 2, 3);
      expect(ay).toBeCloseTo(by * 2, 3);
    }
  });

  it("handles a display that is not the same shape as the processed frame", () => {
    const matrix = cssMatrixFor(POSE, { width: 640, height: 480 }, { width: 640, height: 960 });
    const [x, y] = project(matrix, 320, 240);
    const [bx, by] = applyHomography(POSE, 320, 240);
    expect(x).toBeCloseTo(bx, 3);
    expect(y).toBeCloseTo(by * 2, 3);
  });

  it("is a CSS function a browser will accept", () => {
    const matrix = cssMatrixFor(POSE, { width: 640, height: 480 }, { width: 640, height: 480 });
    expect(matrix).toMatch(/^matrix3d\((-?[\d.]+, ){15}-?[\d.]+\)$/);
  });

  it("refuses a processed size that cannot have produced a pose", () => {
    expect(() => cssMatrixFor(POSE, { width: 0, height: 0 }, { width: 640, height: 480 })).toThrow(
      /positive size/,
    );
  });
});

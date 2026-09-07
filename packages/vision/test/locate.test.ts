import { describe, expect, it } from "vitest";
import { type Homography, applyHomography } from "../src/homography.js";
import type { GrayscaleImage } from "../src/image.js";
import { type TrackingTarget, locate } from "../src/locate.js";
import { buildTrackingFeatures } from "../src/target.js";
import { blur, transform, warp } from "./warp.js";

/**
 * Stand-in artwork: irregular enough that corners are distinguishable, which is the same
 * property the print readiness report exists to measure on real artwork.
 */
function artwork(width = 320, height = 240): GrayscaleImage {
  const data = new Uint8Array(width * height);
  let seed = 20260907;
  const blot = (cx: number, cy: number, r: number, value: number) => {
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data[y * width + x] = value;
      }
    }
  };
  for (let i = 0; i < data.length; i++) data[i] = 210;
  for (let i = 0; i < 90; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % width;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % height;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    blot(cx, cy, 4 + (seed % 11), seed % 2 === 0 ? 25 : 120);
  }
  return { width, height, data };
}

function compile(image: GrayscaleImage): TrackingTarget {
  return {
    id: "fixture",
    width: image.width,
    height: image.height,
    features: buildTrackingFeatures(image),
  };
}

/** How far the recovered pose puts the artwork's own corners from where the truth puts them. */
function cornerError(recovered: Homography, truth: Homography, target: TrackingTarget): number {
  const corners: Array<[number, number]> = [
    [0, 0],
    [target.width, 0],
    [target.width, target.height],
    [0, target.height],
  ];
  let worst = 0;
  for (const [x, y] of corners) {
    const [ax, ay] = applyHomography(recovered, x, y);
    const [bx, by] = applyHomography(truth, x, y);
    worst = Math.max(worst, Math.hypot(ax - bx, ay - by));
  }
  return worst;
}

const source = artwork();
const target = compile(source);

describe("locate", () => {
  it("has enough describable features in the fixture to be a fair test", () => {
    expect(target.features.length).toBeGreaterThan(60);
  });

  it("finds artwork in a plain view of it and says where it is", () => {
    const truth = transform({ translateX: 120, translateY: 90 });
    const frame = warp(source, truth, 640, 480);
    const result = locate(frame, target);
    expect(result.found).toBe(true);
    if (!result.homography) throw new Error("expected a pose");
    expect(cornerError(result.homography, truth, target)).toBeLessThan(4);
  });

  it("finds it turned on its side", () => {
    const truth = transform({ rotationDeg: 90, translateX: 500, translateY: 60 });
    const frame = warp(source, truth, 640, 480);
    const result = locate(frame, target);
    expect(result.found).toBe(true);
    if (!result.homography) throw new Error("expected a pose");
    expect(cornerError(result.homography, truth, target)).toBeLessThan(6);
  });

  it("finds it held at an angle, with real foreshortening", () => {
    const truth = Float64Array.from([0.86, -0.12, 150, 0.1, 0.92, 70, 0.00028, 0.00012, 1]);
    const frame = warp(source, truth, 640, 480);
    const result = locate(frame, target);
    expect(result.found).toBe(true);
    if (!result.homography) throw new Error("expected a pose");
    expect(cornerError(result.homography, truth, target)).toBeLessThan(8);
  });

  it("finds it at half the size it was compiled at, which is the point of the scale levels", () => {
    const truth = transform({ scale: 0.5, translateX: 200, translateY: 150 });
    const frame = warp(source, truth, 640, 480);
    const result = locate(frame, target);
    expect(result.found).toBe(true);
    if (!result.homography) throw new Error("expected a pose");
    expect(cornerError(result.homography, truth, target)).toBeLessThan(4);
  });

  it("loses artwork described at one size only, which is why the target carries several", () => {
    const single: TrackingTarget = {
      id: "single",
      width: source.width,
      height: source.height,
      features: buildTrackingFeatures(source, { scales: [1] }),
    };
    const frame = warp(source, transform({ scale: 0.5, translateX: 200, translateY: 150 }), 640, 480);
    expect(locate(frame, single).found).toBe(false);
  });

  it("finds it in a frame that is out of focus, which every real frame is", () => {
    const truth = transform({ rotationDeg: 8, translateX: 140, translateY: 100 });
    const frame = blur(warp(source, truth, 640, 480));
    const result = locate(frame, target);
    expect(result.found).toBe(true);
    if (!result.homography) throw new Error("expected a pose");
    expect(cornerError(result.homography, truth, target)).toBeLessThan(6);
  });

  it("reports not found for a frame of something else", () => {
    const other = artwork(320, 240);
    other.data.reverse();
    const frame = warp(other, transform({ translateX: 100, translateY: 80 }), 640, 480);
    const result = locate(frame, compile(artwork(300, 220)));
    expect(result.found).toBe(false);
  });

  it("reports not found for a blank frame", () => {
    const blank: GrayscaleImage = { width: 640, height: 480, data: new Uint8Array(640 * 480).fill(128) };
    expect(locate(blank, target).found).toBe(false);
  });

  it("reports not found for a frame with no area", () => {
    expect(locate({ width: 0, height: 0, data: new Uint8Array(0) }, target).found).toBe(false);
  });

  it("reports not found for a target with no features", () => {
    const empty: TrackingTarget = { id: "empty", width: 100, height: 100, features: [] };
    const frame = warp(source, transform({ translateX: 100, translateY: 80 }), 640, 480);
    expect(locate(frame, empty).found).toBe(false);
  });
});

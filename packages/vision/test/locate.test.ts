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
function artwork(width = 320, height = 240, from = 20260907): GrayscaleImage {
  const data = new Uint8Array(width * height);
  let seed = from;
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

  it("hands out a fresh not-found result, so writing to one cannot change the next", () => {
    // One object was shared by every not-found call. A caller that set `found` on it made
    // every later miss report found, with a null pose, past the inlier floor entirely.
    const blank: GrayscaleImage = { width: 640, height: 480, data: new Uint8Array(640 * 480).fill(128) };
    const first = locate(blank, target);
    first.found = true;
    first.inliers = 99;
    const second = locate(blank, target);
    expect(second.found).toBe(false);
    expect(second.inliers).toBe(0);
    expect(second).not.toBe(first);
  });

  it("finds the same pose on the second frame as the first, now the target's tables are kept", () => {
    // The target's packed descriptors and shared-spot table are worked out once per target and
    // reused. Reuse must not change an answer: the same frame twice gives the same result.
    const frame = warp(source, transform({ translateX: 140, translateY: 90, rotationDeg: 12 }), 640, 480);
    const fresh = compile(source);
    const once = locate(frame, fresh);
    const twice = locate(frame, fresh);
    expect(once.found).toBe(true);
    expect(twice.inliers).toBe(once.inliers);
    expect(twice.matches).toBe(once.matches);
    expect(Array.from(twice.homography ?? [])).toEqual(Array.from(once.homography ?? []));
  });

  it("finds a target whose features were reordered after it was first located against", () => {
    // The kept copy indexed one order and the pose was fitted from the live features in
    // another: 6 points instead of 58, and not found.
    const frame = warp(source, transform({ translateX: 140, translateY: 90, rotationDeg: 12 }), 640, 480);
    const reused = compile(source);
    const before = locate(frame, reused);
    expect(before.found).toBe(true);
    reused.features.reverse();
    const after = locate(frame, reused);
    expect(after.found, `${after.inliers} points after the reorder against ${before.inliers} before`).toBe(
      true,
    );
    expect(after.inliers).toBe(before.inliers);
  });

  it("locates against what a target holds now, when its features are replaced in place", () => {
    // What matching needs is kept per target object. Trusted once made, a target whose list
    // was refilled with another artwork's features went on being found as the first artwork.
    const frame = warp(source, transform({ translateX: 140, translateY: 90, rotationDeg: 12 }), 640, 480);
    const reused = compile(source);
    expect(locate(frame, reused).found).toBe(true);
    const other = compile(artwork(320, 240, 4242));
    reused.features.splice(0, reused.features.length, ...other.features);
    expect(locate(frame, reused).found, "found as the artwork it no longer holds").toBe(false);
  });

  it("reports not found for a frame of one pixel, rather than throwing", () => {
    // The frame is described at 0.79 as well as at full size, and 0.79 of one pixel is not an
    // image: the resample threw where a frame with no area returned not found.
    expect(locate({ width: 1, height: 1, data: new Uint8Array(1) }, target).found).toBe(false);
    expect(locate({ width: 3, height: 2, data: new Uint8Array(6) }, target).found).toBe(false);
  });
});

describe("buildTrackingFeatures", () => {
  it("finds nothing in an image too small to describe, rather than throwing", () => {
    expect(buildTrackingFeatures({ width: 0, height: 0, data: new Uint8Array(0) })).toEqual([]);
    expect(buildTrackingFeatures({ width: 1, height: 1, data: new Uint8Array(1) })).toEqual([]);
    expect(buildTrackingFeatures({ width: 20, height: 20, data: new Uint8Array(400).fill(90) })).toEqual([]);
  });
});

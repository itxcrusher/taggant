import { describe, expect, it } from "vitest";
import type { GrayscaleImage } from "../src/image.js";
import { locate } from "../src/locate.js";
import { fromTargetFile, toTargetFile } from "../src/serialise.js";
import { buildTrackingFeatures } from "../src/target.js";
import { transform, warp } from "./warp.js";

function artwork(width = 320, height = 240): GrayscaleImage {
  const data = new Uint8Array(width * height).fill(210);
  let seed = 20260907;
  for (let i = 0; i < 90; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % width;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % height;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const r = 4 + (seed % 11);
    const value = seed % 2 === 0 ? 25 : 120;
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) data[y * width + x] = value;
      }
    }
  }
  return { width, height, data };
}

const source = artwork();
const built = {
  id: "postcard",
  width: source.width,
  height: source.height,
  features: buildTrackingFeatures(source),
};

describe("the target file", () => {
  it("survives a round trip through JSON, which typed arrays do not", () => {
    const parsed = fromTargetFile(JSON.parse(JSON.stringify(toTargetFile(built))));
    expect(parsed.features.length).toBe(built.features.length);
    const first = parsed.features[0];
    expect(first?.descriptor).toBeInstanceOf(Uint32Array);
    expect([...(first?.descriptor ?? [])]).toEqual([...(built.features[0]?.descriptor ?? [])]);
  });

  it("still finds the artwork after being written and read back", () => {
    const truth = transform({ rotationDeg: 12, translateX: 150, translateY: 100 });
    const frame = warp(source, truth, 640, 480);
    const parsed = fromTargetFile(JSON.parse(JSON.stringify(toTargetFile(built))));
    expect(locate(frame, parsed).found).toBe(true);
  });

  it("refuses a format it does not know rather than guessing", () => {
    const file = toTargetFile(built) as unknown as Record<string, unknown>;
    file.formatVersion = 1;
    expect(() => fromTargetFile(file)).toThrow(/format 1 is not supported/i);
  });

  it("refuses a feature whose descriptor is the wrong length", () => {
    const file = JSON.parse(JSON.stringify(toTargetFile(built)));
    file.features[0].descriptor = [1, 2, 3];
    expect(() => fromTargetFile(file)).toThrow(/eight word descriptor/i);
  });

  it("refuses something that is not a target file at all", () => {
    expect(() => fromTargetFile(null)).toThrow(/must be an object/i);
    expect(() => fromTargetFile("target")).toThrow(/must be an object/i);
    expect(() => fromTargetFile({ formatVersion: 2 })).toThrow(/missing an id/i);
  });

  it("refuses an empty id, which every published bundle uses as a file name", () => {
    expect(() => fromTargetFile({ ...toTargetFile(built), id: "" })).toThrow(/missing an id/);
  });

  it("refuses a feature outside the artwork it declares", () => {
    // The width and height were validated and then bound nothing, so a feature at x 1e308
    // read as part of a 320 pixel artwork and a pose was fitted to it.
    const file = toTargetFile(built);
    const first = file.features[0];
    if (!first) throw new Error("the fixture has no features");
    for (const [label, moved] of [
      ["far to the right", { ...first, x: 1e308 }],
      ["to the left of it", { ...first, x: -1 }],
      ["below it", { ...first, y: built.height + 5 }],
    ] as const) {
      expect(() => fromTargetFile({ ...file, features: [moved, ...file.features.slice(1)] }), label).toThrow(
        /outside the/,
      );
    }
  });

  it("says which version it was given, in a way that cannot read as the version it wants", () => {
    // The string "2" read "format 2 is not supported, expected 2".
    expect(() => fromTargetFile({ ...toTargetFile(built), formatVersion: "2" })).toThrow(/format "2" is not/);
  });
});

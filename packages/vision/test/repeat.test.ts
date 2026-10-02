import { describe, expect, it } from "vitest";
import type { GrayscaleImage } from "../src/image.js";
import { measureRepetition } from "../src/repeat.js";
import { type TargetFeature, buildTrackingFeatures } from "../src/target.js";

/** Irregular stand-in artwork, the same kind the locate tests use. */
function artwork(width = 320, height = 240, from = 20261002): GrayscaleImage {
  const data = new Uint8Array(width * height).fill(210);
  let seed = from;
  const blot = (cx: number, cy: number, r: number, value: number) => {
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= cx - r / 2) data[y * width + x] = value;
      }
    }
  };
  for (let i = 0; i < 110; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % width;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % height;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    blot(cx, cy, 5 + (seed % 12), seed % 2 === 0 ? 25 : 120);
  }
  return { width, height, data };
}

/** Two images side by side. */
function beside(left: GrayscaleImage, right: GrayscaleImage): GrayscaleImage {
  const width = left.width + right.width;
  const height = Math.max(left.height, right.height);
  const data = new Uint8Array(width * height).fill(210);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < left.width; x++) data[y * width + x] = left.data[y * left.width + x] ?? 210;
    for (let x = 0; x < right.width; x++)
      data[y * width + left.width + x] = right.data[y * right.width + x] ?? 210;
  }
  return { width, height, data };
}

/** The image turned half way round, which is exact on a pixel grid. */
function halfTurn(image: GrayscaleImage): GrayscaleImage {
  return { width: image.width, height: image.height, data: Uint8Array.from(image.data).reverse() };
}

const one = artwork();
const twice = beside(one, one);
const twiceFeatures = buildTrackingFeatures(twice);
const measure = (
  image: GrayscaleImage,
  features = buildTrackingFeatures(image),
  farEnough = 0.1 * image.width,
) => measureRepetition(features, image, { farEnough });

describe("measureRepetition", () => {
  it("finds a design printed twice, and the shift from one copy to the other", () => {
    const alone = measure(one);
    const both = measure(twice, twiceFeatures);
    // The copies sit half the sheet apart, side by side, upright and at one size.
    expect(both.places).toBeGreaterThanOrEqual(60);
    expect(both.places).toBeGreaterThan(alone.places * 5);
    expect(Math.abs(both.move?.across ?? 0)).toBeCloseTo(0.5, 1);
    expect(Math.abs(both.move?.down ?? 1)).toBeLessThan(0.02);
    expect(Math.abs(both.move?.turnDegrees ?? 90)).toBeLessThan(3);
    expect(both.move?.scale ?? 0).toBeCloseTo(1, 1);
    // One move carries one copy onto the other, so it can carry at most about half the places.
    expect(both.places).toBeLessThanOrEqual(both.of * 0.55);
    expect(alone.places).toBeLessThan(15);
  });

  it("finds a copy turned half way round, which a sheet laid out for cutting has", () => {
    const pair = beside(one, halfTurn(one));
    const measured = measure(pair);
    expect(measured.places).toBeGreaterThanOrEqual(60);
    expect(Math.abs(measured.move?.turnDegrees ?? 0)).toBeGreaterThan(170);
  });

  it("does not count a move that leaves every corner nearer than the line", () => {
    // The copies are 320 px apart. With the line at half that the shift counts; at half as much
    // again it is the artwork drawn a little off, as far as this is concerned, and nothing does.
    // Not tested at the line itself: a move fitted to a copy's features is a few per cent out
    // in size, and at 330 px a move scaled by 1.026 reached a corner 340 px away and counted.
    expect(measure(twice, twiceFeatures, 160).places).toBeGreaterThanOrEqual(60);
    expect(measure(twice, twiceFeatures, 480).places).toBeLessThan(15);
  });

  it("holds each pair to the move's turn, not only to where it lands", () => {
    // Every feature on the right copy is told it faces a quarter turn away, apart from a few, so
    // the shift between the copies is still proposed and every pair lands where it says. Only the
    // turn says those pairs are not carried by a shift.
    let kept = 0;
    const turned = twiceFeatures.map((feature) => {
      if (feature.x < one.width) return feature;
      if (kept++ < 4) return feature;
      return { ...feature, angle: feature.angle + Math.PI / 2 };
    });
    expect(measure(twice, twiceFeatures).places).toBeGreaterThanOrEqual(60);
    expect(measure(twice, turned).places).toBeLessThan(20);
  });

  it("holds each pair to the move's change of size, larger and smaller", () => {
    // The same with the size each feature was found at: half of the right copy told it was found
    // at half the size and half at twice, so a shift lands every pair and should carry none.
    let kept = 0;
    let flip = false;
    const resized = twiceFeatures.map((feature) => {
      if (feature.x < one.width) return feature;
      if (kept++ < 4) return feature;
      flip = !flip;
      return { ...feature, scale: flip ? feature.scale / 2 : feature.scale * 2 };
    });
    expect(measure(twice, resized).places).toBeLessThan(20);
  });

  it("counts a corner found at several sizes once", () => {
    // Every level holds the same corners again, a pixel or two apart in the artwork's own
    // coordinates, and counting each would let one corner stand for four.
    const measured = measure(twice, twiceFeatures);
    const atOneSize = measure(
      twice,
      twiceFeatures.filter((feature) => feature.scale === 1),
    );
    expect(measured.of).toBeLessThan(twiceFeatures.length);
    expect(measured.places).toBeLessThanOrEqual(measured.of);
    expect(atOneSize.places).toBeGreaterThan(0);
  });

  it("gives the same answer every time for the same features", () => {
    expect(measure(twice, twiceFeatures)).toEqual(measure(twice, twiceFeatures));
  });

  it("steps over holes and features it cannot read rather than throwing", () => {
    const clean = measure(twice, twiceFeatures);
    const damaged: TargetFeature[] = [...twiceFeatures];
    damaged.length += 3;
    damaged.push(undefined as unknown as TargetFeature);
    damaged.push({ ...(twiceFeatures[0] as TargetFeature), x: Number.NaN });
    damaged.push({ ...(twiceFeatures[0] as TargetFeature), descriptor: new Uint32Array(4) });
    damaged.push({ ...(twiceFeatures[0] as TargetFeature), scale: 0 });
    expect(measure(twice, damaged)).toEqual(clean);
  });

  it("pairs only features that look alike by the matcher's own line", () => {
    // Copies a shift away whose descriptors differ by 90 bits are past the line a matcher
    // accepts at, 72, so they are not look-alikes and no move carries them; at 40 bits they are.
    const copies = (bitsChanged: number): TargetFeature[] => {
      let seed = 99;
      const next = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
        return seed;
      };
      const originals: TargetFeature[] = [];
      const shifted: TargetFeature[] = [];
      for (let i = 0; i < 80; i++) {
        const descriptor = new Uint32Array(8);
        for (let w = 0; w < 8; w++) descriptor[w] = (next() ^ (next() << 16)) >>> 0;
        const original = {
          x: 20 + (i % 10) * 25,
          y: 20 + Math.floor(i / 10) * 25,
          strength: 1,
          angle: 0.3,
          scale: 1,
          descriptor,
        };
        const changed = Uint32Array.from(descriptor);
        for (let bit = 0; bit < bitsChanged; bit++)
          changed[bit >> 5] = ((changed[bit >> 5] ?? 0) ^ (1 << (bit & 31))) >>> 0;
        originals.push(original);
        shifted.push({ ...original, x: original.x + 320, descriptor: changed });
      }
      return [...originals, ...shifted];
    };
    const size = { width: 640, height: 240 };
    expect(measureRepetition(copies(40), size, { farEnough: 64 }).places).toBeGreaterThanOrEqual(60);
    expect(measureRepetition(copies(90), size, { farEnough: 64 }).places).toBeLessThan(5);
  });

  it("pairs a feature with look-alikes elsewhere, not with itself found at other sizes", () => {
    // A target holds each corner at several sizes, a pixel or two apart and only a few bits
    // different, and those are nearer than any real look-alike. Paired with its own copies, a
    // feature's three places for look-alikes fill with itself and its twin a copy away is lost.
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
      return seed;
    };
    const flipped = (from: Uint32Array, bits: number) => {
      const out = Uint32Array.from(from);
      for (let bit = 0; bit < bits; bit++) out[bit >> 5] = ((out[bit >> 5] ?? 0) ^ (1 << (bit & 31))) >>> 0;
      return out;
    };
    const features: TargetFeature[] = [];
    for (let i = 0; i < 80; i++) {
      const descriptor = new Uint32Array(8);
      for (let w = 0; w < 8; w++) descriptor[w] = (next() ^ (next() << 16)) >>> 0;
      const at = { x: 20 + (i % 10) * 25, y: 20 + Math.floor(i / 10) * 25, strength: 1, angle: 0.3 };
      features.push({ ...at, scale: 1, descriptor });
      for (const scale of [0.79, 0.63, 0.5])
        features.push({ ...at, x: at.x + 1, scale, descriptor: flipped(descriptor, 4) });
      features.push({ ...at, x: at.x + 320, scale: 1, descriptor: flipped(descriptor, 30) });
    }
    expect(
      measureRepetition(features, { width: 640, height: 240 }, { farEnough: 64 }).places,
    ).toBeGreaterThanOrEqual(60);
  });

  it("says nothing repeats when there is nothing to pair", () => {
    expect(measure(one, [])).toEqual({ places: 0, of: 0, move: null });
    const single = [twiceFeatures[0] as TargetFeature];
    expect(measure(one, single)).toEqual({ places: 0, of: 1, move: null });
  });
});

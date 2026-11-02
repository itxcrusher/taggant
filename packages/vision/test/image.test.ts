import { describe, expect, it } from "vitest";
import { type GrayscaleImage, resample, sample, smooth } from "../src/image.js";

function image(width: number, height: number): GrayscaleImage {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 251;
  return { width, height, data };
}

describe("the image helpers", () => {
  it("refuses a scale that takes the image below one pixel, rather than smoothing for ever", () => {
    // The smoothing runs ceil(1 / scale) - 1 passes. A 64 by 48 image at the smallest positive
    // number never came back, and 1e-9 was about fifty days. Tested at a scale that is finite
    // without the guard, so deleting the guard fails this rather than hanging the whole run:
    // the first version of this test called the infinite case, and a loop that never yields
    // cannot be stopped by a test timeout.
    expect(() => resample(image(64, 48), 1 / 100)).toThrow(RangeError);
    expect(resample(image(64, 48), 1 / 64).width).toBe(1);
  });

  it("never hands back the caller's own image", () => {
    // At a scale of one, and when smoothing an image too small to smooth, the input itself
    // came back, so writing to the result wrote to it.
    for (const [label, input, run] of [
      ["resample at one", image(20, 10), (i: GrayscaleImage) => resample(i, 1)],
      ["smooth on two pixels", image(2, 1), (i: GrayscaleImage) => smooth(i)],
    ] as const) {
      const before = input.data[0];
      const out = run(input);
      expect(out, label).not.toBe(input);
      out.data[0] = ((before ?? 0) + 1) % 256;
      expect(input.data[0], label).toBe(before);
    }
  });

  it("samples a coordinate that is not a number as the first edge, not as nothing", () => {
    // Documented as clamped at the edges, and NaN came back as NaN, which a descriptor's
    // comparison read as false and left a bit clear without saying so.
    const picture = image(8, 8);
    expect(Number.isFinite(sample(picture, Number.NaN, 3))).toBe(true);
    expect(sample(picture, Number.NaN, Number.NaN)).toBe(sample(picture, 0, 0));
  });
});

import { describe, expect, it } from "vitest";
import { prepareAsset } from "../src/assets.js";

/**
 * The renderer runs in a process of its own, under a clock, because a document can hold it
 * and a document can crash it. Both were found by handing it filters: a dilate of radius
 * 500 units ran for four and a half minutes before the library's own timeout, which is
 * checked between steps rather than inside one, noticed at three percent; a convolution
 * matrix of order thirty took the process down with an illegal instruction. Either one, in
 * the process that publishes, is a console that stops answering. So these go through
 * `prepareAsset` with a short clock and must come back as refusals, in time, with this
 * process still here to hear them.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const drawing = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;
const filtered = (primitive: string) =>
  drawing(
    `<filter id="f">${primitive}</filter><rect width="100" height="100" fill="#c33" filter="url(#f)"/>`,
  );

describe("the render process", () => {
  it("returns an ordinary drawing as a PNG", async () => {
    const { bytes, extension } = await prepareAsset(
      "plain.svg",
      Buffer.from(drawing('<rect width="100" height="100" fill="#c33"/>')),
    );
    expect(extension).toBe(".png");
    expect(bytes.subarray(0, 8)).toEqual(PNG);
  });

  it("is stopped when a document holds it, and the asset refused in time", async () => {
    const started = Date.now();
    await expect(
      prepareAsset("hold.svg", Buffer.from(filtered('<feMorphology operator="dilate" radius="500"/>')), {
        renderTimeoutMs: 1500,
      }),
    ).rejects.toThrow(/was stopped/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("takes a crash with it, and the asset is refused rather than the publisher lost", async () => {
    // Order thirty crashed the renderer outright on the machine this was written on. On a
    // machine where it merely takes long, the clock refuses it instead. Either way the
    // process running this test is still here to see the refusal, which is the point.
    const taps = Array.from({ length: 900 }, () => "1").join(" ");
    await expect(
      prepareAsset(
        "crash.svg",
        Buffer.from(filtered(`<feConvolveMatrix order="30" kernelMatrix="${taps}"/>`)),
        {
          renderTimeoutMs: 5000,
        },
      ),
    ).rejects.toThrow(/could not be rendered|was stopped/);
  }, 30_000);
});

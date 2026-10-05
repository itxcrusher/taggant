import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrackingFeatures } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import { loadGrayscale } from "../src/load.js";
import { markAt, posedAsShown, recognitionOf } from "../src/recognise.js";

const POSTCARD = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/postcard/artwork.png");

describe("the artwork as the recogniser is shown it", () => {
  it("is softened at the artwork's own width, as any camera would deliver it", async () => {
    // At exactly the analysed width the reduction was a copy, sharper than any frame, and the
    // postcard was found with 22 points there against 13 a pixel narrower.
    const artwork = await loadGrayscale(await readFile(POSTCARD));
    const own = markAt(artwork, artwork.width);
    const wider = markAt(artwork, artwork.width + 6);
    expect(own.width).toBe(artwork.width);
    expect(
      Buffer.from(own.data).equals(Buffer.from(artwork.data)),
      "the artwork's own pixels were shown",
    ).toBe(false);
    expect(wider.width).toBe(artwork.width + 6);
    // Narrower than the artwork it was always softened by the reduction itself.
    expect(markAt(artwork, artwork.width - 1).width).toBe(artwork.width - 1);
  });

  it("goes back to the event loop between looks, so a server compiling answers in between", async () => {
    // Each look is tens of milliseconds that cannot be divided, and a compile asks for
    // twenty or more. Run back to back they held a console for eight seconds on a sheet of four
    // postcards while an unrelated page waited seventeen.
    //
    // Counted at the looks themselves: a timer that is due runs between two looks only if the
    // recogniser gave the event loop back. Measured over a whole compile instead, as the longest
    // pause against half the compile, this stayed green with the yield removed, because decoding
    // and describing the artwork are large enough parts of a compile to hide a blocked stage.
    const artwork = await loadGrayscale(await readFile(POSTCARD));
    const recognise = recognitionOf(artwork, buildTrackingFeatures(artwork));
    let ticks = 0;
    const ticking = setInterval(() => {
      ticks++;
    }, 5);
    try {
      for (const pixels of [314, 317, 320, 323, 326]) await recognise(pixels);
    } finally {
      clearInterval(ticking);
    }
    // Twenty looks. Back to back the timer could run once, at the end.
    expect(ticks, "the timer did not run between looks").toBeGreaterThanOrEqual(10);
  }, 120_000);
});

describe("the shape of the pose a pointed look found", () => {
  // A frame the size the recogniser is shown, whose points show the artwork's points of the same
  // coordinates, and a pose that changes their size by `scale` and turns them by `degrees` about
  // the frame's centre, mirrored top to bottom if asked: the mirror that keeps the frame's edges
  // running the way they ran, so nothing but its hand gives it away.
  const frame = { width: 480, height: 360 };
  const shows = (x: number, y: number): [number, number] => [x, y];
  const pose = (scale: number, degrees = 0, mirrored = false, [dx, dy] = [0, 0]): Float64Array => {
    const turn = (degrees * Math.PI) / 180;
    const hand = mirrored ? -1 : 1;
    const [a, b] = [scale * Math.cos(turn), -scale * Math.sin(turn) * hand];
    const [c, d] = [scale * Math.sin(turn), scale * Math.cos(turn) * hand];
    return Float64Array.of(a, b, 240 - a * 240 - b * 180 + dx, c, d, 180 - c * 240 - d * 180 + dy, 0, 0, 1);
  };

  it("takes a pose that is right, or a few per cent out", () => {
    expect(posedAsShown(pose(1), frame, shows)).toBe(true);
    expect(posedAsShown(pose(1.1), frame, shows)).toBe(true);
    expect(posedAsShown(pose(1 / 1.1, 10), frame, shows)).toBe(true);
    // Where it puts the middle is for the point to judge, not the shape.
    expect(posedAsShown(pose(1, 0, false, [120, -60]), frame, shows)).toBe(true);
  });

  it("refuses one at another size, turned, mirrored or collapsed, wherever it puts the middle", () => {
    // The pose of a copy at a quarter of the design's size, and poses just past each tolerance.
    expect(posedAsShown(pose(0.27), frame, shows)).toBe(false);
    expect(posedAsShown(pose(0.27, 0, false, [120, -60]), frame, shows)).toBe(false);
    expect(posedAsShown(pose(1.2), frame, shows)).toBe(false);
    expect(posedAsShown(pose(1 / 1.2), frame, shows)).toBe(false);
    expect(posedAsShown(pose(1, 25), frame, shows)).toBe(false);
    expect(posedAsShown(pose(1, -25), frame, shows)).toBe(false);
    expect(posedAsShown(pose(1, 0, true), frame, shows)).toBe(false);
    expect(posedAsShown(Float64Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1), frame, shows)).toBe(false);
  });
});

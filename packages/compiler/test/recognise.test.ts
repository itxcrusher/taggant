import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrackingFeatures } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import { loadGrayscale } from "../src/load.js";
import { markAt, recognitionOf } from "../src/recognise.js";

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
    // Each look is a few hundred milliseconds that cannot be divided, and a compile asks for
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

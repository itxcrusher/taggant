import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECOGNISED_PIXELS_ACROSS_FRAME } from "@taggant/compiler";
import { DEFAULT_PROCESS_WIDTH } from "@taggant/runtime";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * One number, held in three places, checked here because this package sees two of them.
 *
 * The compiler turns a print width into a count of pixels across the mark by assuming the
 * frame is a fixed width; the runtime reduces every frame to that width before recognising.
 * If they disagree, every printed width is wrong by the ratio, which is the exact shape of
 * the defect this whole round was about. They live in packages that do not depend on each
 * other and were kept together by a comment saying to keep them together.
 *
 * The bundler is the natural place for the check: it is where a compiled target and the
 * runtime that will read it are put in the same folder.
 */
describe("the width a frame is recognised at", () => {
  it("is the same number in the compiler and in the runtime", () => {
    expect(
      DEFAULT_PROCESS_WIDTH,
      "the runtime recognises at a different width than the compiler computes print widths for, so every width the compiler prints is wrong by the ratio between them",
    ).toBe(RECOGNISED_PIXELS_ACROSS_FRAME);
  });

  it("is the same number on the page that measures a camera", async () => {
    // The third copy, and the one that had already drifted: the page ran at 640 where the
    // runtime runs at 480, so it recognised prints the shipped product cannot. It is not a
    // module anything can import, so it is read.
    const page = await readFile(join(ROOT, "site/measure/index.html"), "utf8");
    const declared = page.match(/const PROCESS_WIDTH = (\d+);/)?.[1];
    expect(declared, "site/measure/index.html no longer declares a PROCESS_WIDTH").toBeDefined();
    expect(
      Number(declared),
      "the measurement page recognises at a different width than the runtime, so it answers yes about prints the product answers no about",
    ).toBe(DEFAULT_PROCESS_WIDTH);
  });
});

import { describe, expect, it } from "vitest";
import { DESCRIPTOR_BITS, PATCH_RADIUS, TEST_PAIRS } from "../src/pattern.js";

describe("the descriptor sampling pattern", () => {
  it("has one point pair per bit", () => {
    expect(TEST_PAIRS.length).toBe(DESCRIPTOR_BITS * 4);
  });

  it("keeps every sample inside the patch, so a rotated patch never reads past its border", () => {
    for (const v of TEST_PAIRS) expect(Math.abs(v)).toBeLessThanOrEqual(PATCH_RADIUS);
  });

  it("is identical on every run, because a change silently invalidates every compiled target", () => {
    expect([...TEST_PAIRS.slice(0, 8)]).toEqual([-6, -5, 3, 9, -8, 11, 13, 0]);
  });
});

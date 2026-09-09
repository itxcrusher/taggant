import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DESCRIBE_MARGIN } from "../src/describe.js";
import { DESCRIPTOR_BITS, SAMPLE_RADIUS, TEST_PAIRS } from "../src/pattern.js";

describe("the descriptor sampling pattern", () => {
  it("has one point pair per bit", () => {
    expect(TEST_PAIRS.length).toBe(DESCRIPTOR_BITS * 4);
  });

  it("draws every coordinate from inside the sample radius", () => {
    // The contract is SAMPLE_RADIUS, not PATCH_RADIUS. Asserted against the patch radius,
    // this passed a pattern that reaches past the border guard: a (15, 15) point is inside
    // a patch radius of 15 and rotates out to 21.2 px, which is past the 19 px margin
    // `describeCorners` guards with.
    for (const v of TEST_PAIRS) expect(Math.abs(v)).toBeLessThanOrEqual(SAMPLE_RADIUS);
  });

  it("never reaches past the border guard, at any rotation", () => {
    // The invariant the bound above is a proxy for. A sample sits at a fixed distance from
    // the corner and the pattern is rotated to the patch's own angle, so what matters is
    // the radius, not either coordinate. Past this, samples come from clamped pixels and a
    // descriptor starts depending on where the corner sits rather than what is under it.
    let furthest = 0;
    for (let i = 0; i < TEST_PAIRS.length; i += 2) {
      furthest = Math.max(furthest, Math.hypot(TEST_PAIRS[i] ?? 0, TEST_PAIRS[i + 1] ?? 0));
    }
    expect(furthest).toBeLessThanOrEqual(DESCRIBE_MARGIN);
  });

  it("is identical on every run, because a change silently invalidates every compiled target", () => {
    // Every value, not the first eight. The point of pinning this is that one changed
    // number stops today's compiled targets matching tomorrow's frames, and a canary over
    // the first eight cannot see a change anywhere after them.
    const digest = createHash("sha256").update(new Uint8Array(TEST_PAIRS.buffer)).digest("hex");
    expect(digest).toBe("fa79cc7fcc07aca5f572af35d4e98b0f6dd33f78356a4674eec7a672579fc049");
  });
});

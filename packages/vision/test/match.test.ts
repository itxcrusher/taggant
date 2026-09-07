import { describe, expect, it } from "vitest";
import { matchDescriptors } from "../src/match.js";

function descriptor(seed: number): Uint32Array {
  const d = new Uint32Array(8);
  let state = seed | 0 || 1;
  for (let i = 0; i < 8; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    d[i] = state >>> 0;
  }
  return d;
}

/** Flip n bits, to make a descriptor that is close to another without being it. */
function nudge(source: Uint32Array, bits: number): Uint32Array {
  const copy = Uint32Array.from(source);
  for (let bit = 0; bit < bits; bit++) {
    const word = bit >>> 5;
    copy[word] = ((copy[word] ?? 0) ^ (1 << (bit & 31))) >>> 0;
  }
  return copy;
}

describe("matchDescriptors", () => {
  it("pairs each descriptor with its own copy", () => {
    const set = [descriptor(11), descriptor(22), descriptor(33)];
    const matches = matchDescriptors(
      set.map((d) => Uint32Array.from(d)),
      set,
    );
    expect(matches.length).toBe(3);
    for (const m of matches) expect(m.query).toBe(m.target);
    for (const m of matches) expect(m.distance).toBe(0);
  });

  it("matches a descriptor that has been slightly disturbed", () => {
    const set = [descriptor(11), descriptor(22), descriptor(33)];
    const matches = matchDescriptors([nudge(set[1] as Uint32Array, 10)], set);
    expect(matches.length).toBe(1);
    expect(matches[0]?.target).toBe(1);
  });

  it("refuses a match whose runner up is almost as good", () => {
    const original = descriptor(11);
    const twin = nudge(original, 4);
    // The query sits between two near identical target patches, so neither is safe.
    const matches = matchDescriptors([nudge(original, 2)], [original, twin]);
    expect(matches).toEqual([]);
  });

  it("returns nothing for two unrelated sets", () => {
    const a = [descriptor(101), descriptor(202), descriptor(303)];
    const b = [descriptor(404), descriptor(505), descriptor(606)];
    expect(matchDescriptors(a, b)).toEqual([]);
  });

  it("keeps only mutual best matches", () => {
    const shared = descriptor(77);
    // Both queries are closest to the single target, but it can only choose one of them.
    const matches = matchDescriptors([nudge(shared, 2), nudge(shared, 8)], [shared, descriptor(88)]);
    expect(matches.length).toBe(1);
    expect(matches[0]?.query).toBe(0);
  });

  it("returns nothing when either side is empty", () => {
    expect(matchDescriptors([], [descriptor(1)])).toEqual([]);
    expect(matchDescriptors([descriptor(1)], [])).toEqual([]);
  });
});

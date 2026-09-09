/** Bits per descriptor. 256 is the usual trade between discrimination and speed. */
export const DESCRIPTOR_BITS = 256;
/** Half width of the patch a descriptor is computed from. */
export const PATCH_RADIUS = 15;
/**
 * How far a sample may sit from the centre, leaving room to rotate without leaving the
 * patch.
 *
 * Exported because `describe.ts` derives its border guard from it. Both hardcoded the same
 * 13 for a while, and the comment there named a constant called `SAMPLE_REACH` that has
 * never existed anywhere in this repository.
 */
export const SAMPLE_RADIUS = 13;

/**
 * A small deterministic generator.
 *
 * The pattern has to be identical in the compiler and in the browser, on every machine
 * and in every release, or artwork compiled today stops matching tomorrow. That rules
 * out Math.random, and generating it beats shipping a four kilobyte table.
 */
function xorshift32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function build(): Int8Array {
  const random = xorshift32(0x7461_6767);
  const pairs = new Int8Array(DESCRIPTOR_BITS * 4);
  for (let i = 0; i < pairs.length; i++) {
    pairs[i] = Math.round((random() * 2 - 1) * SAMPLE_RADIUS);
  }
  return pairs;
}

/** Flat runs of four, [ax, ay, bx, by], one run per bit. */
export const TEST_PAIRS: Int8Array = build();

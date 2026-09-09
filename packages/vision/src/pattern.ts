/** Bits per descriptor. 256 is the usual trade between discrimination and speed. */
export const DESCRIPTOR_BITS = 256;
/** Half width of the patch a descriptor is computed from. */
export const PATCH_RADIUS = 15;
/** How far a sample may sit from the centre, leaving room to rotate without leaving the patch. */
export const SAMPLE_RADIUS = 13;

/**
 * The pattern, chosen rather than drawn at random.
 *
 * Each bit compares two points in the patch, so a pattern is only as useful as the bits
 * are informative. Drawn uniformly at random, most were not: measured over sixteen pieces
 * of real print artwork the random pattern left a sixth of the descriptor stuck almost
 * always at one value, and the closest one percent of distinct features sat 17 to 75 bits
 * apart, which is the distance that decides whether a feature matches the wrong feature.
 *
 * These 256 were chosen from 20,000 candidates as the ones that split 3,152 real corner
 * patches most evenly. Measured leave-one-out, so every number below is from artwork the
 * pattern had not seen: the closest one percent improved on all sixteen and worsened on
 * none, typically from around 50 bits to around 80, and typical separation rose on all
 * sixteen. Rotation invariance was unchanged, five better and five worse out of sixteen
 * with no case moving far.
 *
 * ORB's own recipe also decorrelates the chosen tests. That was measured here and made
 * every number worse, because it starves: ORB draws candidates exhaustively from the
 * patch, where the most balanced would otherwise be near duplicates, and candidates drawn
 * at random from 20,000 are already spread out.
 *
 * A table rather than a generator because the values are not derivable from a seed, and
 * they have to be identical in the compiler and in the browser, on every machine and in
 * every release. Changing them invalidates every compiled target, which is what
 * `formatVersion` in `serialise.ts` is for.
 */
// biome-ignore format: four values a bit, laid out so a diff shows which bits moved.
const PAIRS: readonly number[] = [
  3, -8, 11, 11, -9, 3, -9, 7, 0, -9, 2, -12, 5, -12, 10, 1,
  -10, -6, -8, 9, -10, -4, -12, 8, -7, -6, -8, 8, -10, -3, -5, -5,
  4, -11, 7, 1, 4, -11, 8, -3, 3, -12, 8, -9, -12, 2, -11, 11,
  -6, 4, -8, 7, -10, -7, -1, -2, -9, 0, -12, -8, -5, 2, -13, 0,
  -1, 11, 1, 7, -12, 6, -6, 9, -6, 7, -4, 9, -5, -8, -2, -8,
  1, 3, 2, 8, -13, -6, -6, -13, 3, 8, 5, 3, -4, -8, -3, 11,
  -12, -10, -3, -10, -10, 11, -3, -6, -11, 2, -4, 2, -8, 3, -5, 4,
  -10, -7, -6, -10, 4, 8, 7, -2, 4, 8, 11, -7, 1, 2, 4, -13,
  -9, 12, -3, -10, -1, 1, -12, 4, -10, 0, -11, 8, 3, 11, 11, -11,
  -10, 2, -11, 10, 2, -3, 6, -12, 3, -9, 9, 10, -3, 7, -2, -6,
  -6, -2, -9, -6, -4, 0, -3, -2, -8, 13, -2, 5, 3, -12, 2, -2,
  -10, -7, -6, -11, 4, -1, 12, -1, 0, 1, -3, 8, -9, 4, -10, -7,
  3, 11, 7, -9, 1, -2, 3, 7, -8, -7, -6, -11, -11, -4, -13, -11,
  -9, -11, -2, -8, -13, 4, -3, -3, -5, -1, -13, 1, 2, 2, 4, 8,
  0, -12, 3, -11, 2, 4, 5, 11, 2, -12, 6, 9, 2, -1, 8, 13,
  -9, -9, -4, -11, -5, 10, -1, 9, 3, -8, 13, 11, -3, 3, -7, 6,
  -11, 1, -12, 8, 3, -6, 11, -10, -11, -5, -9, -10, -3, -5, -2, -4,
  -6, -1, -11, -3, -4, 4, -5, 5, 4, -1, 6, -1, -13, -7, -3, 4,
  -5, -6, -11, 12, 1, -7, 4, -11, -9, -13, -1, -13, 2, -3, 2, 0,
  -6, -3, -4, 4, -7, 6, -7, -7, -9, 6, -6, 8, -2, -9, 0, -8,
  -13, 10, -2, 5, -11, 3, -4, 5, 3, 8, 6, 6, -13, -9, -5, 13,
  1, 8, 4, -13, 4, -12, 9, 9, -3, 7, -1, 8, 4, -2, 11, 2,
  -1, -7, 0, -7, 2, -12, 5, -6, 4, -13, 9, -4, -9, 11, -2, -4,
  3, 7, 13, 10, -6, 4, -10, -7, 1, 12, 3, -6, -12, 3, -7, -7,
  4, 12, 12, 2, -8, 11, -3, -7, 1, -11, 2, 3, -3, 3, -9, 7,
  3, -10, 11, 11, -6, 5, -10, -7, -10, 4, -4, 5, -9, 13, -2, 10,
  -10, 1, -4, -3, 3, 8, 3, 0, 4, -12, 7, 1, 3, -11, 3, -1,
  -2, -6, -2, 7, 3, -1, 9, -12, 4, 12, 8, 6, 4, -11, 9, 9,
  -10, -5, -8, 8, -6, 3, -8, 6, -2, -12, 0, -4, 0, -11, 1, 4,
  0, 12, 1, 5, -4, 3, -11, -6, -11, 11, -4, -11, 4, 12, 7, 1,
  3, 7, 10, -11, -7, 7, -10, -12, 2, 1, 3, -2, -7, -7, -10, -13,
  -2, -4, -8, 12, 1, -7, 4, -10, -2, -3, -11, -8, 0, 0, -4, 8,
  -7, 4, -5, 4, 4, -1, 8, 2, 5, 12, 9, -2, 4, 4, 12, 0,
  -6, -5, -5, -6, 3, -5, 9, -10, -7, 8, -3, 9, -2, -2, -9, 5,
  3, 6, 4, 1, -1, 11, 2, 11, -10, -3, -11, 7, -10, -1, -9, -8,
  -12, 5, -6, 8, -9, 2, -3, -2, -11, 6, -9, -12, -5, 2, -11, 6,
  1, 8, 1, -3, -8, -9, -3, -10, 3, -7, 5, 3, 4, -6, 9, -2,
  -11, -4, -1, -1, -9, 4, -10, 9, 4, 8, 12, -5, 4, -8, 9, 6,
  0, 9, 1, -6, -6, 7, -7, -12, 4, 9, 6, -3, -11, -6, -7, -12,
  -8, -1, -12, 6, 3, -11, 13, 12, 4, -9, 10, 6, -4, -12, 0, -6,
  -12, 0, -10, 8, 3, 7, 12, 11, -9, -6, -5, -7, -10, -10, -4, 12,
  4, 2, 9, -1, 3, -12, 6, 4, -7, 2, -11, 7, -8, 13, -2, 12,
  -9, -12, -2, 6, -12, -4, -10, -13, 4, -1, 11, 4, -1, 3, -6, 10,
  -4, 3, -4, -4, -12, 0, -11, 10, -11, 11, -3, -7, -6, -4, -10, 7,
  -6, -12, -1, 8, -8, -7, -6, -12, -10, -7, -6, 8, -12, 2, -13, 12,
  -4, -4, -13, 6, -5, -2, -10, 5, -8, -2, -10, 5, -11, -5, -11, 11,
  -6, 1, -11, 5, -12, -12, -3, 12, 4, -12, 9, -7, -7, -1, -12, -6,
  4, 7, 13, -1, -4, -11, 0, -11, 4, -12, 11, -6, 0, 0, -6, -11,
  4, 10, 7, 1, 4, 6, 12, -1, -11, 6, -7, -8, 3, -9, 7, 6,
  -6, -11, -1, -10, -4, 2, -10, 5, 2, 1, 8, -13, 0, 3, -1, -13,
  -13, -5, -3, 4, 2, -8, 4, 8, 2, 10, 4, -4, -8, 4, -9, 7,
  -5, 6, -12, -12, 2, -1, 6, 11, -11, -8, -5, 8, 4, -12, 8, -3,
  -1, -1, -5, -3, -8, -4, -11, 8, 4, 12, 13, 3, -11, -8, -5, 7,
  1, -2, 4, 13, 4, -9, 9, 4, 4, 10, 12, -7, 3, 3, 5, -2,
  2, -12, 4, -4, -5, 12, 0, -1, 4, -11, 9, -5, 3, -8, 4, 2,
  4, -3, 11, 4, 4, -3, 10, 2, -6, -3, -5, 4, 1, -4, 2, -11,
  -1, 2, -12, -6, -6, 0, -11, 4, -4, 3, -12, -6, -7, 12, -2, 11,
  -9, -6, -12, 13, 0, -8, 1, 7, -3, 6, -3, -8, 1, -12, 6, 13,
  1, 2, 3, -9, 4, 6, 8, 2, -9, 0, -7, -5, 0, -2, -2, -10,
  -3, -5, -4, 6, -6, -5, -12, -9, 3, 12, 12, -11, 4, -10, 11, -4,
  -11, -5, -10, -11, -8, 2, -8, 7, -7, -2, -8, 6, -12, 6, -3, 4,
  -7, -11, -1, -9, 1, 0, 0, 11, 2, 9, 4, -6, -13, -6, -5, 10,
  -11, 1, -6, -6, 4, 6, 12, 4, -7, 4, -7, -6, 3, -9, 8, 9,
  -9, 1, -3, 2, -4, 2, -4, 4, 4, 12, 8, 5, 2, -7, 1, 2
];

/** Flat runs of four, [ax, ay, bx, by], one run per bit. */
export const TEST_PAIRS: Int8Array = new Int8Array(PAIRS);

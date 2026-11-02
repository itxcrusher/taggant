import { DESCRIPTOR_BITS } from "./pattern.js";

const WORDS = DESCRIPTOR_BITS / 32;

export interface Match {
  /** Index into the query set, which in practice is the camera frame. */
  query: number;
  /** Index into the target set, which is the compiled artwork. */
  target: number;
  distance: number;
}

/** Where a target descriptor sits on the artwork, in the artwork's own coordinates. */
export interface Position {
  x: number;
  y: number;
}

export interface MatchOptions {
  /** Further apart than this and it is not a match at any ratio. */
  maxDistance?: number;
  /** The best must beat the second best by this factor, or the match is ambiguous. */
  ratio?: number;
  /**
   * Positions of the target descriptors. Supply them when the target holds the same
   * physical feature more than once, which a multi scale target always does.
   */
  targetPositions?: Position[];
  /** Positions of the query descriptors, for the same reason on the other side. */
  queryPositions?: Position[];
  /**
   * How far apart two features must be before they count as different places, for the ratio
   * test.
   *
   * Six pixels, because this is about one corner described at two sizes: a multi scale target
   * holds the same corner more than once, a pixel or two apart, and counting a feature's own
   * copy as its rival rejects exactly the matches most certainly right. The repetition
   * measure uses 24 for a different question, whether a look-alike is somewhere else on the
   * artwork, and the two sentences read alike while asking different things.
   */
  distinctRadius?: number;
}

/**
 * Copy a set of descriptors into one contiguous buffer.
 *
 * Matching is the inner loop of every frame: a few hundred descriptors against a few
 * hundred more, eight words each. Walking an array of separate typed arrays spends most of
 * that time chasing pointers. Packing first costs one pass and measurably shortens the
 * frame.
 */
function pack(descriptors: Uint32Array[]): Uint32Array {
  const flat = new Uint32Array(descriptors.length * WORDS);
  for (let i = 0; i < descriptors.length; i++) {
    const descriptor = descriptors[i];
    if (!descriptor) continue;
    // Refused rather than padded. A short descriptor was copied as far as it went and the rest
    // left zero, which is a real descriptor the matcher then compares in good faith.
    if (descriptor.length !== WORDS) {
      throw new RangeError(`descriptor ${i} is ${descriptor.length} words long, and every one is ${WORDS}`);
    }
    flat.set(descriptor, i * WORDS);
  }
  return flat;
}

/**
 * The target's shared-spot table, kept for as long as the positions it came from still hold.
 *
 * It is a property of the target and was rebuilt on every call, which is every camera frame,
 * and it is a pairwise sweep, so a frame's cost grew with the square of the target. Kept per
 * positions array, and checked against what that array holds before it is used: keyed on the
 * array alone, a caller refilling one array with another target's positions was answered from
 * the first target's table. The check is one pass over the positions, which is nothing beside
 * the sweep it saves.
 *
 * The packed descriptors are not kept. Packing is one pass, and a cache of it was the same
 * hazard for a smaller saving: an array refilled with other descriptors, or a descriptor edited
 * in place, was matched as the descriptors it used to hold.
 */
const sharedTargets = new WeakMap<
  Position[],
  { radiusSquared: number; xs: Float64Array; ys: Float64Array; shared: Uint8Array | undefined }
>();

function sharedOnce(positions: Position[] | undefined, radiusSquared: number): Uint8Array | undefined {
  if (!positions) return undefined;
  const held = sharedTargets.get(positions);
  if (held !== undefined && held.radiusSquared === radiusSquared && samePositions(held, positions))
    return held.shared;
  const xs = new Float64Array(positions.length);
  const ys = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    xs[i] = positions[i]?.x ?? Number.NaN;
    ys[i] = positions[i]?.y ?? Number.NaN;
  }
  const shared = sharedPositions(positions, radiusSquared);
  sharedTargets.set(positions, { radiusSquared, xs, ys, shared });
  return shared;
}

function samePositions(held: { xs: Float64Array; ys: Float64Array }, positions: Position[]): boolean {
  if (held.xs.length !== positions.length) return false;
  for (let i = 0; i < positions.length; i++) {
    // Object.is, so a hole read back as NaN matches the NaN it was stored as.
    if (
      !Object.is(held.xs[i], positions[i]?.x ?? Number.NaN) ||
      !Object.is(held.ys[i], positions[i]?.y ?? Number.NaN)
    ) {
      return false;
    }
  }
  return true;
}

/** Bits that differ between two descriptors held in flat buffers. */
function distance(a: Uint32Array, ai: number, b: Uint32Array, bi: number): number {
  let total = 0;
  for (let w = 0; w < WORDS; w++) {
    let v = ((a[ai + w] ?? 0) ^ (b[bi + w] ?? 0)) >>> 0;
    v = v - ((v >>> 1) & 0x5555_5555);
    v = (v & 0x3333_3333) + ((v >>> 2) & 0x3333_3333);
    total += (((v + (v >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
  }
  return total;
}

interface Best {
  index: number;
  distance: number;
  second: number;
}

/**
 * Nearest and next nearest, where next nearest means the nearest one somewhere else.
 *
 * A target compiled at several scales carries each physical feature several times over,
 * and those copies are nearly identical by construction. Counting a feature's own copy as
 * its rival makes the ratio test reject exactly the matches that are most certainly right.
 */
function bestAgainst(
  query: Uint32Array,
  queryIndex: number,
  set: Uint32Array,
  count: number,
  positions: Position[] | undefined,
  shared: Uint8Array | undefined,
  radiusSquared: number,
): Best {
  let index = -1;
  let best = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const d = distance(query, queryIndex, set, i * WORDS);
    if (d < best) {
      second = best;
      best = d;
      index = i;
    } else if (d < second) {
      second = d;
    }
  }
  if (index < 0 || !positions || !shared || radiusSquared <= 0) return { index, distance: best, second };

  // Only when something else sits on the winner's spot is the runner up suspect, and only
  // then is a second pass worth its cost. Which features share a spot is a property of the
  // target, so it is worked out once rather than once per frame descriptor.
  const winner = positions[index];
  if (!winner || shared[index] !== 1) return { index, distance: best, second };

  second = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    if (i === index) continue;
    const other = positions[i];
    if (other) {
      const dx = other.x - winner.x;
      const dy = other.y - winner.y;
      if (dx * dx + dy * dy <= radiusSquared) continue;
    }
    const d = distance(query, queryIndex, set, i * WORDS);
    if (d < second) second = d;
  }
  return { index, distance: best, second };
}

/** Which features share their position with another, computed once for a whole set. */
function sharedPositions(positions: Position[] | undefined, radiusSquared: number): Uint8Array | undefined {
  if (!positions || radiusSquared <= 0) return undefined;
  const shared = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    if (shared[i] === 1) continue;
    const a = positions[i];
    if (!a) continue;
    for (let j = i + 1; j < positions.length; j++) {
      const b = positions[j];
      if (!b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx * dx + dy * dy <= radiusSquared) {
        shared[i] = 1;
        shared[j] = 1;
      }
    }
  }
  return shared;
}

/**
 * Pair descriptors between two images.
 *
 * Two filters, both load bearing. Repeated artwork produces several near identical
 * patches, so a match whose runner up is nearly as good is thrown away rather than
 * guessed at; that is the ratio test. And a match is only kept when both sides choose
 * each other, which removes the case where many frame corners crowd onto one target
 * corner and drag the pose with them.
 */
export function matchDescriptors(
  query: Uint32Array[],
  target: Uint32Array[],
  options: MatchOptions = {},
): Match[] {
  const maxDistance = options.maxDistance ?? 72;
  const ratio = options.ratio ?? 0.8;
  const positions = options.targetPositions;
  const distinctRadius = options.distinctRadius ?? (positions ? 6 : 0);
  const radiusSquared = distinctRadius * distinctRadius;
  if (query.length === 0 || target.length === 0) return [];

  const queries = pack(query);
  const targets = pack(target);
  const targetShared = sharedOnce(positions, radiusSquared);
  const queryShared = sharedPositions(options.queryPositions, radiusSquared);

  const forward: Match[] = [];
  for (let q = 0; q < query.length; q++) {
    const best = bestAgainst(
      queries,
      q * WORDS,
      targets,
      target.length,
      positions,
      targetShared,
      radiusSquared,
    );
    if (best.index < 0 || best.distance > maxDistance) continue;
    // Greater than or equal, not greater than. With an exact tie both distances are zero
    // and `0 > 0` is false, so the one case where the matcher has no information at all
    // was the one it kept.
    if (Number.isFinite(best.second) && best.distance >= best.second * ratio) continue;
    forward.push({ query: q, target: best.index, distance: best.distance });
  }

  const queryPositions = options.queryPositions;
  const mutual: Match[] = [];
  for (const match of forward) {
    const back = bestAgainst(
      targets,
      match.target * WORDS,
      queries,
      query.length,
      queryPositions,
      queryShared,
      radiusSquared,
    );
    if (back.index === match.query) mutual.push(match);
  }
  return mutual;
}

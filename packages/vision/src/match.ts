import { hamming } from "./describe.js";

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
  /** How far apart two target features must be before they count as different places. */
  distinctRadius?: number;
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
  descriptor: Uint32Array,
  set: Uint32Array[],
  positions?: Position[],
  distinctRadius = 0,
): Best {
  let index = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < set.length; i++) {
    const candidate = set[i];
    if (!candidate) continue;
    const d = hamming(descriptor, candidate);
    if (d < distance) {
      distance = d;
      index = i;
    }
  }
  if (index < 0) return { index, distance, second: Number.POSITIVE_INFINITY };

  const bestPosition = positions?.[index];
  const radiusSquared = distinctRadius * distinctRadius;
  let second = Number.POSITIVE_INFINITY;
  for (let i = 0; i < set.length; i++) {
    if (i === index) continue;
    const candidate = set[i];
    if (!candidate) continue;
    if (bestPosition && radiusSquared > 0) {
      const other = positions?.[i];
      if (other) {
        const dx = other.x - bestPosition.x;
        const dy = other.y - bestPosition.y;
        if (dx * dx + dy * dy <= radiusSquared) continue;
      }
    }
    const d = hamming(descriptor, candidate);
    if (d < second) second = d;
  }
  return { index, distance, second };
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
  if (query.length === 0 || target.length === 0) return [];

  const forward: Match[] = [];
  for (let q = 0; q < query.length; q++) {
    const descriptor = query[q];
    if (!descriptor) continue;
    const best = bestAgainst(descriptor, target, positions, distinctRadius);
    if (best.index < 0 || best.distance > maxDistance) continue;
    if (Number.isFinite(best.second) && best.distance > best.second * ratio) continue;
    forward.push({ query: q, target: best.index, distance: best.distance });
  }

  const mutual: Match[] = [];
  for (const match of forward) {
    const descriptor = target[match.target];
    if (!descriptor) continue;
    if (bestAgainst(descriptor, query).index === match.query) mutual.push(match);
  }
  return mutual;
}

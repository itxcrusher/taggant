import type { TargetFeature } from "./target.js";

/** How far a design maps onto itself, read from its own features. */
export interface Repetition {
  /**
   * Places on the artwork that one move of the whole of it, other than leaving it where it is,
   * carries onto a look-alike of themselves: the most that any one move carries. A place is a
   * four pixel square of the artwork, so a corner found at several sizes counts once.
   */
  places: number;
  /** Places on the artwork holding any feature at all, so the count above reads as a share. */
  of: number;
  /**
   * The move that carries them, null when none carries any: where it takes the artwork's
   * centre, across and down, as shares of the artwork's width; how far it turns the artwork, in
   * degrees; and how much it scales it.
   */
  move: { across: number; down: number; turnDegrees: number; scale: number } | null;
}

export interface RepetitionOptions {
  /**
   * How far a move must take some corner of the artwork, in pixels, before it counts. A move
   * leaving every corner nearer than this is the artwork where it is, drawn a little off, and
   * that is a different failure from drawing it somewhere else.
   */
  farEnough: number;
}

/** Look-alikes kept for each feature: one for each other copy on a sheet of four. */
const LOOK_ALIKES = 3;

/** Bits apart at most for two features to be look-alikes, which is the matcher's own line. */
const MAX_DISTANCE = 72;

/**
 * Nearer than this, in pixels, and two features are taken for one corner found at two sizes,
 * which land a pixel or two apart, rather than for a look-alike somewhere else on the artwork.
 */
const APART_PX = 24;

/** The side of the square a place is counted in, in pixels. */
const PLACE_PX = 4;

/**
 * How far a pair's own turn may differ from the move's, and its own change of size, before the
 * move does not carry it.
 *
 * A move is not only where a feature lands. A look-alike that happens to sit where a move puts a
 * feature, while facing another way or found at another size, is a coincidence, and counted it
 * made a postcard that repeats nothing map onto itself at 28 places, through a move that shrank
 * the whole artwork to a point so that every pair landed. Holding each pair to the move's turn
 * and size took that to 5. Copies of a design face the same way to within a few degrees; the levels a
 * target is described at are a quarter apart, so fifteen per cent tells one from the next.
 */
const TURN_TOLERANCE = (20 * Math.PI) / 180;
const SCALE_TOLERANCE = Math.log(1.15);

/** How far from its look-alike a carried feature may land, in pixels at the size it was found at. */
const LANDS_WITHIN_PX = 3;

const WORDS = 8;

/**
 * Every feature paired with a look-alike, held in flat arrays, and grouped by the change of size
 * between the two with each group ordered by turn: a move then reads only the pairs that could
 * agree with it in size and turn, which was most of the time this took when it read them all.
 */
interface Pairs {
  count: number;
  fx: Float64Array;
  fy: Float64Array;
  gx: Float64Array;
  gy: Float64Array;
  /** Natural log of the change of size from the feature to its look-alike. */
  logScale: Float64Array;
  turn: Float64Array;
  /** Squared distance a carried feature may land from its look-alike. */
  within: Float64Array;
  /** The place the feature is in, as an index. */
  place: Uint32Array;
  groups: Array<{ logScale: number; byTurn: Uint32Array; turns: Float64Array }>;
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * How far a design maps onto itself: the most places on the artwork that one move of the whole
 * of it, other than leaving it where it is, carries onto features that look like them.
 *
 * This is the question a matcher cannot answer for itself. A design printed twice has every
 * feature twice, so the ratio test throws most of them away on both copies alike, and the pose
 * that survives is decided by which of the leftovers happen to agree: usually the right copy and
 * sometimes the other, with as many points behind it. Showing the recogniser looks and counting
 * wrong poses is a lottery over those rare events, and it was measured as one: the postcard
 * printed twice was refused at six of seventeen export widths and ready at the other eleven.
 * The repetition itself is not rare, and is read here straight off the features.
 *
 * Every feature is paired with its nearest look-alikes elsewhere on the artwork, at any size it
 * was described at. Each pair proposes the move that carries the one onto the other, a shift
 * with a turn and a change of size taken from the two features themselves, and each move is
 * scored by the places whose pairs it carries, then fitted again to those and scored again.
 * Exhaustive over the pairs rather than sampled, so the same features always give the same
 * answer.
 */
export function measureRepetition(
  features: readonly TargetFeature[],
  size: { width: number; height: number },
  options: RepetitionOptions,
): Repetition {
  const usable: TargetFeature[] = [];
  // Indexed rather than iterated, so a hole in the list is skipped rather than read.
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (
      feature !== undefined &&
      feature !== null &&
      Number.isFinite(feature.x) &&
      Number.isFinite(feature.y) &&
      Number.isFinite(feature.angle) &&
      Number.isFinite(feature.scale) &&
      feature.scale > 0 &&
      feature.descriptor instanceof Uint32Array &&
      feature.descriptor.length === WORDS
    ) {
      usable.push(feature);
    }
  }

  const placeIds = new Map<string, number>();
  const places = usable.map((feature) => {
    const key = `${Math.round(feature.x / PLACE_PX)},${Math.round(feature.y / PLACE_PX)}`;
    let id = placeIds.get(key);
    if (id === undefined) {
      id = placeIds.size;
      placeIds.set(key, id);
    }
    return id;
  });
  const of = placeIds.size;
  const none: Repetition = { places: 0, of, move: null };
  if (usable.length < 2) return none;

  const pairs = pairUp(usable, places);
  if (pairs.count === 0) return none;

  const { width, height } = size;
  const farSquared = options.farEnough * options.farEnough;
  const goesSomewhere = (a: number, b: number, tx: number, ty: number): boolean => {
    // The four corners, written out: this runs once for every pair.
    const reaches = (x: number, y: number) => (a * x - b * y + tx - x) ** 2 + (b * x + a * y + ty - y) ** 2;
    return (
      reaches(0, 0) > farSquared ||
      reaches(width, 0) > farSquared ||
      reaches(0, height) > farSquared ||
      reaches(width, height) > farSquared
    );
  };

  const stamp = new Uint32Array(of);
  let generation = 0;
  const carried: number[] = [];
  const carry = (k: number, a: number, b: number, tx: number, ty: number): number => {
    const fx = pairs.fx[k] as number;
    const fy = pairs.fy[k] as number;
    const dx = a * fx - b * fy + tx - (pairs.gx[k] as number);
    const dy = b * fx + a * fy + ty - (pairs.gy[k] as number);
    if (dx * dx + dy * dy > (pairs.within[k] as number)) return 0;
    carried.push(k);
    const place = pairs.place[k] as number;
    if (stamp[place] === generation) return 0;
    stamp[place] = generation;
    return 1;
  };
  /** Places whose pairs the move carries; the carried pairs are left in `carried`. */
  const support = (a: number, b: number, tx: number, ty: number): number => {
    const logScale = Math.log(Math.hypot(a, b));
    const turn = Math.atan2(b, a);
    generation++;
    carried.length = 0;
    let counted = 0;
    for (const group of pairs.groups) {
      if (Math.abs(group.logScale - logScale) > SCALE_TOLERANCE) continue;
      // The turns within the tolerance either side of the move's, which can run past a half
      // turn and come round the other side.
      for (const [low, high] of turnWindows(turn)) {
        for (let at = firstAtLeast(group.turns, low); at < group.turns.length; at++) {
          if ((group.turns[at] as number) > high) break;
          counted += carry(group.byTurn[at] as number, a, b, tx, ty);
        }
      }
    }
    return counted;
  };

  let best = 0;
  let bestMove: [number, number, number, number] | null = null;
  const tried = new Set<number>();
  for (let k = 0; k < pairs.count; k++) {
    const scale = Math.exp(pairs.logScale[k] as number);
    const turn = pairs.turn[k] as number;
    const a = scale * Math.cos(turn);
    const b = scale * Math.sin(turn);
    const fx = pairs.fx[k] as number;
    const fy = pairs.fy[k] as number;
    const tx = (pairs.gx[k] as number) - (a * fx - b * fy);
    const ty = (pairs.gy[k] as number) - (b * fx + a * fy);
    if (!goesSomewhere(a, b, tx, ty)) continue;
    // Pairs from one copy to the next propose nearly the same move, and scoring each of them
    // again finds nothing new. The key packs the move, rounded, into one number.
    const key =
      ((Math.round(a * 20) + 512) * 1024 + (Math.round(b * 20) + 512)) * 4_194_304 +
      (Math.round(tx / 8) + 1024) * 2048 +
      (Math.round(ty / 8) + 1024);
    if (tried.has(key)) continue;
    tried.add(key);

    let count = support(a, b, tx, ty);
    let move: [number, number, number, number] = [a, b, tx, ty];
    if (carried.length >= 3) {
      const refitted = fitSimilarity(pairs, carried);
      if (refitted !== null && goesSomewhere(...refitted)) {
        const again = support(...refitted);
        if (again >= count) {
          count = again;
          move = refitted;
        }
      }
    }
    if (count > best) {
      best = count;
      bestMove = move;
    }
  }
  if (bestMove === null) return none;

  const [a, b, tx, ty] = bestMove;
  const cx = width / 2;
  const cy = height / 2;
  return {
    places: best,
    of,
    move: {
      across: width > 0 ? (a * cx - b * cy + tx - cx) / width : 0,
      down: width > 0 ? (b * cx + a * cy + ty - cy) / width : 0,
      turnDegrees: (Math.atan2(b, a) * 180) / Math.PI,
      scale: Math.hypot(a, b),
    },
  };
}

/** The ranges of turn, in (-pi, pi], within the tolerance of this one. */
function turnWindows(turn: number): Array<[number, number]> {
  const low = turn - TURN_TOLERANCE;
  const high = turn + TURN_TOLERANCE;
  if (low < -Math.PI)
    return [
      [-Math.PI, high],
      [low + 2 * Math.PI, Math.PI],
    ];
  if (high > Math.PI)
    return [
      [low, Math.PI],
      [-Math.PI, high - 2 * Math.PI],
    ];
  return [[low, high]];
}

/** The first index in an ascending array holding a value at least this one. */
function firstAtLeast(values: Float64Array, value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Every feature with its nearest look-alikes elsewhere on the artwork. */
function pairUp(features: TargetFeature[], places: number[]): Pairs {
  const n = features.length;
  // Into one buffer, so the distance below walks memory rather than chasing a pointer for each
  // of the million comparisons a full target makes.
  const words = new Uint32Array(n * WORDS);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const feature = features[i] as TargetFeature;
    words.set(feature.descriptor, i * WORDS);
    xs[i] = feature.x;
    ys[i] = feature.y;
  }
  const found: number[] = [];
  const apartSquared = APART_PX * APART_PX;
  const nearestDistance = new Int32Array(LOOK_ALIKES);
  const nearestIndex = new Int32Array(LOOK_ALIKES);
  for (let i = 0; i < n; i++) {
    let kept = 0;
    const fx = xs[i] as number;
    const fy = ys[i] as number;
    const fi = i * WORDS;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = (xs[j] as number) - fx;
      const dy = (ys[j] as number) - fy;
      if (dx * dx + dy * dy < apartSquared) continue;
      // The furthest a look-alike may be and still be kept, so the count can stop early.
      const limit = kept === LOOK_ALIKES ? (nearestDistance[LOOK_ALIKES - 1] as number) - 1 : MAX_DISTANCE;
      let distance = 0;
      const gj = j * WORDS;
      for (let w = 0; w < WORDS && distance <= limit; w++) {
        let v = ((words[fi + w] as number) ^ (words[gj + w] as number)) >>> 0;
        v = v - ((v >>> 1) & 0x5555_5555);
        v = (v & 0x3333_3333) + ((v >>> 2) & 0x3333_3333);
        distance += (((v + (v >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
      }
      if (distance > limit) continue;
      // Kept in order of distance, ties by index, so the result never depends on anything but
      // the features themselves.
      let at = Math.min(kept, LOOK_ALIKES - 1);
      while (at > 0 && (nearestDistance[at - 1] as number) > distance) {
        nearestDistance[at] = nearestDistance[at - 1] as number;
        nearestIndex[at] = nearestIndex[at - 1] as number;
        at--;
      }
      nearestDistance[at] = distance;
      nearestIndex[at] = j;
      if (kept < LOOK_ALIKES) kept++;
    }
    for (let m = 0; m < kept; m++) found.push(i, nearestIndex[m] as number);
  }

  const count = found.length / 2;
  const pairs: Pairs = {
    count,
    fx: new Float64Array(count),
    fy: new Float64Array(count),
    gx: new Float64Array(count),
    gy: new Float64Array(count),
    logScale: new Float64Array(count),
    turn: new Float64Array(count),
    within: new Float64Array(count),
    place: new Uint32Array(count),
    groups: [],
  };
  const bySize = new Map<number, number[]>();
  for (let k = 0; k < count; k++) {
    const f = features[found[2 * k] as number] as TargetFeature;
    const g = features[found[2 * k + 1] as number] as TargetFeature;
    pairs.fx[k] = f.x;
    pairs.fy[k] = f.y;
    pairs.gx[k] = g.x;
    pairs.gy[k] = g.y;
    // A feature found at a smaller size covers more of the artwork, so carrying one found at
    // size s onto one found at size t scales the artwork by s over t.
    const logScale = Math.log(f.scale / g.scale);
    pairs.logScale[k] = logScale;
    pairs.turn[k] = wrap(g.angle - f.angle);
    const within = LANDS_WITHIN_PX / Math.min(f.scale, g.scale);
    pairs.within[k] = within * within;
    pairs.place[k] = places[found[2 * k] as number] as number;
    const group = bySize.get(logScale);
    if (group === undefined) bySize.set(logScale, [k]);
    else group.push(k);
  }
  for (const [logScale, members] of bySize) {
    members.sort((p, q) => (pairs.turn[p] as number) - (pairs.turn[q] as number) || p - q);
    pairs.groups.push({
      logScale,
      byTurn: Uint32Array.from(members),
      turns: Float64Array.from(members, (k) => pairs.turn[k] as number),
    });
  }
  return pairs;
}

/** The move, a turn with a change of size and a shift, that best carries these pairs, by least squares. */
function fitSimilarity(pairs: Pairs, which: number[]): [number, number, number, number] | null {
  const n = which.length;
  let mx = 0;
  let my = 0;
  let nx = 0;
  let ny = 0;
  for (const k of which) {
    mx += pairs.fx[k] as number;
    my += pairs.fy[k] as number;
    nx += pairs.gx[k] as number;
    ny += pairs.gy[k] as number;
  }
  mx /= n;
  my /= n;
  nx /= n;
  ny /= n;
  let along = 0;
  let across = 0;
  let spread = 0;
  for (const k of which) {
    const ux = (pairs.fx[k] as number) - mx;
    const uy = (pairs.fy[k] as number) - my;
    const vx = (pairs.gx[k] as number) - nx;
    const vy = (pairs.gy[k] as number) - ny;
    along += ux * vx + uy * vy;
    across += ux * vy - uy * vx;
    spread += ux * ux + uy * uy;
  }
  if (!(spread > 0)) return null;
  const a = along / spread;
  const b = across / spread;
  return [a, b, nx - (a * mx - b * my), ny - (b * mx + a * my)];
}

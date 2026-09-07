/** Row major three by three, mapping target image coordinates to frame coordinates. */
export type Homography = Float64Array;

export interface Correspondence {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface EstimateOptions {
  /** How far a point may land from where the fit predicts, in frame pixels, and still count. */
  threshold?: number;
  /** Hard ceiling on RANSAC rounds. The adaptive stop usually ends it far earlier. */
  maxIterations?: number;
  /** Deterministic seed, so a frame that failed can be replayed exactly. */
  seed?: number;
}

export function applyHomography(h: Homography, x: number, y: number): [number, number] {
  const w = (h[6] ?? 0) * x + (h[7] ?? 0) * y + (h[8] ?? 1);
  if (Math.abs(w) < 1e-12) return [Number.NaN, Number.NaN];
  return [
    ((h[0] ?? 0) * x + (h[1] ?? 0) * y + (h[2] ?? 0)) / w,
    ((h[3] ?? 0) * x + (h[4] ?? 0) * y + (h[5] ?? 0)) / w,
  ];
}

/**
 * Gaussian elimination with partial pivoting.
 *
 * Eight unknowns is small enough that this is all the linear algebra the system needs,
 * which is why there is no matrix dependency in this package.
 */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row]?.[col] ?? 0) > Math.abs(a[pivot]?.[col] ?? 0)) pivot = row;
    }
    if (Math.abs(a[pivot]?.[col] ?? 0) < 1e-12) return null;
    if (pivot !== col) {
      const rowA = a[col];
      const rowB = a[pivot];
      if (!rowA || !rowB) return null;
      a[col] = rowB;
      a[pivot] = rowA;
      const swapped = b[col] ?? 0;
      b[col] = b[pivot] ?? 0;
      b[pivot] = swapped;
    }
    const pivotRow = a[col];
    if (!pivotRow) return null;
    const pivotValue = pivotRow[col] ?? 0;
    for (let row = col + 1; row < n; row++) {
      const target = a[row];
      if (!target) continue;
      const factor = (target[col] ?? 0) / pivotValue;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) target[k] = (target[k] ?? 0) - factor * (pivotRow[k] ?? 0);
      b[row] = (b[row] ?? 0) - factor * (b[col] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    const source = a[row];
    if (!source) return null;
    let sum = b[row] ?? 0;
    for (let col = row + 1; col < n; col++) sum -= (source[col] ?? 0) * (x[col] ?? 0);
    const diagonal = source[row] ?? 0;
    if (Math.abs(diagonal) < 1e-12) return null;
    x[row] = sum / diagonal;
  }
  return x;
}

interface Normalisation {
  scale: number;
  cx: number;
  cy: number;
}

/**
 * Shift points to the origin and scale them so their mean distance from it is the square
 * root of two.
 *
 * Skipping this is the classic way to get a fit that looks almost right and drifts at the
 * edges, because the raw system is badly conditioned when coordinates are in the hundreds.
 */
function normalise(points: Array<[number, number]>): Normalisation {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;
  let mean = 0;
  for (const [x, y] of points) mean += Math.hypot(x - cx, y - cy);
  mean /= points.length;
  return { scale: mean > 1e-12 ? Math.SQRT2 / mean : 1, cx, cy };
}

/**
 * Direct linear transform, with the bottom right term fixed at one.
 *
 * Four correspondences give an exact answer; more are fitted by least squares through the
 * normal equations, which for eight unknowns is cheaper and far shorter than a
 * decomposition. Fixing the last term rules out the degenerate mappings that send the
 * plane to a line, which is what we want anyway.
 */
export function homographyFrom(pairs: Correspondence[]): Homography | null {
  if (pairs.length < 4) return null;
  const from = normalise(pairs.map((p) => [p.fromX, p.fromY] as [number, number]));
  const to = normalise(pairs.map((p) => [p.toX, p.toY] as [number, number]));

  const rows: number[][] = [];
  const values: number[] = [];
  for (const pair of pairs) {
    const x = (pair.fromX - from.cx) * from.scale;
    const y = (pair.fromY - from.cy) * from.scale;
    const u = (pair.toX - to.cx) * to.scale;
    const v = (pair.toY - to.cy) * to.scale;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }

  const ata: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const value = values[r] ?? 0;
    for (let i = 0; i < 8; i++) {
      const ri = row[i] ?? 0;
      const target = ata[i];
      if (!target) continue;
      for (let j = 0; j < 8; j++) target[j] = (target[j] ?? 0) + ri * (row[j] ?? 0);
      atb[i] = (atb[i] ?? 0) + ri * value;
    }
  }

  const solved = solve(ata, atb);
  if (!solved || solved.some((v) => !Number.isFinite(v))) return null;

  const normalised = [
    solved[0] ?? 0,
    solved[1] ?? 0,
    solved[2] ?? 0,
    solved[3] ?? 0,
    solved[4] ?? 0,
    solved[5] ?? 0,
    solved[6] ?? 0,
    solved[7] ?? 0,
    1,
  ];

  // Undo both normalisations. The solved matrix maps normalised source points to
  // normalised destination points, so it is wrapped: inverse(destination) times it times
  // source.
  const h = new Float64Array(9);
  const s = from.scale;
  for (let r = 0; r < 3; r++) {
    const a = normalised[r * 3] ?? 0;
    const b = normalised[r * 3 + 1] ?? 0;
    const c = normalised[r * 3 + 2] ?? 0;
    h[r * 3] = a * s;
    h[r * 3 + 1] = b * s;
    h[r * 3 + 2] = c - a * s * from.cx - b * s * from.cy;
  }
  const t = to.scale;
  for (let c = 0; c < 3; c++) {
    const row0 = h[c] ?? 0;
    const row1 = h[3 + c] ?? 0;
    const row2 = h[6 + c] ?? 0;
    h[c] = row0 / t + to.cx * row2;
    h[3 + c] = row1 / t + to.cy * row2;
  }

  const last = h[8] ?? 0;
  if (Math.abs(last) < 1e-12) return null;
  for (let i = 0; i < 9; i++) h[i] = (h[i] ?? 0) / last;
  return h.every((v) => Number.isFinite(v)) ? h : null;
}

export interface EstimateResult {
  homography: Homography;
  /** Indices into the input that agreed with the fit. */
  inliers: number[];
}

function xorshift32(seed: number): () => number {
  let state = seed | 0 || 0x2545_f491;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function inliersOf(h: Homography, pairs: Correspondence[], threshold: number): number[] {
  const limit = threshold * threshold;
  const inliers: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    const [x, y] = applyHomography(h, pair.fromX, pair.fromY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x - pair.toX;
    const dy = y - pair.toY;
    if (dx * dx + dy * dy <= limit) inliers.push(i);
  }
  return inliers;
}

/**
 * Fit a homography to correspondences that are partly wrong.
 *
 * Matching a print against a camera frame produces a healthy share of confident nonsense,
 * so the fit is chosen by agreement rather than by least squares over everything: sample
 * four, fit, count who agrees, keep the best, then refit on all of them. The number of
 * rounds adapts to how clean the data turns out to be, so easy frames cost little.
 */
export function estimateHomography(
  pairs: Correspondence[],
  options: EstimateOptions = {},
): EstimateResult | null {
  const threshold = options.threshold ?? 3;
  const maxIterations = options.maxIterations ?? 1000;
  if (pairs.length < 4) return null;

  const random = xorshift32(options.seed ?? 0x5bf0_3635);
  let bestInliers: number[] = [];
  let bestHomography: Homography | null = null;
  let rounds = maxIterations;

  for (let round = 0; round < rounds && round < maxIterations; round++) {
    const picked = new Set<number>();
    let guard = 0;
    while (picked.size < 4 && guard++ < 64) picked.add(Math.floor(random() * pairs.length));
    if (picked.size < 4) break;
    const sample = [...picked].map((i) => pairs[i]).filter((p): p is Correspondence => p !== undefined);
    if (sample.length < 4) continue;

    const candidate = homographyFrom(sample);
    if (!candidate) continue;
    const inliers = inliersOf(candidate, pairs, threshold);
    if (inliers.length <= bestInliers.length) continue;

    bestInliers = inliers;
    bestHomography = candidate;

    // Stop once the chance of not yet having drawn four clean points is under one per cent.
    const clean = (inliers.length / pairs.length) ** 4;
    if (clean > 0.999) break;
    if (clean > 0) {
      const needed = Math.log(0.01) / Math.log(1 - clean);
      if (Number.isFinite(needed)) rounds = Math.min(maxIterations, Math.ceil(needed));
    }
  }

  if (!bestHomography || bestInliers.length < 4) return null;

  const refitted = homographyFrom(
    bestInliers.map((i) => pairs[i]).filter((p): p is Correspondence => p !== undefined),
  );
  if (!refitted) return { homography: bestHomography, inliers: bestInliers };
  const refittedInliers = inliersOf(refitted, pairs, threshold);
  return refittedInliers.length >= bestInliers.length
    ? { homography: refitted, inliers: refittedInliers }
    : { homography: bestHomography, inliers: bestInliers };
}

import type { Corner } from "@taggant/vision";

export interface ReportInput {
  image: { width: number; height: number };
  corners: Corner[];
  /** Distance in millimetres at which a person is expected to hold the camera. */
  scanDistanceMm: number;
}

export interface Report {
  /** 0 to 100. Below 60 exactly when the artwork fails, so the two never disagree. */
  score: number;
  pass: boolean;
  featureCount: number;
  /** Areas of a 4 by 4 grid over the artwork that hold at least one feature. */
  areasWithFeatures: number;
  /** How many areas there are, so the count above reads without knowing the grid. */
  areas: number;
  /**
   * Typical distance between neighbouring features, as a fraction of the artwork's long
   * edge. Small means fine detail, which has to be printed larger to be readable by a
   * camera. Null when there are too few features to measure.
   */
  detail: number | null;
  /**
   * Smallest width, in millimetres, at which this artwork can be printed and still be
   * tracked at the given scan distance. Null when the artwork has no trackable detail at
   * all, which no width can fix.
   */
  minimumWidthMm: number | null;
  reasons: string[];
}

/**
 * Assumed camera resolving power, in pixels across a target one metre away.
 *
 * ASSUMPTION. It is the one number here that is not derived, and it is due to be replaced
 * by the measured value from the device benchmark. It is roughly a 1080p sensor over a 60
 * degree field, which is optimistic for a browser camera stream, where 720p is common.
 */
const PIXELS_PER_MM_AT_1M = 1.6;

/**
 * Camera pixels that must separate two neighbouring features.
 *
 * Below this the two merge into one blob in the frame and neither can be matched, so this
 * is resolution the print has to deliver rather than a margin of comfort.
 */
const MIN_PIXELS_BETWEEN_FEATURES = 6;

const MIN_FEATURES = 60;
const MIN_AREAS = 8;
const GRID = 4;

/**
 * Turn features into the verdict a printer actually needs: can this be tracked, and how
 * small can it be printed for the distance it will be scanned from.
 */
export function buildReport(input: ReportInput): Report {
  const { image, corners, scanDistanceMm } = input;
  if (!Number.isFinite(scanDistanceMm) || scanDistanceMm <= 0) {
    throw new RangeError(`scan distance must be a positive number of millimetres, got ${scanDistanceMm}`);
  }
  if (!(image.width > 0) || !(image.height > 0)) {
    throw new RangeError(`image must have a positive width and height, got ${image.width} x ${image.height}`);
  }
  const featureCount = corners.length;

  const cells = new Set<number>();
  for (const corner of corners) {
    // Clamped at both ends. buildReport is exported, so its caller's coordinates are not
    // this package's to trust, and an unclamped index puts the count above the grid size.
    const cx = clamp(Math.floor((corner.x / image.width) * GRID), 0, GRID - 1);
    const cy = clamp(Math.floor((corner.y / image.height) * GRID), 0, GRID - 1);
    cells.add(cy * GRID + cx);
  }
  const areasWithFeatures = cells.size;

  const detail = measureDetail(corners, Math.max(image.width, image.height));
  const pixelsPerMm = PIXELS_PER_MM_AT_1M * (1000 / scanDistanceMm);
  const minimumWidthMm =
    detail === null ? null : Math.ceil(MIN_PIXELS_BETWEEN_FEATURES / (pixelsPerMm * detail));

  const reasons: string[] = [];
  if (featureCount < MIN_FEATURES) reasons.push("too few features to track reliably");
  // Only when there are features to be concentrated. Telling someone their zero features
  // sit in one part of the artwork sends them to redistribute detail they do not have.
  else if (areasWithFeatures < MIN_AREAS) reasons.push("features are concentrated in part of the artwork");

  const pass = reasons.length === 0;
  return {
    score: scoreOf(featureCount / MIN_FEATURES, areasWithFeatures / MIN_AREAS, pass),
    pass,
    featureCount,
    areasWithFeatures,
    areas: GRID * GRID,
    detail,
    minimumWidthMm,
    reasons,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value) || value < low) return low;
  return value > high ? high : value;
}

/**
 * Score and verdict have to agree, so the score is built around the gates rather than
 * beside them: 60 is exactly the pass mark, below it is how far short the artwork falls,
 * above it is headroom.
 *
 * They used to be two independent formulas, which let one run print 35 out of 100 above
 * the word "ready" and another 78 above "not ready". Whichever number a reader trusted,
 * the other contradicted it.
 */
function scoreOf(featureRatio: number, areaRatio: number, pass: boolean): number {
  if (!pass) return Math.max(0, Math.min(59, Math.round(59 * Math.min(featureRatio, areaRatio))));
  const headroom = Math.min(1, (featureRatio - 1) / 3) * 0.6 + Math.min(1, areaRatio - 1) * 0.4;
  return Math.min(100, 60 + Math.round(40 * Math.max(0, headroom)));
}

/**
 * Typical spacing between neighbouring features, as a fraction of the artwork's long edge.
 *
 * This is the property that decides how large the artwork has to be printed, and it
 * belongs to the design rather than to the file it arrived in: fine, closely spaced detail
 * needs a bigger print than bold, open artwork at the same scan distance. The median is
 * used rather than the mean so that a handful of features crowded into one corner does not
 * speak for the whole page.
 */
function measureDetail(corners: Corner[], longEdge: number): number | null {
  if (corners.length < 2 || !(longEdge > 0)) return null;
  const spacings: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const corner = corners[i];
    if (!corner) continue;
    let nearest = Number.POSITIVE_INFINITY;
    for (let j = 0; j < corners.length; j++) {
      if (i === j) continue;
      const other = corners[j];
      if (!other) continue;
      const dx = other.x - corner.x;
      const dy = other.y - corner.y;
      const squared = dx * dx + dy * dy;
      if (squared < nearest) nearest = squared;
    }
    if (Number.isFinite(nearest)) spacings.push(Math.sqrt(nearest));
  }
  if (spacings.length === 0) return null;
  spacings.sort((a, b) => a - b);
  const median = spacings[Math.floor(spacings.length / 2)] ?? 0;
  return median > 0 ? median / longEdge : null;
}

import type { Corner } from "@taggant/vision";

/** One size the artwork was described at, with the features found there. */
export interface Level {
  scale: number;
  corners: Corner[];
}

export interface ReportInput {
  image: { width: number; height: number };
  /** Every size the artwork was described at. */
  levels: Level[];
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
  /** Pixels across the artwork as it was analysed. The width below is derived from it. */
  analysisWidth: number;
  /**
   * Smallest size, as a fraction of the analysed artwork, at which it still holds up.
   * Most artwork reaches the bottom of the range the compiled target covers.
   */
  smallestUsableScale: number;
  /**
   * Smallest width, in millimetres, at which this artwork can be printed and still be
   * recognised at the given scan distance. Null when it does not pass at all.
   *
   * This is a resolution requirement, not a judgement of the design. It follows from the
   * camera's assumed resolving power, the scan distance, and the pixel width of the
   * smallest size the compiled target covers.
   */
  minimumWidthMm: number | null;
  reasons: string[];
}

/**
 * Assumed camera resolving power, in pixels across a target one metre away.
 *
 * ASSUMPTION. It is the one number here that is not derived, and it is due to be replaced
 * by the measured value from the device benchmark. It is roughly a 1080p sensor over a 60
 * degree field, which is optimistic for a browser camera stream: 720p is more common.
 */
const PIXELS_PER_MM_AT_1M = 1.6;

const MIN_FEATURES = 60;
const MIN_AREAS = 8;
const GRID = 4;

/**
 * Turn the features found at each size into the verdict a printer needs.
 *
 * The minimum width deserves a note, because getting it wrong costs a press run and the
 * first two attempts were wrong in different ways. It was once computed without reference
 * to the artwork at all, which made it the scan distance over ten for every file. It was
 * then derived from the spacing between neighbouring features, which on any densely
 * featured artwork just measures the detector's own minimum spacing, and where it did
 * vary it told printers that bold artwork needed a larger print than fine artwork, which
 * is backwards.
 *
 * Measured across designs from bold to very fine, every one survives to the bottom of the
 * size range the compiled target covers. That is the real answer: for a feature based
 * tracker this width is set by the camera and by the pixel range of the target, and the
 * artwork's part in it is close to a pass or a fail. So it is computed from the things
 * that set it, and the report carries both of them so the number can be checked.
 */
export function buildReport(input: ReportInput): Report {
  const { image, levels, scanDistanceMm } = input;
  if (!Number.isFinite(scanDistanceMm) || scanDistanceMm <= 0) {
    throw new RangeError(`scan distance must be a positive number of millimetres, got ${scanDistanceMm}`);
  }
  if (!(image.width > 0) || !(image.height > 0)) {
    throw new RangeError(`image must have a positive width and height, got ${image.width} x ${image.height}`);
  }

  const base = levels.find((level) => level.scale === 1)?.corners ?? levels[0]?.corners ?? [];
  const featureCount = base.length;
  const areasWithFeatures = areasTouched(base, image);

  const reasons: string[] = [];
  if (featureCount < MIN_FEATURES) reasons.push("too few features to track reliably");
  else if (areasWithFeatures < MIN_AREAS) reasons.push("features are concentrated in part of the artwork");
  const pass = reasons.length === 0;

  // The smallest size that still holds up. A camera further away than this puts fewer
  // pixels across the mark than any size the target covers, and nothing will match.
  let smallestUsableScale = 1;
  for (const level of [...levels].sort((a, b) => b.scale - a.scale)) {
    if (!holdsUp(level.corners, image)) break;
    smallestUsableScale = level.scale;
  }

  const pixelsPerMm = PIXELS_PER_MM_AT_1M * (1000 / scanDistanceMm);
  const minimumWidthMm = pass ? Math.ceil((smallestUsableScale * image.width) / pixelsPerMm) : null;

  return {
    score: scoreOf(featureCount / MIN_FEATURES, areasWithFeatures / MIN_AREAS, pass),
    pass,
    featureCount,
    areasWithFeatures,
    areas: GRID * GRID,
    analysisWidth: image.width,
    smallestUsableScale,
    minimumWidthMm,
    reasons,
  };
}

/** The line that goes next to the number, so nobody reads it as a measurement of the design. */
export function describeWidth(report: Report, scanDistanceMm: number): string {
  if (report.minimumWidthMm === null) return "not printable until the artwork passes";
  const pixels = Math.round(report.smallestUsableScale * report.analysisWidth);
  return `${report.minimumWidthMm} mm to be read from ${scanDistanceMm} mm away, being ${pixels} px across the artwork`;
}

function areasTouched(corners: Corner[], image: { width: number; height: number }): number {
  const cells = new Set<number>();
  for (const corner of corners) {
    // Clamped at both ends: buildReport is exported, so its caller's coordinates are not
    // this package's to trust, and an unclamped index puts the count above the grid size.
    const cx = clamp(Math.floor((corner.x / image.width) * GRID), 0, GRID - 1);
    const cy = clamp(Math.floor((corner.y / image.height) * GRID), 0, GRID - 1);
    cells.add(cy * GRID + cx);
  }
  return cells.size;
}

function holdsUp(corners: Corner[], image: { width: number; height: number }): boolean {
  return corners.length >= MIN_FEATURES && areasTouched(corners, image) >= MIN_AREAS;
}

function clamp(value: number, low: number, high: number): number {
  return value < low || Number.isNaN(value) ? low : value > high ? high : value;
}

/**
 * Score and verdict have to agree, so the score is built around the gates rather than
 * beside them: 60 is exactly the pass mark, everything below it is how far short the
 * artwork falls, and everything above is headroom.
 *
 * They were two independent formulas, which let a run print 35 out of 100 above the word
 * "ready" and 78 above "not ready". Whichever number a reader trusted, the other one
 * contradicted it.
 */
function scoreOf(featureRatio: number, areaRatio: number, pass: boolean): number {
  const worst = Math.min(featureRatio, areaRatio);
  if (!pass) return Math.max(0, Math.min(59, Math.round(59 * worst)));
  const headroom = Math.min(1, (featureRatio - 1) / 3) * 0.6 + Math.min(1, areaRatio - 1) * 0.4;
  return Math.min(100, 60 + Math.round(40 * headroom));
}

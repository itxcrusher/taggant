import type { Corner } from "./features.js";

export interface ReportInput {
  image: { width: number; height: number };
  corners: Corner[];
  /** Distance in millimetres at which a person is expected to hold the camera. */
  scanDistanceMm: number;
}

export interface Report {
  /** 0 to 100. Comparable across artwork, unlike raw corner strength. */
  score: number;
  pass: boolean;
  featureCount: number;
  /** Share of a 4 by 4 grid over the artwork that contains at least one feature. */
  coverage: number;
  minimumWidthMm: number;
  reasons: string[];
}

/**
 * Assumed camera resolving power, in pixels across a target one metre away.
 *
 * ASSUMPTION. It is the one number here that is not derived, and it is due to be
 * replaced by the measured value from the device benchmark.
 */
const PIXELS_PER_MM_AT_1M = 1.6;
const REQUIRED_PIXELS_ACROSS = 160;
const MIN_FEATURES = 60;
const MIN_COVERAGE = 0.5;

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
    const cx = Math.min(3, Math.floor((corner.x / image.width) * 4));
    const cy = Math.min(3, Math.floor((corner.y / image.height) * 4));
    cells.add(cy * 4 + cx);
  }
  const coverage = cells.size / 16;

  const pixelsPerMm = PIXELS_PER_MM_AT_1M * (1000 / scanDistanceMm);
  const minimumWidthMm = Math.ceil(REQUIRED_PIXELS_ACROSS / pixelsPerMm);

  const reasons: string[] = [];
  if (featureCount < MIN_FEATURES) reasons.push("too few features to track reliably");
  if (coverage < MIN_COVERAGE) reasons.push("features are concentrated in part of the artwork");

  const featureScore = Math.min(1, featureCount / (MIN_FEATURES * 4));
  const score = Math.round((featureScore * 0.6 + coverage * 0.4) * 100);

  return { score, pass: reasons.length === 0, featureCount, coverage, minimumWidthMm, reasons };
}

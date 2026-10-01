import {
  DEFAULT_SCALES,
  type TargetFeature,
  type TargetFile,
  buildTrackingFeatures,
  toTargetFile,
} from "@taggant/vision";
import { loadGrayscale } from "./load.js";
import { recognitionOf } from "./recognise.js";
import { type Report, buildReport } from "./report.js";

export interface CompileOptions {
  id: string;
  /** Distance in millimetres at which the print is expected to be scanned. */
  scanDistanceMm: number;
  /** Features taken from each size the artwork is described at. */
  perScale?: number;
}

export interface CompiledTarget {
  formatVersion: 2;
  id: string;
  width: number;
  height: number;
  features: TargetFeature[];
  report: Report;
}

/** Turn artwork into everything a runtime and a printer need to know about it. */
export async function compileTarget(artwork: Buffer, options: CompileOptions): Promise<CompiledTarget> {
  const image = await loadGrayscale(artwork);
  const features = buildTrackingFeatures(image, { perScale: options.perScale ?? 300 });

  // Grouped by the size each feature was found at, so the report can say how small the
  // artwork can get and still hold up. Nothing is recomputed here. The report sees only
  // features that could be described, because a corner too near the edge to describe is
  // one no runtime will ever use, and promising features the runtime does not have is a
  // report that lies about press readiness.
  // Every size the features were looked for at, including one where none were found. Taken
  // from what was found instead, a size that found nothing was absent rather than empty, and
  // the report walks sizes from the largest down and stops at the first that does not hold
  // up: an empty size stops it, an absent one is stepped over to a smaller healthy one, and
  // the width came out more than a third too small (308 mm against 487 in the review).
  const scales = [...DEFAULT_SCALES];
  const report = buildReport({
    image: { width: image.width, height: image.height },
    levels: scales.map((scale) => ({
      scale,
      corners: features.filter((feature) => feature.scale === scale),
    })),
    described: features.filter((feature) => feature.scale === 1),
    scanDistanceMm: options.scanDistanceMm,
    recognises: recognitionOf(image, features),
  });

  return { formatVersion: 2, id: options.id, width: image.width, height: image.height, features, report };
}

/** The target in the shape that is written to disk, with the report alongside it. */
export function toTargetJson(target: CompiledTarget): TargetFile & { report: Report } {
  return { ...toTargetFile(target), report: target.report };
}

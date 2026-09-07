import { type TargetFeature, type TargetFile, buildTrackingFeatures, toTargetFile } from "@taggant/vision";
import { loadGrayscale } from "./load.js";
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

  // The report describes the artwork, not the target file, so it counts each place on the
  // print once. It counts only features that could be described, because a corner too
  // near the edge to describe is a corner no runtime will ever use, and a report that
  // promises features the runtime does not have is a report that lies about press
  // readiness.
  const report = buildReport({
    image: { width: image.width, height: image.height },
    corners: features.filter((feature) => feature.scale === 1),
    scanDistanceMm: options.scanDistanceMm,
  });

  return { formatVersion: 2, id: options.id, width: image.width, height: image.height, features, report };
}

/** The target in the shape that is written to disk, with the report alongside it. */
export function toTargetJson(target: CompiledTarget): TargetFile & { report: Report } {
  return { ...toTargetFile(target), report: target.report };
}

import { type Corner, detectCorners } from "./features.js";
import { loadGrayscale } from "./load.js";
import { type Report, buildReport } from "./report.js";

export interface CompileOptions {
  id: string;
  /** Distance in millimetres at which the print is expected to be scanned. */
  scanDistanceMm: number;
  maxCorners?: number;
}

export interface CompiledTarget {
  formatVersion: 1;
  id: string;
  width: number;
  height: number;
  features: Corner[];
  report: Report;
}

/** Turn artwork into everything a runtime and a printer need to know about it. */
export async function compileTarget(artwork: Buffer, options: CompileOptions): Promise<CompiledTarget> {
  const image = await loadGrayscale(artwork);
  const features = detectCorners(image, { maxCorners: options.maxCorners ?? 500 });
  const report = buildReport({
    image: { width: image.width, height: image.height },
    corners: features,
    scanDistanceMm: options.scanDistanceMm,
  });
  return { formatVersion: 1, id: options.id, width: image.width, height: image.height, features, report };
}

export { compileTarget, toTargetJson } from "./compile.js";
export type { CompileOptions, CompiledTarget } from "./compile.js";
export { loadGrayscale } from "./load.js";
export type { LoadOptions } from "./load.js";
export {
  FRAME_WIDTH_MM_AT_1M,
  RECOGNISED_PIXELS_ACROSS_FRAME,
  WIDEST_DECLARABLE_MM,
  buildReport,
  carriesItsDistance,
  distanceBehind,
} from "./report.js";
export type { Report, ReportInput } from "./report.js";

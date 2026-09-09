export { Camera, CameraError, type CameraFailure, type CameraOptions } from "./camera.js";
export { type BuiltContent, buildContent } from "./content.js";
export {
  type ExperienceOptions,
  type ExperienceState,
  type MountedExperience,
  mountExperience,
} from "./experience.js";
export { cssMatrixFor, type Size } from "./overlay.js";
export { type Pose, type Recogniser, createRecogniser } from "./recogniser.js";
/**
 * Turning a compiled target file into something to track against.
 *
 * Re-exported because the published page needs it and already loads this runtime, which
 * bundles the vision core. Without it the page imported a second build of the same code
 * and every bundle shipped it twice, about 27 KB the second time.
 */
export { fromTargetFile, type TargetFile } from "@taggant/vision";

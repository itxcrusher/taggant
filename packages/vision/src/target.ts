import { type DescribedCorner, describeCorners } from "./describe.js";
import { detectCorners } from "./features.js";
import { type GrayscaleImage, resample, smooth } from "./image.js";

/**
 * Scales the artwork is described at.
 *
 * A descriptor is only comparable with another taken at roughly the same size, so artwork
 * described once at full size stops matching as soon as someone stands further back. Each
 * step is about a quarter smaller than the last, which is close enough that any distance
 * in between still lands near a level. Four levels covers roughly a factor of two in
 * distance, which is the range a person holds a print at.
 */
export const DEFAULT_SCALES = [1, 0.79, 0.63, 0.5] as const;

export interface TargetFeature extends DescribedCorner {
  /** Which level of the target this feature was described at. */
  scale: number;
}

export interface BuildOptions {
  scales?: readonly number[];
  /** Corners taken from each level. */
  perScale?: number;
}

/**
 * Describe artwork at several sizes, with every feature reported in the artwork's own
 * coordinates.
 *
 * Normalising the coordinates here rather than at match time is what lets the pose come
 * straight out of the fit: whichever level a feature was found at, it says where it is on
 * the printed piece.
 */
export function buildTrackingFeatures(image: GrayscaleImage, options: BuildOptions = {}): TargetFeature[] {
  const scales = options.scales ?? DEFAULT_SCALES;
  const perScale = options.perScale ?? 300;
  const features: TargetFeature[] = [];
  for (const scale of scales) {
    const level = smooth(resample(image, scale));
    const described = describeCorners(level, detectCorners(level, { maxCorners: perScale }));
    for (const corner of described) {
      features.push({ ...corner, x: corner.x / scale, y: corner.y / scale, scale });
    }
  }
  return features;
}

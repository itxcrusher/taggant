import { type Homography, estimateHomography } from "./homography.js";
import type { GrayscaleImage } from "./image.js";
import { matchDescriptors } from "./match.js";
import { type TargetFeature, buildTrackingFeatures } from "./target.js";

/** What the compiler produces and the runtime consumes: artwork reduced to what identifies it. */
export interface TrackingTarget {
  id: string;
  /** Size of the artwork the features were measured in, in pixels. */
  width: number;
  height: number;
  features: TargetFeature[];
}

export interface LocateOptions {
  /** Corners to take from each size the frame is described at. */
  maxCorners?: number;
  /**
   * Sizes the frame is described at.
   *
   * Two, because a frame is not just a smaller view of the print, it is a softer one. A
   * camera that is slightly out of focus moves detail down the scale the same way distance
   * does, and a descriptor taken from a sharp file does not match one taken from a soft
   * photograph of it unless somewhere on one side there is a level that is soft too.
   */
  scales?: readonly number[];
  /** Matches that must survive the fit before a pose is believed. */
  minInliers?: number;
}

export interface LocateResult {
  found: boolean;
  /** Maps artwork coordinates to frame coordinates. Null when the artwork was not found. */
  homography: Homography | null;
  /** Matches that agreed with the fit. The honest measure of how sure this is. */
  inliers: number;
  /** Matches found before the fit, whether or not they survived it. */
  matches: number;
}

const NOT_FOUND: LocateResult = { found: false, homography: null, inliers: 0, matches: 0 };

/**
 * Sizes a frame is described at, in the order they are tried.
 *
 * Two, because a frame is not just a smaller view of the print, it is a softer one: a
 * camera slightly out of focus moves detail down the scale the way distance does.
 */
const DEFAULT_FRAME_SCALES = [1, 0.79] as const;

/**
 * Find compiled artwork in a camera frame and work out where it is.
 *
 * The minimum inlier count is what stops the system hallucinating. A homography can
 * always be fitted to four points, so without a floor every frame reports a confident
 * pose, including frames pointed at a wall.
 */
export function locate(
  frame: GrayscaleImage,
  target: TrackingTarget,
  options: LocateOptions = {},
): LocateResult {
  const minInliers = options.minInliers ?? 10;
  const perScale = options.maxCorners ?? 400;
  if (frame.width < 1 || frame.height < 1 || target.features.length === 0) return NOT_FOUND;

  const scales = options.scales ?? DEFAULT_FRAME_SCALES;
  // The first size is tried on its own before the rest are paid for. Describing a frame is
  // the most expensive thing in the loop, and on a frame where the artwork is squarely in
  // view the first size finds it, so the common case costs one size and only a frame that
  // is genuinely hard costs them all.
  let attempt = attemptAt(frame, target, [scales[0] ?? 1], perScale, minInliers);
  if (!attempt.found && scales.length > 1) {
    attempt = attemptAt(frame, target, scales, perScale, minInliers);
  }
  return attempt;
}

function attemptAt(
  frame: GrayscaleImage,
  target: TrackingTarget,
  scales: readonly number[],
  perScale: number,
  minInliers: number,
): LocateResult {
  const described = buildTrackingFeatures(frame, { scales, perScale });
  if (described.length < 4) return NOT_FOUND;

  const matches = matchDescriptors(
    described.map((c) => c.descriptor),
    target.features.map((c) => c.descriptor),
    {
      targetPositions: target.features.map((c) => ({ x: c.x, y: c.y })),
      queryPositions: described.map((c) => ({ x: c.x, y: c.y })),
    },
  );
  if (matches.length < minInliers) {
    return { found: false, homography: null, inliers: 0, matches: matches.length };
  }

  const estimate = estimateHomography(
    matches.map((match) => {
      const frameCorner = described[match.query];
      const targetCorner = target.features[match.target];
      return {
        fromX: targetCorner?.x ?? 0,
        fromY: targetCorner?.y ?? 0,
        toX: frameCorner?.x ?? 0,
        toY: frameCorner?.y ?? 0,
      };
    }),
  );
  if (!estimate || estimate.inliers.length < minInliers) {
    return {
      found: false,
      homography: null,
      inliers: estimate?.inliers.length ?? 0,
      matches: matches.length,
    };
  }

  return {
    found: true,
    homography: estimate.homography,
    inliers: estimate.inliers.length,
    matches: matches.length,
  };
}

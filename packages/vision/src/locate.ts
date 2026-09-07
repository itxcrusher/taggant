import { type DescribedCorner, describeCorners } from "./describe.js";
import { detectCorners } from "./features.js";
import { type Homography, estimateHomography } from "./homography.js";
import type { GrayscaleImage } from "./image.js";
import { matchDescriptors } from "./match.js";

/** What the compiler produces and the runtime consumes: artwork reduced to what identifies it. */
export interface TrackingTarget {
  id: string;
  /** Size of the artwork the features were measured in, in pixels. */
  width: number;
  height: number;
  features: DescribedCorner[];
}

export interface LocateOptions {
  /** Corners to take from the frame. More is slower and, past a point, no more accurate. */
  maxCorners?: number;
  /** Minimum pixels between two frame corners. */
  minDistance?: number;
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
  if (frame.width < 1 || frame.height < 1 || target.features.length === 0) return NOT_FOUND;

  const corners = detectCorners(frame, {
    maxCorners: options.maxCorners ?? 600,
    minDistance: options.minDistance ?? 6,
  });
  const described = describeCorners(frame, corners);
  if (described.length < 4) return NOT_FOUND;

  const matches = matchDescriptors(
    described.map((c) => c.descriptor),
    target.features.map((c) => c.descriptor),
    { targetPositions: target.features.map((c) => ({ x: c.x, y: c.y })) },
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

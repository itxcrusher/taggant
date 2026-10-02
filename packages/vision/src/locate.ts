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

/**
 * A fresh result each time.
 *
 * It was one object shared by every call, and nothing about the result type says not to write
 * to it: a caller that set `found` on one not-found result made every later one report found,
 * with a null pose, which is the hallucination the inlier floor exists to prevent arriving by
 * a route that skips the floor entirely.
 */
function notFound(): LocateResult {
  return { found: false, homography: null, inliers: 0, matches: 0 };
}

/**
 * What matching needs from a target, worked out once per target rather than once per frame.
 *
 * The descriptors and positions were mapped out of the target on every call, so the matcher
 * saw new arrays every frame and could not keep the table of which features share a spot,
 * which is quadratic in the target's size. Measured on one harness with and without this: no
 * difference at the sizes the compiler writes (53 ms either way at 749 features, 69 against 59
 * at 1111), and a third of each frame at 12 000 features (463 ms against 308 after the first),
 * which a target file can hold because nothing caps its feature count. So this bounds what a
 * large target costs per frame rather than speeding up an ordinary one.
 *
 * Keyed on the target object and checked against its features before each use, in one pass
 * that costs nothing beside a frame. It was trusted once made, and the pose was then fitted from
 * the live features with indices into the kept copy: a target whose features were reordered
 * after one locate was not found, 6 points where a fresh object gave 58.
 */
interface Prepared {
  /** The features this was made from, so a change to the list or to any one of them shows. */
  source: TargetFeature[];
  xs: Float64Array;
  ys: Float64Array;
  descriptors: Uint32Array[];
  positions: { x: number; y: number }[];
}

const prepared = new WeakMap<TrackingTarget, Prepared>();

function stillDescribes(held: Prepared, features: TargetFeature[]): boolean {
  if (held.source !== features || held.descriptors.length !== features.length) return false;
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (
      feature === undefined ||
      feature.descriptor !== held.descriptors[i] ||
      feature.x !== held.xs[i] ||
      feature.y !== held.ys[i]
    ) {
      return false;
    }
  }
  return true;
}

function preparedFor(target: TrackingTarget): Prepared {
  let held = prepared.get(target);
  if (held === undefined || !stillDescribes(held, target.features)) {
    const features = target.features;
    held = {
      source: features,
      xs: Float64Array.from(features, (c) => c.x),
      ys: Float64Array.from(features, (c) => c.y),
      descriptors: features.map((c) => c.descriptor),
      positions: features.map((c) => ({ x: c.x, y: c.y })),
    };
    prepared.set(target, held);
  }
  return held;
}

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
  if (frame.width < 1 || frame.height < 1 || target.features.length === 0) return notFound();

  const scales = options.scales ?? DEFAULT_FRAME_SCALES;
  // The first size is tried on its own before the rest are paid for. Describing a frame is
  // the most expensive thing in the loop, and on a frame where the artwork is squarely in
  // view the first size finds it, so the common case costs one size and only a frame that
  // is genuinely hard costs them all.
  const first = attemptAt(frame, target, [scales[0] ?? 1], perScale, minInliers);
  if (first.found || scales.length < 2) return first;

  // Only the sizes not already tried. Repeating the first one here would put the waste on
  // the frame that was already the slowest.
  const rest = attemptAt(frame, target, scales.slice(1), perScale, minInliers);
  return rest.found || rest.matches >= first.matches ? rest : first;
}

function attemptAt(
  frame: GrayscaleImage,
  target: TrackingTarget,
  scales: readonly number[],
  perScale: number,
  minInliers: number,
): LocateResult {
  const described = buildTrackingFeatures(frame, { scales, perScale });
  if (described.length < 4) return notFound();

  const side = preparedFor(target);
  const matches = matchDescriptors(
    described.map((c) => c.descriptor),
    side.descriptors,
    {
      targetPositions: side.positions,
      queryPositions: described.map((c) => ({ x: c.x, y: c.y })),
    },
  );
  if (matches.length < minInliers) {
    return { found: false, homography: null, inliers: 0, matches: matches.length };
  }

  const estimate = estimateHomography(
    matches.map((match) => {
      const frameCorner = described[match.query];
      // From the copy the matches index into, never from the live features.
      const targetCorner = side.positions[match.target];
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

import { type TrackingTarget, locate } from "@taggant/vision";

/**
 * Recognition, off the page's thread.
 *
 * Finding artwork in a frame costs tens of milliseconds, and on the main thread that is
 * time where the camera preview does not repaint and nothing the viewer touches responds.
 * `bench/cost.mjs` measures it against the compiled example at 480 by 360: on a desktop,
 * medians of 49 ms and 73 ms across two runs, single calls from 22 ms to 168 ms. The
 * spread matters more than the median, and a phone is slower by an unmeasured amount.
 */

interface SetTargets {
  type: "targets";
  targets: SerialisedTarget[];
}

interface Frame {
  type: "frame";
  id: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface SerialisedTarget {
  id: string;
  width: number;
  height: number;
  features: Array<{
    x: number;
    y: number;
    scale: number;
    angle: number;
    strength: number;
    descriptor: number[] | Uint32Array;
  }>;
}

export interface WorkerResult {
  type: "result";
  id: number;
  poses: Array<{ id: string; homography: number[] | null; inliers: number }>;
}

let targets: TrackingTarget[] = [];

function rebuild(serialised: SerialisedTarget[]): TrackingTarget[] {
  return serialised.map((target) => ({
    id: target.id,
    width: target.width,
    height: target.height,
    features: target.features.map((feature) => ({
      x: feature.x,
      y: feature.y,
      scale: feature.scale,
      angle: feature.angle,
      strength: feature.strength,
      // Descriptors cross the wire as plain arrays; a typed array does not survive JSON,
      // and a structured clone of one per feature costs more than rebuilding once.
      descriptor:
        feature.descriptor instanceof Uint32Array ? feature.descriptor : Uint32Array.from(feature.descriptor),
    })),
  }));
}

self.addEventListener("message", (event: MessageEvent<SetTargets | Frame>) => {
  const message = event.data;
  if (message.type === "targets") {
    targets = rebuild(message.targets);
    return;
  }

  const frame = { width: message.width, height: message.height, data: new Uint8Array(message.data) };
  const poses = targets.map((target) => {
    const result = locate(frame, target);
    return {
      id: target.id,
      homography: result.found && result.homography ? [...result.homography] : null,
      inliers: result.inliers,
    };
  });
  const reply: WorkerResult = { type: "result", id: message.id, poses };
  (self as unknown as Worker).postMessage(reply);
});

import { type GrayscaleImage, type Homography, type TrackingTarget, locate } from "@taggant/vision";
import type { SerialisedTarget, WorkerResult } from "./worker.js";

export interface Pose {
  id: string;
  homography: Homography | null;
  inliers: number;
}

/**
 * How long a frame may sit with the worker before it is treated as gone.
 *
 * Generous next to the couple of hundred milliseconds recognition takes, because a busy
 * phone can be slow without being broken. A worker that is terminated fires neither a
 * reply nor an error, so without this the loop waits on a promise that never settles and
 * the page goes on claiming it is tracking with content frozen on screen.
 */
const REPLY_TIMEOUT_MS = 5000;

export interface Recogniser {
  /**
   * Answer for this frame, or null if one is already being worked on.
   *
   * Frames arrive far faster than they can be recognised, so the ones that arrive while a
   * frame is in flight are dropped rather than queued. A queue here would only build a
   * backlog of poses for positions the print has already left.
   */
  submit(frame: GrayscaleImage): Promise<Pose[] | null>;
  /** Whether recognition is running off the page's thread. */
  readonly threaded: boolean;
  stop(): void;
}

function serialise(targets: TrackingTarget[]): SerialisedTarget[] {
  return targets.map((target) => ({
    id: target.id,
    width: target.width,
    height: target.height,
    features: target.features.map((feature) => ({
      x: feature.x,
      y: feature.y,
      scale: feature.scale,
      angle: feature.angle,
      strength: feature.strength,
      descriptor: [...feature.descriptor],
    })),
  }));
}

/**
 * Recognition, in a worker where the browser allows one and on the page's thread where it
 * does not.
 *
 * The fallback is not a formality. A worker needs the runtime to be served as a module
 * from a URL, which is the ordinary case and not the only one, and a runtime that simply
 * stops working when it cannot have a thread is worse than one that runs slowly.
 */
export function createRecogniser(targets: TrackingTarget[]): Recogniser {
  const worker = spawn();
  if (!worker) return onThisThread(targets);

  worker.postMessage({ type: "targets", targets: serialise(targets) });

  let busy = false;
  let nextId = 1;
  return {
    threaded: true,
    async submit(frame) {
      if (busy) return null;
      busy = true;
      const id = nextId++;
      const copy = frame.data.slice();
      try {
        return await new Promise<Pose[]>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            worker.removeEventListener("message", done);
            worker.removeEventListener("error", failed);
          };
          const done = (event: MessageEvent<WorkerResult>) => {
            if (event.data?.type !== "result" || event.data.id !== id) return;
            finish();
            resolve(
              event.data.poses.map((pose) => ({
                id: pose.id,
                homography: pose.homography ? Float64Array.from(pose.homography) : null,
                inliers: pose.inliers,
              })),
            );
          };
          const failed = (event: ErrorEvent) => {
            finish();
            reject(new Error(event.message || "the recognition worker failed"));
          };
          const timer = setTimeout(() => {
            finish();
            reject(new Error(`the recognition worker did not answer within ${REPLY_TIMEOUT_MS} ms`));
          }, REPLY_TIMEOUT_MS);
          worker.addEventListener("message", done);
          worker.addEventListener("error", failed);
          // The buffer is transferred rather than copied, so a frame costs no allocation
          // on the way out.
          worker.postMessage(
            { type: "frame", id, width: frame.width, height: frame.height, data: copy.buffer },
            [copy.buffer],
          );
        });
      } finally {
        busy = false;
      }
    },
    stop() {
      worker.terminate();
    },
  };
}

function spawn(): Worker | null {
  try {
    // Resolved against this module's own URL, which is what lets a consumer's bundler find
    // the worker and what makes it work when the runtime is served as plain modules.
    return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

function onThisThread(targets: TrackingTarget[]): Recogniser {
  let busy = false;
  return {
    threaded: false,
    async submit(frame) {
      if (busy) return null;
      busy = true;
      try {
        return targets.map((target) => {
          const result = locate(frame, target);
          return { id: target.id, homography: result.homography, inliers: result.inliers };
        });
      } finally {
        busy = false;
      }
    },
    stop() {},
  };
}

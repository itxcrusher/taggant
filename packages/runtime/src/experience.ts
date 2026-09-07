import type { TaggantExperienceManifest } from "@taggant/manifest";
import { type TrackingTarget, locate } from "@taggant/vision";
import { Camera, CameraError, type CameraOptions } from "./camera.js";
import { buildContent } from "./content.js";
import { cssMatrixFor } from "./overlay.js";

export type ExperienceState = "idle" | "requesting" | "denied" | "searching" | "tracking" | "error";

export interface ExperienceOptions extends CameraOptions {
  /** Turn a manifest src into a URL this page can load. Defaults to leaving it alone. */
  resolve?: (src: string) => string;
  /**
   * Frames a target must be missing from before its content is taken away.
   *
   * Recognition is per frame and independent, so a single frame where the artwork is not
   * found is normal: a hand moves, the focus hunts. Hiding on the first miss makes content
   * flicker in a way that reads as broken.
   */
  patience?: number;
  onStateChange?: (state: ExperienceState) => void;
}

export interface MountedExperience {
  readonly state: ExperienceState;
  /** Content types in the manifest this build cannot show. */
  readonly unsupported: readonly string[];
  stop(): void;
}

/**
 * Run an experience: open the camera, look for the artwork in every frame, and put the
 * manifest's content on it when it is there.
 *
 * The container ends up holding the camera picture with one absolutely positioned element
 * per target over it, each carrying the pose as a transform. Nothing about a target's
 * position lives anywhere else, so a frame where nothing is found costs one hidden
 * attribute rather than a rebuild.
 */
export async function mountExperience(options: {
  manifest: TaggantExperienceManifest;
  targets: TrackingTarget[];
  container: HTMLElement;
  options?: ExperienceOptions;
}): Promise<MountedExperience> {
  const settings = options.options ?? {};
  const resolve = settings.resolve ?? ((src: string) => src);
  const patience = settings.patience ?? 4;

  const { container } = options;
  container.style.position = container.style.position || "relative";
  container.style.overflow = "hidden";

  const video = document.createElement("video");
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.objectFit = "cover";
  video.style.display = "block";
  container.append(video);

  const stage = document.createElement("div");
  stage.style.position = "absolute";
  stage.style.inset = "0";
  stage.style.transformOrigin = "0 0";
  stage.style.pointerEvents = "none";
  container.append(stage);

  const unsupported = new Set<string>();
  const overlays = new Map<string, { element: HTMLElement; target: TrackingTarget; missed: number }>();
  for (const target of options.targets) {
    const described = options.manifest.targets.find((entry) => entry.id === target.id);
    if (!described) continue;
    const built = buildContent(described, resolve);
    for (const type of built.unsupported) unsupported.add(type);
    stage.append(built.element);
    overlays.set(target.id, { element: built.element, target, missed: patience });
  }

  let state: ExperienceState = "idle";
  const setState = (next: ExperienceState) => {
    if (next === state) return;
    state = next;
    container.dataset.state = next;
    settings.onStateChange?.(next);
  };
  setState("requesting");

  const camera = new Camera(video, settings);
  try {
    await camera.start();
  } catch (error) {
    setState(error instanceof CameraError && error.reason === "denied" ? "denied" : "error");
    // The fallback exists for exactly this: the viewer scanned something and the camera
    // is not going to open, so send them where the manifest says to send them.
    const fallback = options.manifest.fallback;
    if (fallback) globalThis.location?.assign(fallback);
    return {
      get state() {
        return state;
      },
      unsupported: [...unsupported],
      stop: () => camera.stop(),
    };
  }

  setState("searching");
  let running = true;

  const step = () => {
    if (!running) return;
    const frame = camera.grab();
    if (frame) {
      const displayed = {
        width: video.clientWidth || frame.width,
        height: video.clientHeight || frame.height,
      };
      let anyFound = false;
      for (const overlay of overlays.values()) {
        const result = locate(frame, overlay.target);
        if (result.found && result.homography) {
          overlay.missed = 0;
          overlay.element.style.transform = cssMatrixFor(result.homography, frame, displayed);
          overlay.element.style.width = `${overlay.target.width}px`;
          overlay.element.style.height = `${overlay.target.height}px`;
          overlay.element.hidden = false;
          anyFound = true;
        } else if (++overlay.missed >= patience) {
          overlay.element.hidden = true;
        } else {
          anyFound = true;
        }
      }
      setState(anyFound ? "tracking" : "searching");
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  return {
    get state() {
      return state;
    },
    unsupported: [...unsupported],
    stop() {
      running = false;
      camera.stop();
    },
  };
}

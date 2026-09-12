import type { TaggantExperienceManifest } from "@taggant/manifest";
import type { TrackingTarget } from "@taggant/vision";
import { Camera, CameraError, type CameraOptions } from "./camera.js";
import { buildContent } from "./content.js";
import { cssMatrixFor } from "./overlay.js";
import { createRecogniser } from "./recogniser.js";

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
  /**
   * Told about anything that went wrong: a camera that would not open and why, a refused
   * fallback, a compiled target nothing claims, recognition or the camera dying mid session.
   *
   * The `kind` says what sort of thing it is, because a page needs to treat them
   * differently and cannot tell from the words. A page has its own sentence for a camera
   * that will not open, chosen for whoever is holding the phone, and should not have it
   * replaced by wording like "would not start playing within 10000 ms"; it has no sentence
   * for a manifest naming a target nothing was built for, and that one it should show,
   * because the author is the person reading it.
   *
   * This used to be one channel with no kind, and the pages guessed by looking at the state
   * at the time. That is wrong in both directions: three of the five calls here happen
   * before the state they belong to is set, so the guess suppressed a manifest problem it
   * should have shown, and showed a camera reason that was then overwritten a moment later.
   * The likeliest authoring mistake there is went to neither the page nor the console.
   */
  onProblem?: (message: string, kind: ProblemKind) => void;
}

/**
 * What sort of problem a page has been told about.
 *
 * `camera` is a reason a camera would not open or stopped, which a page usually has its own
 * words for. `manifest` is something wrong with what was published, which the person
 * reading the page is usually the person who can fix. `recognition` is the loop itself
 * failing, which leaves a page that looks like it is working and is not.
 */
export type ProblemKind = "camera" | "manifest" | "recognition";

export interface MountedExperience {
  readonly state: ExperienceState;
  /** Content types in the manifest this build cannot show. */
  readonly unsupported: readonly string[];
  /** Compiled targets that no manifest target claims, so nothing was built for them. */
  readonly unmatchedTargets: readonly string[];
  /**
   * Whether recognition currently has a thread of its own. False means the page will
   * stutter, and can become false after mounting if the worker is lost.
   */
  readonly threaded: boolean;
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
  const overlays = new Map<
    string,
    {
      element: HTMLElement;
      target: TrackingTarget;
      missed: number;
      pose: Float64Array | null;
      processed: { width: number; height: number } | null;
    }
  >();
  const unmatched: string[] = [];
  for (const target of options.targets) {
    const described = options.manifest.targets.find((entry) => entry.id === target.id);
    if (!described) {
      // Silence here is the worst outcome: nothing is drawn, the camera runs, and the
      // author sees an experience that never finds anything. Mismatched ids between a
      // manifest and a compiled target is one of the likeliest mistakes in authoring this.
      unmatched.push(target.id);
      continue;
    }
    const built = buildContent(described, resolve);
    for (const type of built.unsupported) unsupported.add(type);
    stage.append(built.element);
    overlays.set(target.id, {
      element: built.element,
      target,
      missed: patience,
      pose: null,
      processed: null,
    });
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
    // Why, not just that. A camera fails in ways that call for different things from the
    // viewer: refused is theirs to undo, missing is not, one held by another application
    // wants that application closed, and one that opens and sends nothing is a different
    // problem again. The state carries two of those and the page shows the state, so
    // without this the reason a page could act on is thrown away at the only point that
    // knows it.
    settings.onProblem?.(error instanceof Error ? error.message : String(error), "camera");
    // Give the camera back. Without this the device stays held: the indicator light stays
    // on under a page saying the camera could not be opened, and if playback starts after
    // the deadline the video element is still in the container, so a live picture appears
    // behind the error text. Giving up on a camera includes letting go of it.
    camera.stop();
    // The fallback exists for exactly this: the viewer scanned something and the camera
    // is not going to open, so send them where the manifest says to send them.
    //
    // The scheme is checked here even though the schema already restricts it, because
    // nothing forces a caller to run the validator and this project's own example did not.
    // A manifest is a format other people write, so it is the input least worth trusting,
    // and `javascript:` in this line runs in the viewer's page.
    const fallback = options.manifest.fallback;
    if (fallback && isSafeUrl(fallback)) globalThis.location?.assign(fallback);
    else if (fallback)
      settings.onProblem?.(`refused to follow a fallback that is not http or https: ${fallback}`, "manifest");
    return {
      get state() {
        return state;
      },
      unsupported: [...unsupported],
      unmatchedTargets: unmatched,
      threaded: false,
      stop: () => camera.stop(),
    };
  }

  for (const id of unmatched) {
    settings.onProblem?.(
      `no target in the manifest is called ${id}, so nothing was built for it`,
      "manifest",
    );
  }

  setState("searching");
  let running = true;
  const recogniser = createRecogniser(options.targets);

  // Two loops, deliberately. Drawing follows the display and runs every frame; recognition
  // takes a couple of hundred milliseconds and runs as often as it can finish, with frames
  // that arrive meanwhile dropped rather than queued. Between answers the last pose stands,
  // which is why the content follows the camera smoothly at a fraction of the frame rate.
  const draw = () => {
    if (!running) return;
    const displayed = {
      width: video.clientWidth || 1,
      height: video.clientHeight || 1,
    };
    for (const overlay of overlays.values()) {
      if (!overlay.pose || !overlay.processed) continue;
      overlay.element.style.transform = cssMatrixFor(overlay.pose, overlay.processed, displayed);
      overlay.element.style.width = `${overlay.target.width}px`;
      overlay.element.style.height = `${overlay.target.height}px`;
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  const recognise = async () => {
    while (running) {
      if (camera.lost) {
        for (const overlay of overlays.values()) {
          overlay.element.hidden = true;
          overlay.pose = null;
        }
        settings.onProblem?.("the camera stopped, which usually means another app took it", "camera");
        setState("error");
        running = false;
        return;
      }
      const frame = camera.grab();
      if (!frame) {
        await nextFrame();
        continue;
      }
      let poses: Awaited<ReturnType<typeof recogniser.submit>>;
      try {
        poses = await recogniser.submit(frame);
      } catch (error) {
        // Recognition has stopped and is not coming back. Say so, take the content away
        // rather than leaving it welded to a pose the camera has moved off, and stop.
        for (const overlay of overlays.values()) {
          overlay.element.hidden = true;
          overlay.pose = null;
        }
        settings.onProblem?.(
          `recognition stopped: ${error instanceof Error ? error.message : String(error)}`,
          "recognition",
        );
        setState("error");
        running = false;
        return;
      }
      if (!poses) {
        await nextFrame();
        continue;
      }
      let anyFound = false;
      for (const pose of poses) {
        const overlay = overlays.get(pose.id);
        if (!overlay) continue;
        if (pose.homography) {
          overlay.missed = 0;
          overlay.pose = pose.homography;
          overlay.processed = { width: frame.width, height: frame.height };
          overlay.element.hidden = false;
          anyFound = true;
        } else if (++overlay.missed >= patience) {
          overlay.element.hidden = true;
          overlay.pose = null;
        } else {
          anyFound = true;
        }
      }
      setState(anyFound ? "tracking" : "searching");
      await nextFrame();
    }
  };
  void recognise();

  return {
    get state() {
      return state;
    },
    unsupported: [...unsupported],
    unmatchedTargets: unmatched,
    // Read when asked rather than captured at mount, because recognition can lose its
    // thread later: a worker can be ended by the browser under memory pressure, or turn
    // out never to have loaded.
    get threaded() {
      return recogniser.threaded;
    },
    stop() {
      running = false;
      recogniser.stop();
      camera.stop();
    },
  };
}

/** Yield to the browser, so recognition never starves painting or input. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Whether a URL is one this runtime will send a viewer to.
 *
 * Only http and https. Everything else, `javascript:` above all, is a way for a manifest
 * to run code in the page that loaded it.
 */
function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value, globalThis.location?.href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

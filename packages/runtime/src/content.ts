import type { TaggantExperienceManifest } from "@taggant/manifest";

type Target = TaggantExperienceManifest["targets"][number];
type Content = Target["content"][number];

/** Content types this runtime can put on the page today. */
const SUPPORTED = new Set(["image", "video"]);

export interface BuiltContent {
  element: HTMLElement;
  /** Types named in the manifest that this build cannot show, reported rather than ignored. */
  unsupported: string[];
}

/**
 * Build the element that sits on the artwork.
 *
 * The outer element is exactly the size of the target in artwork coordinates, so the pose
 * can be applied to it unchanged: everything about where it goes lives in the transform,
 * and everything about what it is lives inside.
 */
export function buildContent(target: Target, resolve: (src: string) => string): BuiltContent {
  const element = document.createElement("div");
  element.dataset.taggantTarget = target.id;
  element.style.position = "absolute";
  element.style.top = "0";
  element.style.left = "0";
  element.style.transformOrigin = "0 0";
  element.style.pointerEvents = "none";
  element.hidden = true;

  const unsupported: string[] = [];
  for (const item of target.content) {
    if (!SUPPORTED.has(item.type)) {
      // Named, not silently dropped: an author who asked for a model and sees nothing
      // needs to know it is this build rather than their file.
      unsupported.push(item.type);
      continue;
    }
    element.append(place(item, resolve));
  }
  return { element, unsupported };
}

/**
 * Position one piece of content within the target's own rectangle.
 *
 * Placement is expressed relative to the target rather than in pixels, because the target
 * is a physical thing whose size in the frame changes every time the viewer moves.
 */
function place(item: Content, resolve: (src: string) => string): HTMLElement {
  const media = item.type === "video" ? video(item, resolve) : image(item, resolve);
  const placement = item.placement ?? {};
  const scale = placement.scale ?? 1;
  const offsetX = placement.offsetX ?? 0;
  const offsetY = placement.offsetY ?? 0;
  const rotation = placement.rotationDeg ?? 0;

  const holder = document.createElement("div");
  holder.style.position = "absolute";
  holder.style.left = `${50 + offsetX * 100}%`;
  holder.style.top = `${50 + offsetY * 100}%`;
  holder.style.width = `${scale * 100}%`;
  holder.style.height = `${scale * 100}%`;
  holder.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
  holder.append(media);
  return holder;
}

function image(item: Content, resolve: (src: string) => string): HTMLElement {
  const element = document.createElement("img");
  element.src = resolve(item.src);
  element.alt = "";
  fill(element);
  return element;
}

function video(item: Content, resolve: (src: string) => string): HTMLElement {
  const element = document.createElement("video");
  element.src = resolve(item.src);
  element.loop = item.loop ?? true;
  element.muted = item.muted ?? false;
  element.autoplay = item.autoplay ?? true;
  element.setAttribute("playsinline", "");
  // Autoplay with sound is refused by every mobile browser, so a video that asks for both
  // is muted rather than left not playing at all.
  if (element.autoplay && !element.muted) element.muted = true;
  fill(element);
  return element;
}

function fill(element: HTMLElement): void {
  element.style.width = "100%";
  element.style.height = "100%";
  element.style.objectFit = "contain";
  element.style.display = "block";
}

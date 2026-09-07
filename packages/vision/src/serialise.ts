import type { TrackingTarget } from "./locate.js";
import type { TargetFeature } from "./target.js";

/**
 * The target as it is written to disk and read back in a browser.
 *
 * Typed arrays do not survive JSON: a Uint32Array stringifies to an object keyed by
 * index, which reads back as something that is not an array and matches nothing. That
 * failure passes every in-memory test and only appears once the file has been written and
 * loaded somewhere else, so the conversion has one home and a round trip test.
 */
export interface TargetFile {
  formatVersion: 2;
  id: string;
  width: number;
  height: number;
  features: Array<{
    x: number;
    y: number;
    scale: number;
    angle: number;
    strength: number;
    /** Eight unsigned 32 bit words, as plain numbers. */
    descriptor: number[];
  }>;
}

export function toTargetFile(target: {
  id: string;
  width: number;
  height: number;
  features: TargetFeature[];
}): TargetFile {
  return {
    formatVersion: 2,
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
  };
}

/**
 * Read a target file, refusing anything this build cannot make sense of.
 *
 * A runtime that guesses at a format it does not know produces a pose from nonsense,
 * which is worse than saying no.
 */
export function fromTargetFile(value: unknown): TrackingTarget {
  if (typeof value !== "object" || value === null) throw new TypeError("target file must be an object");
  const file = value as Partial<TargetFile>;
  if (file.formatVersion !== 2) {
    throw new TypeError(`target file format ${String(file.formatVersion)} is not supported, expected 2`);
  }
  if (typeof file.id !== "string" || !(file.width && file.height) || !Array.isArray(file.features)) {
    throw new TypeError("target file is missing an id, its dimensions, or its features");
  }
  return {
    id: file.id,
    width: file.width,
    height: file.height,
    features: file.features.map((feature, index) => {
      if (!Array.isArray(feature?.descriptor) || feature.descriptor.length !== 8) {
        throw new TypeError(`feature ${index} does not carry an eight word descriptor`);
      }
      return {
        x: feature.x,
        y: feature.y,
        angle: feature.angle,
        strength: feature.strength,
        descriptor: Uint32Array.from(feature.descriptor),
      };
    }),
  };
}

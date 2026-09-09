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
  formatVersion: 3;
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
    formatVersion: 3,
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
  if (file.formatVersion !== 3) {
    // Raised to 3 when the descriptor's sampling pattern changed. A version 2 target holds
    // descriptors built from the old pattern, which cannot match anything this describes,
    // and it would fail by recognising nothing rather than by saying so.
    throw new TypeError(`target file format ${String(file.formatVersion)} is not supported, expected 3`);
  }
  if (typeof file.id !== "string" || !Array.isArray(file.features)) {
    throw new TypeError("target file is missing an id or its features");
  }
  const width = size(file.width, "width");
  const height = size(file.height, "height");

  return {
    id: file.id,
    width,
    height,
    features: file.features.map((feature, index) => {
      if (!Array.isArray(feature?.descriptor) || feature.descriptor.length !== 8) {
        throw new TypeError(`feature ${index} does not carry an eight word descriptor`);
      }
      const descriptor = new Uint32Array(8);
      for (let word = 0; word < 8; word++) {
        const value = feature.descriptor[word];
        // Every one of these reaches the caller as "it never recognises anything", which
        // is the hardest failure to trace back to a file that was written wrong.
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
          throw new TypeError(`feature ${index} has a descriptor word that is not a 32 bit integer`);
        }
        descriptor[word] = value;
      }
      return {
        x: finite(feature.x, index, "x"),
        y: finite(feature.y, index, "y"),
        scale: positiveFinite(feature.scale, index, "scale"),
        angle: finite(feature.angle, index, "angle"),
        strength: finite(feature.strength, index, "strength"),
        descriptor,
      };
    }),
  };
}

function size(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`target file ${name} must be a positive number, got ${String(value)}`);
  }
  return value;
}

function finite(value: unknown, index: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`feature ${index} has a ${name} that is not a finite number, got ${String(value)}`);
  }
  return value;
}

function positiveFinite(value: unknown, index: number, name: string): number {
  const number = finite(value, index, name);
  if (number <= 0) throw new TypeError(`feature ${index} has a ${name} that is not positive, got ${number}`);
  return number;
}

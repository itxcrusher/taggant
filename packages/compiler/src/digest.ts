import { createHash } from "node:crypto";

/**
 * The fingerprint of a target as its file holds it: its width and height, and every feature's
 * position, size, angle, strength and descriptor, in the order the file lists them.
 *
 * A report carries the fingerprint of the target it was written for, and whatever reads a report
 * beside a target compares the two. The report's own figures could not tie it: every landscape
 * artwork is analysed at the same width and described at the same four sizes, and of 2485 pairs
 * of 71 such artworks, 70 had the same number of features at full size, so the report of a design
 * that passed published on the target of one that was refused. Read from the file or from the
 * compile's own features, the same target gives the same fingerprint, because the numbers are the
 * same and are written out in one fixed order; anything that is not a target gives one no target
 * has. It ties a report to its target, and does not sign it: a report whose every figure was edited
 * by hand, fingerprint included, is not caught.
 */
export function targetDigest(target: { width: unknown; height: unknown; features: unknown }): string {
  const features = Array.isArray(target.features) ? target.features : [];
  const rows = features.map((feature: unknown) => {
    const f = (typeof feature === "object" && feature !== null ? feature : {}) as Record<string, unknown>;
    const descriptor = f.descriptor;
    const words =
      Array.isArray(descriptor) || ArrayBuffer.isView(descriptor)
        ? Array.from(descriptor as ArrayLike<unknown>)
        : null;
    return [f.x, f.y, f.scale, f.angle, f.strength, words];
  });
  const canonical = JSON.stringify([target.width, target.height, Array.isArray(target.features), rows]);
  return createHash("sha256").update(canonical).digest("hex");
}

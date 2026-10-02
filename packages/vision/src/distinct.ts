import type { DescribedCorner } from "./describe.js";
import { hamming } from "./describe.js";

export interface Distinctiveness {
  /** Features whose nearest look-alike elsewhere on the artwork is close enough to be confused with them. */
  ambiguous: number;
  /** Features measured: those with at least one other feature far enough away to compare. */
  measured: number;
  /**
   * The share of them that are ambiguous, from 0 to 1. Null when none could be measured: one
   * feature, or all of them within `apartPx` of each other, have nothing elsewhere to be
   * confused with, and that read 0, which says "no look-alikes" about artwork nothing was
   * learned about.
   */
  share: number | null;
  /**
   * How far apart two features must be before they count as being somewhere else on the
   * artwork. Twenty-four pixels, a different question from the matcher's six, which is about
   * one corner described at two sizes.
   */
  apartPx: number;
}

/**
 * How many of the artwork's features have one look-alike elsewhere that stands out.
 *
 * For every feature, the closest looking feature somewhere else on the artwork is found, and
 * the feature counts when that one is near enough to be confused with it and clearly closer
 * than the rest. That is the case a matcher's ratio test accepts wrongly.
 *
 * What it does not measure is repetition, though it was named and used as if it did. A feature
 * with several identical rivals has none that stands out, so it is not counted: two copies of a
 * design read 1.0 and three read 0, and the figure falls as a design repeats. It decided "ready
 * for press" until a sheet of sixteen identical postcards passed at 0.31 and was not found at
 * the width it was given. The compiler now decides readiness by putting the artwork in front of
 * the recogniser, and this is reported beside that as a diagnostic.
 *
 * Its comment also said the same artwork printed twice "placed content a whole tile away". At
 * the printed width that did not reproduce: over 21 poses, with the error against the known
 * mapping, the two-up design was placed correctly every time, worst 2.7 pixels. One size
 * smaller, with fewer points to choose from, it does: the postcard printed twice was put on the
 * other copy in one look of twelve, which is why the compiler checks placement there too.
 */
export function measureDistinctiveness(
  features: DescribedCorner[],
  options: { apartPx?: number; confusableAt?: number; ratio?: number } = {},
): Distinctiveness {
  const apartPx = options.apartPx ?? 24;
  const confusableAt = options.confusableAt ?? 72;
  const ratio = options.ratio ?? 0.8;
  const apartSquared = apartPx * apartPx;

  let ambiguous = 0;
  let measured = 0;
  for (let i = 0; i < features.length; i++) {
    const a = features[i];
    if (!a) continue;
    let nearest = Number.POSITIVE_INFINITY;
    let second = Number.POSITIVE_INFINITY;
    for (let j = 0; j < features.length; j++) {
      if (i === j) continue;
      const b = features[j];
      if (!b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // Two descriptions of the same corner are not a problem; two descriptions of
      // different places that look the same are the whole problem.
      if (dx * dx + dy * dy < apartSquared) continue;
      const distance = hamming(a.descriptor, b.descriptor);
      if (distance < nearest) {
        second = nearest;
        nearest = distance;
      } else if (distance < second) {
        second = distance;
      }
    }

    // The question is not whether a feature has a look-alike. On print almost everything
    // does, and a matcher throws those away by itself: its ratio test refuses a match
    // whose runner up is nearly as good. The question is whether one look-alike stands out
    // from the rest, because that is the case the matcher accepts, confidently, and wrong.
    // A feature with nothing far enough away has nothing to be confused with, and says nothing
    // either way about the artwork.
    if (!Number.isFinite(nearest)) continue;
    measured++;
    const stands = Number.isFinite(second) ? nearest < second * ratio : true;
    if (nearest <= confusableAt && stands) ambiguous++;
  }

  return { ambiguous, measured, share: measured === 0 ? null : ambiguous / measured, apartPx };
}

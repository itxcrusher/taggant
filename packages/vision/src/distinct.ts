import type { DescribedCorner } from "./describe.js";
import { hamming } from "./describe.js";

export interface Distinctiveness {
  /** Features whose nearest look-alike elsewhere on the artwork is close enough to be confused with them. */
  ambiguous: number;
  /** Features measured. */
  measured: number;
  /** The share of them that are ambiguous, from 0 to 1. */
  share: number;
  /** How far apart two features must be before they count as being somewhere else. */
  apartPx: number;
}

/**
 * How well the artwork's features can be told apart from each other.
 *
 * This is the property that decides whether a pose lands on the right part of the print,
 * and neither a feature count nor a spread says anything about it. Artwork that repeats,
 * which is most packaging, has plenty of features spread over the whole piece and no way
 * to know which copy of the pattern is being looked at. Measured: the same artwork printed
 * twice side by side scored a hundred out of a hundred and then placed content a whole
 * tile away, with enough agreeing matches to look certain about it.
 *
 * So for every feature, find the closest looking feature that is somewhere else on the
 * artwork, and count it as ambiguous when the two are near enough that a matcher would
 * accept either.
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
    const stands = Number.isFinite(second) ? nearest < second * ratio : true;
    if (nearest <= confusableAt && stands) ambiguous++;
  }

  const measured = features.length;
  return { ambiguous, measured, share: measured === 0 ? 0 : ambiguous / measured, apartPx };
}

import type { Candidate } from "./links.js";
import { expandLinkType } from "./links.js";

/**
 * A linkset as RFC 9264 defines it, in its JSON form.
 *
 * One object per anchor, holding one member per relation type, each a list of link
 * targets. Relation names are full URIs because these are extension relations rather than
 * anything IANA registered, which is what the RFC asks for.
 */
export interface Linkset {
  linkset: Array<Record<string, unknown>>;
}

export interface LinksetTarget {
  href: string;
  title: string;
  hreflang?: string[];
  type?: string;
}

/**
 * Build the linkset for a request.
 *
 * Every anchor is the canonical, uncompressed form of the level the link is attached to,
 * which the standard requires as the subject of any fact presented. Links are grouped by
 * anchor first so a client can tell what was said about the product from what was said
 * about the individual item.
 */
export function buildLinkset(candidates: Candidate[], origin: string): Linkset {
  const byAnchor = new Map<string, Record<string, LinksetTarget[]>>();
  for (const candidate of candidates) {
    const anchor = `${origin}${candidate.anchor}`;
    const relations = byAnchor.get(anchor) ?? {};
    const name = expandLinkType(candidate.linkType);
    const target: LinksetTarget = { href: candidate.href, title: candidate.title };
    if (candidate.hreflang) target.hreflang = candidate.hreflang;
    if (candidate.type) target.type = candidate.type;
    relations[name] = [...(relations[name] ?? []), target];

    // The default is also published as such. Nothing else in a linkset tells a client
    // which link a plain scan would follow, and GS1's own test suite looks for exactly
    // this relation and reports "No default link found" without it. The standard says the
    // default carries a title and none of the optional attributes, so it is written that
    // way here and described by its own link type in the entry above.
    if (candidate.default === true) {
      const asDefault = expandLinkType("gs1:defaultLink");
      relations[asDefault] = [
        ...(relations[asDefault] ?? []),
        { href: candidate.href, title: candidate.title },
      ];
    }
    byAnchor.set(anchor, relations);
  }

  return {
    linkset: [...byAnchor.entries()].map(([anchor, relations]) => ({ anchor, ...relations })),
  };
}

/**
 * The JSON-LD context that lets a linkset be read as data rather than as a shape.
 *
 * Served from the resolver rather than pointed at somewhere else, because a resolver that
 * needs another host to be up in order to be understood has moved the problem rather than
 * solved it.
 */
export const CONTEXT = {
  "@context": {
    gs1: "https://gs1.org/voc/",
    anchor: "@id",
    href: "@id",
    title: "https://www.w3.org/ns/json-ld#title",
    hreflang: "https://www.w3.org/ns/json-ld#language",
    type: "https://www.w3.org/ns/json-ld#type",
  },
};

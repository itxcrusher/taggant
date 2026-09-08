import { type DigitalLink, ancestry } from "./digital-link.js";

/** The GS1 Web vocabulary, which is where link types come from unless they say otherwise. */
export const GS1_VOCAB = "https://gs1.org/voc/";

export interface StoredLink {
  href: string;
  /**
   * A GS1 Web vocabulary term such as `gs1:pip`, or a full URI for anything outside it.
   * The standard requires the GS1 namespace to be recognised and forbids redefining its
   * terms elsewhere.
   */
  linkType: string;
  /** Required by the standard: every link exposed carries a human readable title. */
  title: string;
  /** Languages this link is for, so Accept-Language can choose between siblings. */
  hreflang?: string[];
  /** An IANA media type, when the link has one. */
  type?: string;
  /** Whether this is the link to use when the request asks for nothing in particular. */
  default?: boolean;
}

/**
 * The whole table, as it is written to disk.
 *
 * Plain JSON on purpose. The promise made to anyone printing a code is that the redirect
 * can be rehosted, and a table nobody can read out is not a promise, it is a claim. Keys
 * are canonical Digital Link paths, so the same identifier written two ways lands in one
 * place.
 */
export interface LinkTable {
  version: 1;
  entries: Record<string, StoredLink[]>;
}

export function emptyTable(): LinkTable {
  return { version: 1, entries: {} };
}

export function parseTable(value: unknown): LinkTable {
  if (typeof value !== "object" || value === null) throw new TypeError("the link table must be an object");
  const table = value as Partial<LinkTable>;
  if (table.version !== 1)
    throw new TypeError(`link table version ${String(table.version)} is not supported`);
  if (typeof table.entries !== "object" || table.entries === null) {
    throw new TypeError("the link table has no entries");
  }
  for (const [path, links] of Object.entries(table.entries)) {
    if (!Array.isArray(links)) throw new TypeError(`the entry for ${path} is not a list of links`);
    for (const link of links) {
      for (const field of ["href", "linkType", "title"] as const) {
        if (typeof link?.[field] !== "string" || link[field].length === 0) {
          // The standard requires all three on every link exposed, so a table missing one
          // cannot produce a conformant response and is refused when it is read, not when
          // somebody scans something.
          throw new TypeError(`a link under ${path} has no ${field}`);
        }
      }
    }
  }
  return table as LinkTable;
}

/** Turn a vocabulary term into the full URI a linkset has to use as a relation name. */
export function expandLinkType(linkType: string): string {
  if (linkType.startsWith("gs1:")) return `${GS1_VOCAB}${linkType.slice(4)}`;
  return linkType;
}

/** The reverse, for comparing a `linkType` query parameter against what is stored. */
export function sameLinkType(a: string, b: string): boolean {
  return expandLinkType(a) === expandLinkType(b);
}

export interface Candidate extends StoredLink {
  /** The level this link was attached at, which is also the subject of the fact. */
  anchor: string;
}

/**
 * Every link that applies to a request, most specific level first.
 *
 * A request carrying key qualifiers gets the links attached at each level above it as
 * well, which the standard requires: a serial number with nothing of its own still reaches
 * whatever the product it belongs to has.
 */
export function candidatesFor(table: LinkTable, link: DigitalLink): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();
  for (const level of ancestry(link)) {
    for (const stored of table.entries[level] ?? []) {
      const key = `${expandLinkType(stored.linkType)} ${stored.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...stored, anchor: level });
    }
  }
  return found;
}

export interface ChoiceRequest {
  /** A `linkType` query parameter, if the request carried one. */
  linkType?: string | undefined;
  /** The Accept-Language header, if any. */
  acceptLanguage?: string | undefined;
}

/**
 * Pick the link to redirect to.
 *
 * The rule from the standard is that the default is used unless the request carries
 * something that makes a better match possible. Language is that something here: a request
 * that says it wants French gets the French page when there is one, and the default
 * otherwise.
 */
export function chooseLink(candidates: Candidate[], request: ChoiceRequest): Candidate | undefined {
  if (request.linkType) {
    const asked = candidates.filter((candidate) => sameLinkType(candidate.linkType, request.linkType ?? ""));
    return best(asked, request.acceptLanguage);
  }

  const fallback = candidates.find((candidate) => candidate.default === true);
  if (!fallback) return undefined;

  // The default decides which link type is on offer; the request then gets to improve on
  // which of that type it lands on. Filtering to the default alone would make the rest of
  // this sentence in the standard mean nothing, since one link cannot be bettered.
  const siblings = candidates.filter((candidate) => sameLinkType(candidate.linkType, fallback.linkType));
  return best(siblings, request.acceptLanguage) ?? fallback;
}

/** The best of a set for the languages asked for, or the first when nothing matches. */
function best(links: Candidate[], acceptLanguage: string | undefined): Candidate | undefined {
  if (links.length === 0) return undefined;
  if (links.length === 1) return links[0];
  for (const language of parseAcceptLanguage(acceptLanguage)) {
    const match = links.find((candidate) =>
      candidate.hreflang?.some(
        (tag) => tag.toLowerCase() === language || tag.toLowerCase().startsWith(`${language}-`),
      ),
    );
    if (match) return match;
  }
  return links.find((candidate) => candidate.default === true) ?? links[0];
}

/** Language tags from an Accept-Language header, best first, quality values honoured. */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag = "", ...rest] = part.trim().split(";");
      const quality = rest.find((piece) => piece.trim().startsWith("q="));
      return { tag: tag.trim().toLowerCase(), q: quality ? Number(quality.trim().slice(2)) : 1 };
    })
    .filter((entry) => entry.tag.length > 0 && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

import { type DigitalLink, ancestry, canonicalise, parseDigitalLink } from "./digital-link.js";

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
    // A key that is not the canonical form of a Digital Link can never be reached, because
    // that is what a request is turned into before anything is looked up. Six plausible
    // ways of writing one by hand were accepted in silence, and readiness counted them as
    // links: a trailing slash, the alphabetic form, no leading slash, a whole URI, a GTIN
    // in its thirteen digit form, and a typo in a check digit. Every one of them produced a
    // resolver that answered nothing and said it was ready.
    let canonical: string;
    try {
      const parsed = parseDigitalLink(path);
      canonical = canonicalise(parsed.primary, parsed.qualifiers);
    } catch (error) {
      throw new TypeError(
        `the key ${JSON.stringify(path)} is not a Digital Link path and could never be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (canonical !== path) {
      throw new TypeError(
        `the key ${JSON.stringify(path)} is not in its canonical form and could never be reached. Write it as ${JSON.stringify(canonical)}.`,
      );
    }

    if (!Array.isArray(links)) throw new TypeError(`the entry for ${path} is not a list of links`);
    // One default per link type per anchor. Two were accepted, and then the resolver
    // followed the first while the linkset published both as `gs1:defaultLink`, so a client
    // reading the linkset and a client following a plain scan disagreed about the same
    // code and the table said nothing was wrong.
    const defaults = new Set<string>();
    for (const link of links) {
      for (const field of ["href", "linkType", "title"] as const) {
        if (typeof link?.[field] !== "string" || link[field].length === 0) {
          // The standard requires all three on every link exposed, so a table missing one
          // cannot produce a conformant response and is refused when it is read, not when
          // somebody scans something.
          throw new TypeError(`a link under ${path} has no ${field}`);
        }
      }
      // A relation name has to be a URI once expanded, which RFC 9264 requires of any
      // extension relation. It also stops a link type called `anchor` from overwriting the
      // subject of the whole linkset, which is what happened when anything was allowed.
      const relation = expandLinkType(link.linkType);
      if (!/^https?:\/\/\S+$/.test(relation)) {
        throw new TypeError(
          `the link type ${JSON.stringify(link.linkType)} under ${path} is not a GS1 vocabulary term or an absolute URI`,
        );
      }

      // An href that is not an absolute web address cannot be a Location, and finding that
      // out at scan time is a 500 for whoever scanned the code.
      let target: URL;
      try {
        target = new URL(link.href);
      } catch {
        throw new TypeError(`the href ${JSON.stringify(link.href)} under ${path} is not an absolute address`);
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new TypeError(`the href ${JSON.stringify(link.href)} under ${path} is not http or https`);
      }

      if (link.default === true) {
        if (defaults.has(relation)) {
          throw new TypeError(
            `${path} has two default links of type ${JSON.stringify(link.linkType)}, and only one can be the default`,
          );
        }
        defaults.add(relation);
      }

      // A title goes into a `Link` header, where a control character is at best a header
      // Node refuses to write, which used to become a 500 for whoever scanned the code,
      // and a line separator is invisible in every editor the author of the table has.
      // Refused where the table is read rather than where it is served.
      if (holdsControlCharacter(link.title)) {
        throw new TypeError(
          `the title under ${path} holds a control character, which cannot go in a Link header`,
        );
      }
    }
  }
  return table as LinkTable;
}

/**
 * Whether a string holds a character that cannot go in a header, or cannot be seen.
 *
 * Code points rather than a regular expression, because a regular expression holding
 * control characters is nearly always a mistake and the linter is right to refuse one;
 * this is the single place where they are the subject rather than an accident. U+2028 and
 * U+2029 are in with them: a parser treats them as line breaks and an editor shows nothing.
 */
function holdsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
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
  for (const level of ancestry(link)) {
    // Duplicates are dropped within a level and never across levels. The set used to be
    // keyed on the link type and the href alone, for the whole ancestry, so attaching the
    // same landing page to a product and to one of its lots made the two one candidate:
    // the specific one was kept, the product's was dropped, and with it the product's
    // `default: true`. A lot that shared its product's href answered 404, "no default link
    // is set for that identifier", while the same table with a different href answered 307;
    // the product's anchor also vanished from the linkset, which is the criterion that
    // links at every level up to the primary key are included. The level belongs in the key
    // because a link at two levels is two facts: one about the product, one about the lot.
    const seen = new Set<string>();
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

/**
 * The tag on a link that answers a request for a language, if one does.
 *
 * Matching runs in both directions, and only one of them used to. A request for `fr` found
 * a link tagged `fr-CA`, because the link's tag was tested with `startsWith`. A request for
 * `fr-CA` did not find a link tagged `fr`, so a French-Canadian phone was served the
 * English default while a French page sat in the table: RFC 4647 calls the fix lookup, and
 * it is to truncate the request rather than the offer, most specific first. Tables are
 * written with base languages (`fr`, `de`, `es`), which made the missing direction the
 * common one rather than a corner.
 *
 * Exported because the resolver records which language decided a redirect, and a second
 * implementation of this rule in that file is how the record and the choice come to
 * disagree.
 */
export function languageMatch(hreflang: readonly string[] | undefined, wanted: string): string | undefined {
  if (hreflang === undefined) return undefined;
  const parts = wanted.split("-");
  for (let length = parts.length; length > 0; length--) {
    const range = parts.slice(0, length).join("-");
    const found = hreflang.find(
      (tag) => tag.toLowerCase() === range || tag.toLowerCase().startsWith(`${range}-`),
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The best of a set for the languages asked for, or the first when nothing matches. */
function best(links: Candidate[], acceptLanguage: string | undefined): Candidate | undefined {
  if (links.length === 0) return undefined;
  if (links.length === 1) return links[0];
  for (const language of parseAcceptLanguage(acceptLanguage)) {
    const match = links.find((candidate) => languageMatch(candidate.hreflang, language) !== undefined);
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

import { type DigitalLink, ancestry, canonicalise, parseDigitalLink } from "./digital-link.js";

/** The GS1 Web vocabulary, which is where link types come from unless they say otherwise. */
export const GS1_VOCAB = "https://gs1.org/voc/";

export interface StoredLink {
  /**
   * An http or https address. A resolver answers with the address a URL parser reads in it,
   * which is the one its redirect sends, whatever spelling the table holds.
   */
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

/**
 * The table as it is written to disk, read from its text.
 *
 * A byte-order mark in front is dropped, as RFC 8259 lets a reader do: an editor that saves UTF-8
 * with one wrote a table the resolver would not start on, and the message named a character
 * nobody can see.
 */
export function parseTableText(text: string): LinkTable {
  return parseTable(readTableText(text));
}

/**
 * A table's text read as JSON, as `parseTableText` reads it, without the checks of what it says:
 * for a writer that changes a table and checks the result, which may repair what the table held.
 * Refused, as there, when it is not JSON or writes a key twice, because then what it holds cannot
 * be known, and a table written back from it would lose what the reader dropped.
 */
export function readTableText(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const value: unknown = JSON.parse(body);
  // A reader of JSON keeps the last of two keys of one object and drops the first without a word:
  // an identifier written twice lost the links under its first, and a field written twice in a
  // link lost its first value, while the table was called ready.
  const twice = keyWrittenTwice(body);
  if (twice !== undefined) {
    throw new TypeError(
      `the table writes the key ${JSON.stringify(twice.key)} twice in one object${twice.within === undefined ? "" : `, ${JSON.stringify(twice.within)}`}, and a reader keeps only the last: write it once`,
    );
  }
  return value;
}

/**
 * The first key a JSON text writes twice in one object, with the key that object is the value of,
 * if any. The text has been parsed already, so it is valid JSON and is walked only for its keys.
 */
function keyWrittenTwice(text: string): { key: string; within?: string } | undefined {
  // One frame for each object or array open, an object's keys and the key it is the value of.
  const frames: Array<{ keys: Set<string>; within?: string } | null> = [];
  let expectingKey = false;
  let lastKey: string | undefined;
  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    if (character === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const frame = frames[frames.length - 1];
      if (frame && expectingKey) {
        const key = JSON.parse(text.slice(at, end + 1)) as string;
        if (frame.keys.has(key)) return frame.within === undefined ? { key } : { key, within: frame.within };
        frame.keys.add(key);
        lastKey = key;
        expectingKey = false;
      }
      at = end;
    } else if (character === "{") {
      const parent = frames[frames.length - 1];
      frames.push(
        parent && lastKey !== undefined ? { keys: new Set(), within: lastKey } : { keys: new Set() },
      );
      expectingKey = true;
    } else if (character === "[") {
      frames.push(null);
    } else if (character === "}" || character === "]") {
      frames.pop();
    } else if (character === ",") {
      expectingKey = frames[frames.length - 1] !== null && frames.length > 0;
    }
  }
  return undefined;
}

/** The fields a link holds. A misspelled one was accepted and ignored. */
const LINK_FIELDS: ReadonlySet<string> = new Set([
  "href",
  "linkType",
  "title",
  "hreflang",
  "type",
  "default",
]);

/**
 * Check a table and return it as it is, throwing a `TypeError` that names the entry for anything a
 * scan could not be answered from.
 */
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
    // One default per anchor, whatever its link type. A plain scan follows one link, and the
    // linkset publishes every link marked as the default as `gs1:defaultLink`: two of one type,
    // and then two of different types, were accepted, the resolver followed the first while the
    // linkset published both, so a client reading the linkset and a client following a plain
    // scan disagreed about the same code and the table said nothing was wrong. GS1 asks for
    // exactly one default link for each identifier.
    let markedDefault: { linkType: string; copy: string } | undefined;
    for (const link of links) {
      for (const field of ["href", "linkType", "title"] as const) {
        if (typeof link?.[field] !== "string" || link[field].length === 0) {
          // The standard requires all three on every link exposed, so a table missing one
          // cannot produce a conformant response and is refused when it is read, not when
          // somebody scans something.
          throw new TypeError(`a link under ${path} has no ${field}`);
        }
      }
      // Every field one this format has. A misspelled one was accepted and ignored: with
      // `"Default": true` the resolver started, readiness said ready, and every plain scan of the
      // code answered that no default was set; with `"hrefLang"` a French phone got the English link.
      const unknown = Object.keys(link).find((field) => !LINK_FIELDS.has(field));
      if (unknown !== undefined) {
        throw new TypeError(
          `a link under ${path} has a field called ${JSON.stringify(unknown)}, which this table does not have: a link holds ${[...LINK_FIELDS].join(", ")}`,
        );
      }
      // A relation name has to be a URI once expanded, which RFC 9264 requires of any
      // extension relation, of any scheme: only http and https were let through, so a `urn:`
      // or a `tag:` relation was refused under a message calling it something other than an
      // absolute URI. It also stops a link type called `anchor` from overwriting the subject
      // of the whole linkset, which is what happened when anything was allowed. A URI is held
      // to the characters RFC 3986 lets one hold, and a GS1 term to being a word, so `gs1:` with
      // nothing after it names nothing in the vocabulary: `urn:a<b>`, `tag:x"y`, a URN holding an
      // accented letter, `gs1:/`, `gs1:#` and `gs1:<pip>` were each accepted and published as a
      // relation name.
      const relation = expandLinkType(link.linkType);
      const term = relation.startsWith(GS1_VOCAB) ? relation.slice(GS1_VOCAB.length) : null;
      if (term !== null && !GS1_TERM.test(term)) {
        // Refused as what it is, a URI under GS1's address that names no word of the vocabulary,
        // which `https://gs1.org/voc/pip?v=2` is, rather than as something other than a URI.
        throw new TypeError(
          `the link type ${JSON.stringify(link.linkType)} under ${path} names no term of the GS1 vocabulary: after gs1: or ${GS1_VOCAB} comes a word, a letter and then letters and digits, such as gs1:pip`,
        );
      }
      if (term === null && writesGs1Namespace(relation)) {
        throw new TypeError(
          `the link type ${JSON.stringify(link.linkType)} under ${path} is GS1's vocabulary written another way, which a request for the term would not find: write it gs1: or ${GS1_VOCAB} followed by the word, such as gs1:pip`,
        );
      }
      // The resolver publishes the link marked as the default under this type itself, so one
      // written in the table as well was a second default in the linkset that no plain scan
      // follows. GS1's relation for one of several defaults is written here as the one link
      // marked as the default and the others of its type, which a request's languages choose
      // between.
      if (relation === `${GS1_VOCAB}defaultLink`) {
        throw new TypeError(
          `the link type ${JSON.stringify(link.linkType)} under ${path} is the one the resolver publishes for the link marked "default": true, so mark that link instead`,
        );
      }
      if (relation === `${GS1_VOCAB}defaultLinkMulti`) {
        throw new TypeError(
          `the link type ${JSON.stringify(link.linkType)} under ${path} names one of several defaults, which a table here writes as one link marked "default": true and the others of its type with their languages, chosen between by a request's own`,
        );
      }
      if (term === null && !ABSOLUTE_URI.test(relation)) {
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
      // A resolver answers with the address the URL parser reads in an href (`candidatesFor`), so
      // what is refused here is what that parser drops or escapes rather than reads as written:
      // spaces round an href and a tab or a line break inside it, which it drops, and a space or
      // another control character inside it, which it escapes. An href holding one is not written
      // as the address it names.
      if (/\s/.test(link.href) || holdsControlCharacter(link.href)) {
        throw new TypeError(
          `the href ${JSON.stringify(link.href)} under ${path} holds a space or a control character, which an address never does`,
        );
      }

      // A copy of the default marked as well is the one link it is a copy of, as the resolver
      // takes it (`copyOf`): refused, a link written twice with both copies marked was called two
      // defaults of one type.
      if (link.default === true) {
        const copy = copyOf(link);
        if (markedDefault !== undefined && markedDefault.copy !== copy) {
          throw new TypeError(
            `${path} has two default links, of types ${JSON.stringify(markedDefault.linkType)} and ${JSON.stringify(link.linkType)}, and a plain scan follows only one: mark only the link it should follow`,
          );
        }
        markedDefault ??= { linkType: link.linkType, copy };
      }

      // A title is for a person, shown by whatever reads the linkset to choose a link, and a
      // control character in one is at best nothing on that screen: a line break splits the title
      // wherever it is printed, and a line separator is invisible in every editor the author of
      // the table has. Refused where the table is read rather than left for a client to show.
      if (holdsControlCharacter(link.title)) {
        throw new TypeError(
          `the title under ${path} holds a control character or a line break, which no title shown to a person needs`,
        );
      }

      // The languages are searched for the one a phone asks in, which every browser sends, and
      // they and the media type are published in the linkset as written. Neither was checked, so
      // `"hreflang": "en"` was accepted, readiness said ready, and the first scan carrying
      // `Accept-Language` at an identifier with two links of a type was a 500. A default written
      // as the string `"true"` was no default at all, and a plain scan of the code answered that
      // none was set.
      if (link.hreflang !== undefined && !isLanguageList(link.hreflang)) {
        throw new TypeError(
          `the hreflang under ${path} is not a list of language tags, such as ["en"] or ["fr", "fr-CA"]`,
        );
      }
      if (link.type !== undefined && !(typeof link.type === "string" && MEDIA_TYPE.test(link.type))) {
        throw new TypeError(
          `the type ${JSON.stringify(link.type)} under ${path} is not a media type, such as "text/html"`,
        );
      }
      if (link.default !== undefined && typeof link.default !== "boolean") {
        throw new TypeError(
          `the default under ${path} is ${JSON.stringify(link.default)}, and has to be true or false`,
        );
      }
    }
  }
  return table as LinkTable;
}

/**
 * A language tag as BCP 47 spells one: letters first, then subtags of up to eight letters or
 * digits, joined by hyphens. Checked for its shape and not against the registry, which is enough
 * to refuse a typo, a number or an underscore, and to accept every tag a browser sends.
 */
const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * A media type as RFC 6838 names one, with parameters after it as RFC 9110 writes them: `text/html`,
 * `text/html; charset=utf-8`, `text/html;`, whose parameter is empty, and a quoted value holding a
 * tab or an escaped character; and not `html`, a number, or one broken across lines. The last three
 * of those were refused here, so a type RFC 9110 allows kept a resolver from starting. A quoted
 * value holds ASCII and nothing past it: RFC 9110 lets one hold bytes above ASCII only as obsolete
 * text, so a media type whose quoted parameter holds an accented letter is refused. A link's own
 * `title` is not a media type, and may hold any letter.
 *
 * Each space has one place it can belong. Were the spaces after a `;` taken whether a parameter
 * followed or not, those between two semicolons could belong to either, and a value of ` ; ` sixteen
 * times and an `x` would take a second to refuse, eighteen times eight seconds, and twenty a minute
 * and a half, measured, while the table is checked before the resolver starts. Spaces after a `;`
 * belong to the parameter that follows them, or to the next `;`, or end the value if a `;` ends it.
 */
const MEDIA_TYPE =
  /^[A-Za-z0-9][\w!#$&^.+-]{0,126}\/[A-Za-z0-9][\w!#$&^.+-]{0,126}(?:[ \t]*;(?:[ \t]*[\w!#$%&'*+.^`|~-]+=(?:[\w!#$%&'*+.^`|~-]+|"(?:[\t !#-[\]-~]|\\[\t -~])*"))?)*(?:(?<=;)[ \t]+)?$/;

/** A term of the GS1 vocabulary is a word: a letter, then letters and digits. */
const GS1_TERM = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * An absolute URI in the characters RFC 3986 allows: a scheme, a colon, and then unreserved and
 * reserved characters and percent escapes. Its parts are not taken apart, because a relation name
 * is compared and published as written and never followed.
 */
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?#[\]]|%[0-9A-Fa-f]{2})+$/;

function isLanguageList(value: unknown): boolean {
  return Array.isArray(value) && value.every((tag) => typeof tag === "string" && LANGUAGE_TAG.test(tag));
}

/**
 * Whether a string holds a control character, or one a parser takes for a line break.
 *
 * Code points rather than a regular expression, because a regular expression holding
 * control characters is nearly always a mistake and the linter is right to refuse one;
 * this is the single place where they are the subject rather than an accident. The C1 controls,
 * U+0080 to U+009F, are control characters as much as the C0 ones, and U+0085 is a line break to
 * some parsers; U+2028 and U+2029 are in with them too: a parser treats them as line breaks and
 * an editor shows nothing. Format characters are not refused, though most show nothing. The
 * zero-width non-joiner and joiner are how Persian, Arabic and the Indic scripts write words, and
 * a title in one of those is a title. The zero-width space and the controls that set a direction
 * are kept with them though no title here needs them, the override among them that can reverse
 * what a reader of the linkset sees: a title is written by the table's author, who already
 * decides where every scan goes.
 */
function holdsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
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

/**
 * What makes two links of one level the same link: every field the linkset publishes for it, its
 * type, the address of its href, its title, languages and media type. Whether it is the default
 * is not among them, being published apart from the link's own entry.
 */
function copyOf(link: StoredLink): string {
  return JSON.stringify([
    expandLinkType(link.linkType),
    addressOf(link.href),
    link.title,
    link.hreflang ?? null,
    link.type ?? null,
  ]);
}

/** The address the URL parser reads in an href, or the href as written where it reads none. */
function addressOf(href: string): string {
  try {
    return new URL(href).href;
  } catch {
    return href;
  }
}

/**
 * Whether a relation names GS1's vocabulary in a spelling other than the two read as GS1's, `gs1:`
 * and `https://gs1.org/voc/`: the prefix in another case, or the vocabulary's address with its
 * scheme or host in capitals, its default port, an escaped letter, a user name, a fragment, without
 * its last slash, or over plain http. Capitals in the scheme or host, the default port and an
 * escaped letter leave it the same URI under RFC 3986's normalization; a user name, a fragment, the
 * missing last slash and plain http make it another. Either way each names GS1's vocabulary to
 * whoever reads it, and each is a relation of its own to everything here that compares link types,
 * so a request for the term would not find it.
 */
function writesGs1Namespace(relation: string): boolean {
  if (/^gs1:/i.test(relation)) return true;
  let parsed: URL;
  try {
    parsed = new URL(relation);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.hostname !== "gs1.org") return false;
  const path = parsed.pathname.replace(/%[0-9A-Fa-f]{2}/g, (encoded) => {
    const character = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
    return /[A-Za-z0-9._~-]/.test(character) ? character : encoded;
  });
  return path === "/voc" || path.startsWith("/voc/");
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
    //
    // And within a level a copy is a link written twice with every published field the same:
    // its type, the address of its href, its title, languages and media type. Keyed on the type
    // and the href alone, one page listed once for each of its languages, with the default on
    // the second, lost the second and its default with it: every plain scan of the code
    // answered that no default was set, while readiness said ready. The href is compared as the
    // address it is published as, below, so two spellings of one address are one link. Whether
    // a link is the default is not in its published entry, so it is not in the key either: a
    // copy marked as the default makes the link kept the default, where the two were listed
    // under their type as the same link twice.
    const seen = new Map<string, Candidate>();
    for (const stored of table.entries[level] ?? []) {
      const key = copyOf(stored);
      const kept = seen.get(key);
      if (kept !== undefined) {
        if (stored.default === true) kept.default = true;
        continue;
      }
      // Each with the address the URL parser reads in its href, which is the one a redirect
      // sends, so the linkset, a scan's line and the Location name one place whatever spelling
      // the table holds: `https://evil.example\@good.example/` is answered as
      // `https://evil.example/@good.example/`, which no reader takes for a user name before
      // another host. An href the parser cannot read, in a table nobody checked, is answered
      // with as it is written, as every other link in that table is answered with its address.
      const candidate: Candidate = { ...stored, href: addressOf(stored.href), anchor: level };
      seen.set(key, candidate);
      found.push(candidate);
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
  // The link marked as the default at the most specific level that has one: the levels run from
  // the code as scanned up to its primary key.
  const fallback = candidates.find((candidate) => candidate.default === true);

  // A request for `gs1:defaultLink` asks for the link the linkset publishes under that relation,
  // which is that default and no other, whatever languages the request names: no link in a table
  // is of that type, so it answered 404 while the linkset advertised the relation, and answered as
  // a plain scan is, a French phone was sent to a French page published under its own type only.
  if (request.linkType && sameLinkType(request.linkType, "gs1:defaultLink")) return fallback;
  if (request.linkType) {
    const asked = candidates.filter((candidate) => sameLinkType(candidate.linkType, request.linkType ?? ""));
    return best(asked, request.acceptLanguage);
  }
  if (!fallback) return undefined;

  // The default decides which link type is on offer, and the levels it is chosen from: its own,
  // and those more specific than it, which come first and mark no default. The request then gets
  // to improve on which of that type it lands on. Filtering to the default alone would make the
  // rest of this sentence in the standard mean nothing, since one link cannot be bettered. Taken
  // from every level, the type's links sent a French phone scanning a lot that has a default of
  // its own to the product's French page; taken from the default's level alone, they sent a
  // French phone scanning a lot with a French page of its own, and no default, to the product's
  // English one.
  const levels = new Set<string>();
  for (const candidate of candidates) {
    levels.add(candidate.anchor);
    if (candidate.anchor === fallback.anchor) break;
  }
  const siblings = candidates.filter(
    (candidate) => sameLinkType(candidate.linkType, fallback.linkType) && levels.has(candidate.anchor),
  );
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
      // `q` in any case, as HTTP spells its parameter names: `fr;Q=0`, which refuses French, was
      // read as French at full weight, chose the French link and was recorded as the reason.
      const quality = rest.find((piece) => /^q=/i.test(piece.trim()));
      return { tag: tag.trim().toLowerCase(), q: quality ? Number(quality.trim().slice(2)) : 1 };
    })
    .filter((entry) => entry.tag.length > 0 && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

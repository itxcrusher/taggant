/**
 * GS1 Digital Link URIs: reading them, and refusing the ones that are not.
 *
 * The table below is the set of primary identifiers a resolver can be asked about, with
 * the qualifiers each one allows and how its check digit works. The values were taken from
 * the application identifier table published in GS1's own Digital Link toolkit and checked
 * against it rather than written from memory; they are facts about the standard, and the
 * standard is the thing this has to agree with.
 */

export interface Identifier {
  ai: string;
  /** The alphabetic form the standard also allows in a path, such as `gtin` for `01`. */
  shortCode: string;
  /** Qualifier AIs, in the order the standard requires them to appear. */
  qualifiers: readonly string[];
  /** What the value has to look like. */
  pattern: RegExp;
  /**
   * How the check digit works. `last` is the final character; a number is the position,
   * counting from one, of a check digit computed over everything before it. `none` means
   * the identifier does not carry one.
   */
  check: "last" | "none" | number;
  /**
   * Length the value is zero padded to, when the standard says shorter forms denote the
   * same thing. A GTIN is the case that matters: an EAN-13 is thirteen digits and is the
   * form actually printed on a pack, and it denotes the same GTIN as its fourteen digit
   * form. Leading zeros do not change the check digit, so padding is safe after validation.
   */
  padTo?: number;
}

const IDENTIFIERS: readonly Identifier[] = [
  { ai: "00", shortCode: "sscc", qualifiers: [], pattern: /^\d{18}$/, check: "last" },
  {
    ai: "01",
    shortCode: "gtin",
    qualifiers: ["22", "10", "21"],
    pattern: /^(\d{12,14}|\d{8})$/,
    check: "last",
    padTo: 14,
  },
  {
    ai: "253",
    shortCode: "gdti",
    qualifiers: [],
    pattern: /^\d{13}[\x21-\x22\x25-\x2f\x30-\x3f\x41-\x5a\x5f\x61-\x7a]{0,17}$/,
    check: 13,
  },
  { ai: "255", shortCode: "gcn", qualifiers: [], pattern: /^\d{13}\d{0,12}$/, check: 13 },
  {
    ai: "401",
    shortCode: "ginc",
    qualifiers: [],
    pattern: /^[\x21-\x22\x25-\x2f\x30-\x3f\x41-\x5a\x5f\x61-\x7a]{1,30}$/,
    check: "none",
  },
  { ai: "402", shortCode: "gsin", qualifiers: [], pattern: /^\d{17}$/, check: "last" },
  { ai: "414", shortCode: "gln", qualifiers: ["254"], pattern: /^\d{13}$/, check: "last" },
  { ai: "415", shortCode: "payto", qualifiers: [], pattern: /^\d{13}$/, check: "last" },
  {
    ai: "8003",
    shortCode: "grai",
    qualifiers: [],
    pattern: /^\d{14}[\x21-\x22\x25-\x2f\x30-\x3f\x41-\x5a\x5f\x61-\x7a]{0,16}$/,
    check: 13,
  },
  {
    ai: "8004",
    shortCode: "giai",
    qualifiers: [],
    pattern: /^[\x21-\x22\x25-\x2f\x30-\x3f\x41-\x5a\x5f\x61-\x7a]{1,30}$/,
    check: "none",
  },
  { ai: "8006", shortCode: "itip", qualifiers: ["22", "10", "21"], pattern: /^\d{18}$/, check: 14 },
  {
    ai: "8010",
    shortCode: "cpid",
    qualifiers: ["8011"],
    pattern: /^[\x23\x2d\x2f\x30-\x39\x41-\x5a]{1,30}$/,
    check: "none",
  },
  { ai: "8017", shortCode: "gsrnp", qualifiers: ["8019"], pattern: /^\d{18}$/, check: "last" },
  { ai: "8018", shortCode: "gsrn", qualifiers: ["8019"], pattern: /^\d{18}$/, check: "last" },
] as const;

/** Qualifier AIs and the short forms a path may use for them. */
const QUALIFIER_SHORT_CODES: Readonly<Record<string, string>> = {
  "10": "lot",
  "21": "ser",
  "22": "cpv",
  "254": "glnx",
  "8011": "cpsn",
  "8019": "srin",
};

const BY_AI = new Map(IDENTIFIERS.map((entry) => [entry.ai, entry]));
const BY_SHORT_CODE = new Map(IDENTIFIERS.map((entry) => [entry.shortCode, entry]));
const QUALIFIER_BY_SHORT_CODE = new Map(
  Object.entries(QUALIFIER_SHORT_CODES).map(([ai, short]) => [short, ai]),
);

/** The primary identifiers this resolver understands, for the description file. */
export const SUPPORTED_PRIMARY_KEYS: readonly string[] = IDENTIFIERS.map((entry) => entry.ai);

export class DigitalLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigitalLinkError";
  }
}

export interface Pair {
  ai: string;
  value: string;
}

export interface DigitalLink {
  primary: Pair;
  /** Key qualifiers, in the order they appeared, which is the order the standard requires. */
  qualifiers: Pair[];
  /** Whatever preceded the identifiers in the path, encoded, with a leading slash or empty. */
  stem: string;
  /**
   * The canonical form: numeric AIs, no short codes, no trailing slash, and no stem.
   *
   * This is what the table is keyed on and what a scan event names, so the same product
   * does not split into as many identifiers as there are paths a caller can invent in
   * front of it. GS1's own toolkit separates the two the same way, calling them the URI
   * stem and the uncompressed path; the whole address is the one followed by the other.
   */
  canonicalPath: string;
}

/**
 * The GS1 check digit: alternating weights of three and one from the rightmost data digit.
 */
export function checkDigit(digits: string): number {
  let sum = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(digits[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

function checkDigitHolds(entry: Identifier, value: string): boolean {
  if (entry.check === "none") return true;
  const position = entry.check === "last" ? value.length : entry.check;
  const body = value.slice(0, position - 1);
  const found = value[position - 1];
  if (!/^\d+$/.test(body) || found === undefined) return false;
  return checkDigit(body) === Number(found);
}

/**
 * Read a Digital Link URI's path.
 *
 * The standard allows anything before the identifiers, so the first segment that names a
 * primary identifier is where the link starts and everything before it is the prefix.
 * A trailing slash is tolerated, which the standard asks for and which is the sort of
 * thing that quietly breaks a resolver otherwise.
 */
/**
 * Longest path this will read.
 *
 * The stem is reflected into the Link header three times, so a request the server accepted
 * produced a response no mainstream client could parse: 7 KB of path became 16 KB of
 * headers, which Node's own fetch refuses to read. A Digital Link is short; anything of
 * this length is not one.
 */
const MAX_PATH_LENGTH = 512;

export function parseDigitalLink(pathname: string): DigitalLink {
  if (pathname.length > MAX_PATH_LENGTH) {
    throw new DigitalLinkError(
      `the path is ${pathname.length} characters and the longest this reads is ${MAX_PATH_LENGTH}`,
    );
  }
  const segments = pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);
  if (segments.length === 0) throw new DigitalLinkError("the path holds no identifier");

  let start = -1;
  let entry: Identifier | undefined;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    const found = BY_AI.get(segment) ?? BY_SHORT_CODE.get(segment);
    if (found) {
      start = i;
      entry = found;
      break;
    }
  }
  if (start < 0 || !entry) throw new DigitalLinkError("no primary identifier was found in the path");

  const rest = segments.slice(start);
  if (rest.length % 2 !== 0) throw new DigitalLinkError("every identifier must be followed by a value");

  const value = rest[1] ?? "";
  if (!entry.pattern.test(value)) {
    throw new DigitalLinkError(`${value} is not a valid value for application identifier ${entry.ai}`);
  }
  if (!checkDigitHolds(entry, value)) {
    throw new DigitalLinkError(`the check digit in ${value} is wrong for application identifier ${entry.ai}`);
  }

  const qualifiers: Pair[] = [];
  let allowedFrom = 0;
  for (let i = 2; i < rest.length; i += 2) {
    const key = rest[i] ?? "";
    const ai = QUALIFIER_BY_SHORT_CODE.get(key) ?? key;
    const position = entry.qualifiers.indexOf(ai);
    if (position < 0) {
      throw new DigitalLinkError(`${key} is not a key qualifier for application identifier ${entry.ai}`);
    }
    if (position < allowedFrom) {
      // The standard fixes the order, and out of order qualifiers change what is
      // identified rather than merely reading oddly.
      throw new DigitalLinkError(`key qualifier ${ai} is out of order`);
    }
    allowedFrom = position + 1;
    qualifiers.push({ ai, value: rest[i + 1] ?? "" });
  }

  // Normalised, so the form a code is printed in does not decide whether it is found. A
  // scan of a real EAN-13 answered "nothing is linked to that identifier" against a table
  // keyed on the fourteen digit form, which is the form a person types into a table.
  const primary: Pair = {
    ai: entry.ai,
    value: entry.padTo && value.length < entry.padTo ? value.padStart(entry.padTo, "0") : value,
  };
  return {
    primary,
    qualifiers,
    stem: stemOf(segments.slice(0, start).join("/")),
    canonicalPath: canonicalise(primary, qualifiers),
  };
}

export function canonicalise(primary: Pair, qualifiers: Pair[]): string {
  const parts = [primary.ai, primary.value];
  for (const qualifier of qualifiers) parts.push(qualifier.ai, qualifier.value);
  return `/${parts.map(encodeURIComponent).join("/")}`;
}

/**
 * The part of the path in front of the identifiers, encoded.
 *
 * Encoded because it is the one part of the address a caller writes freely, and it reaches
 * a Link header and the subject of every fact presented. Unencoded, a quote in it closed
 * the URI reference and let a caller add parameters to a header a client parses, and a
 * carriage return made the server throw where a 400 belonged.
 *
 * Kept apart from the identifier path rather than folded into it. The table is keyed on
 * the path alone, so the same product does not split into as many identifiers as there are
 * paths a caller can invent in front of it, and the whole address is the stem followed by
 * the path. GS1's own toolkit separates them the same way.
 */
export function stemOf(prefix: string): string {
  if (prefix.length === 0) return "";
  return `/${prefix.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Every level of a link's own hierarchy, most specific first.
 *
 * The standard requires that a request carrying key qualifiers also returns the links
 * attached at each level above it, up to the primary key on its own, so a serial number
 * with nothing of its own still reaches whatever the product has.
 */
export function ancestry(link: DigitalLink): string[] {
  const levels: string[] = [];
  for (let depth = link.qualifiers.length; depth >= 0; depth--) {
    levels.push(canonicalise(link.primary, link.qualifiers.slice(0, depth)));
  }
  return levels;
}

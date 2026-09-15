/**
 * Whether a file is a drawing this bundler is willing to publish.
 *
 * A bundle is served by any static host, including one that sets no headers, and every
 * asset sits at its own address. A browser opening that address directly runs whatever the
 * file says, on the bundle's own origin, and the console accepts uploads: an operator can
 * be handed artwork by a designer or a client and publish it onto their own domain without
 * opening it. So the question this answers is not "will the runtime execute it" (it will
 * not, content is loaded through an `img`) but "is it safe at its own address".
 *
 * **This replaces a set of regular expressions over the file's text, and the reason is worth
 * keeping.** That approach was written, reviewed and shipped in one day, and an adversarial
 * pass then produced five bypasses against it, one of them demonstrated executing:
 *
 *   `<svg:script>`              the tag test matched an unprefixed name, and a prefixed one
 *                               is legal XML and is still an SVGScriptElement. It set
 *                               document.title from the published file, on the bundle's origin.
 *   `<s:foreignObject>`         the same evasion, same cause.
 *   `href="https:&#47;&#47;h/x"`  entity-encoded slashes, fetched by the browser anyway.
 *   `href="http:host/path"`     a scheme with no slashes at all, which resolves off-origin
 *                               whenever it differs from the page's, fetched anyway.
 *   `xmlns="` inside a comment   the namespace strip ran over the whole document with a
 *                               `[^"']*` span, so it swallowed live `url(...)` references
 *                               between one quote and the next.
 *
 * And in the other direction it refused a default Inkscape export, an Illustrator SVG 1.1
 * export, an embedded raster and artwork with a web address drawn on it, because a public
 * identifier like `-//W3C//DTD SVG 1.1//EN` and a base64 payload both contain two slashes.
 *
 * Both failures have one cause: matching patterns in text cannot see structure, so it
 * misses what is written differently and trips on what only looks the same. This reads the
 * document instead, and decides on an allowlist, because a list of things known to be
 * dangerous is only ever as long as the last person's imagination.
 */

/** What a drawing may contain. Local names, so a prefix changes nothing. */
const ELEMENTS = new Set(
  [
    // Structure.
    "svg,g,defs,symbol,use,switch,title,desc,metadata,style",
    // Shapes and text.
    "path,rect,circle,ellipse,line,polyline,polygon,text,tspan,textpath,tref,image,a,marker",
    // Paint.
    "lineargradient,radialgradient,stop,pattern,clippath,mask,filter",
    // Filter primitives. `feImage` is deliberately absent: it takes a reference.
    "feblend,fecolormatrix,fecomponenttransfer,fecomposite,feconvolvematrix,fediffuselighting",
    "fedisplacementmap,fedropshadow,feflood,fefunca,fefuncb,fefuncg,fefuncr,fegaussianblur",
    "femerge,femergenode,femorphology,feoffset,fepointlight,fespecularlighting,fespotlight",
    "fedistantlight,fetile,feturbulence",
    // Editors write their own bookkeeping into the file, and refusing it would refuse every
    // Inkscape drawing in existence. None of it renders or fetches.
    "namedview,rdf,work,agent,license,format,type,title,date,creator,description,permits",
    "requires,prohibits,sodipodi:namedview,flowroot,flowregion,flowpara,path-effect",
  ]
    .join(",")
    .split(","),
);

/**
 * Attributes that carry a reference, by local name.
 *
 * Their values are decoded and checked. Everything else is left alone: an attribute that
 * cannot name a resource cannot fetch one, and listing every presentation attribute in SVG
 * would be a second allowlist to keep up to date for no gain.
 */
const REFERENCING = new Set([
  "href",
  "src",
  "style",
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
  "about",
  "resource",
]);

/** What a reference may be. Anything else is refused by name. */
function refusedScheme(value: string): string | null {
  const text = decodeEntities(value).trim();
  // Every `url(...)` inside a style or presentation value, plus the value itself.
  const candidates = [
    text,
    ...[...text.matchAll(/url\(\s*['"]?([^'")]*)['"]?\s*\)/gi)].map((m) => m[1] ?? ""),
  ];
  if (/@import/i.test(text)) return "@import";
  for (const raw of candidates) {
    const candidate = raw.trim();
    if (candidate === "") continue;
    // A fragment or a relative path stays inside the bundle, which is the whole point.
    if (candidate.startsWith("#") || !/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
      // ...unless it is protocol relative, which has no scheme and is not relative either.
      if (candidate.startsWith("//")) return candidate.slice(0, 60);
      continue;
    }
    const scheme = candidate.slice(0, candidate.indexOf(":")).toLowerCase();
    // An embedded raster is the one scheme that carries its own bytes and reaches nowhere.
    if (scheme === "data") {
      if (/^data:image\//i.test(candidate)) continue;
      return "data: that is not an image";
    }
    return candidate.slice(0, 60);
  }
  return null;
}

/**
 * XML character and numeric references, resolved before anything is judged.
 *
 * `href="https:&#47;&#47;evil/x"` is the same request as the plain spelling and was
 * published by the version this replaces.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** The part of a name after any prefix, lowercased. */
function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon < 0 ? name : name.slice(colon + 1)).toLowerCase();
}

/** Everything wrong with this file, in the order it was found. */
export function whyNotADrawing(bytes: Buffer): string[] {
  const text = bytes.toString("utf8");
  const wrong: string[] = [];

  // A document type may declare entities, which is how a file reads another file off the
  // host that renders it. The declaration is refused; the plain `<!DOCTYPE svg PUBLIC ...>`
  // that Illustrator writes on every export is not, because it declares nothing.
  for (const doctype of text.matchAll(/<!DOCTYPE[\s\S]*?>/gi)) {
    if (/<!ENTITY/i.test(doctype[0])) wrong.push("a document type that declares entities");
  }

  // Comments and CDATA hold no elements. Replaced with spaces rather than removed, so the
  // offsets of everything after them do not move.
  const scannable = text
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length))
    .replace(/<!DOCTYPE[\s\S]*?>/gi, (m) => " ".repeat(m.length))
    .replace(/<\?[\s\S]*?\?>/g, (m) => " ".repeat(m.length));

  // Inside `metadata` nothing renders and nothing is fetched, and it is where every editor
  // puts its licence and authorship in vocabularies this has no business knowing.
  let skipTo = -1;
  for (const tag of scannable.matchAll(/<\s*(\/?)([a-z_][\w.:-]*)([^>]*)>/gi)) {
    const at = tag.index ?? 0;
    if (at < skipTo) continue;
    const closing = tag[1] === "/";
    const name = localName(tag[2] ?? "");
    const rest = tag[3] ?? "";

    if (name === "metadata" && !closing) {
      const end = scannable.toLowerCase().indexOf("</", at + 1);
      const close = scannable.slice(at).search(/<\s*\/\s*[\w.:-]*metadata\s*>/i);
      skipTo = close < 0 ? (end < 0 ? scannable.length : end) : at + close;
      continue;
    }
    if (closing) continue;

    if (!ELEMENTS.has(name)) {
      wrong.push(`a <${tag[2]}> element, which is not part of a drawing`);
      continue;
    }

    for (const attribute of rest.matchAll(/([a-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
      const key = localName(attribute[1] ?? "");
      const value = attribute[3] ?? attribute[4] ?? "";
      if (key.startsWith("on")) {
        wrong.push(`an ${attribute[1]} handler`);
        continue;
      }
      // SMIL can set an attribute that a handler lives in, which is a handler written twice.
      if (key === "attributename" && localName(decodeEntities(value)).startsWith("on")) {
        wrong.push(`an animation that sets ${value}`);
        continue;
      }
      if (!REFERENCING.has(key)) continue;
      const refused = refusedScheme(value);
      if (refused !== null) wrong.push(`${attribute[1]}="${refused}", which is not inside the bundle`);
    }
  }

  // Style elements hold CSS, which reaches out the same way an attribute does.
  for (const style of scannable.matchAll(/<\s*(?:[\w.:-]*:)?style\b[^>]*>([\s\S]*?)<\s*\//gi)) {
    const refused = refusedScheme(style[1] ?? "");
    if (refused !== null) wrong.push(`a stylesheet reaching ${refused}`);
  }

  return [...new Set(wrong)];
}

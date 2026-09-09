import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

export interface CopiedAsset {
  /** The path as the manifest wrote it. */
  from: string;
  /** The name inside the bundle, which is the content's own hash. */
  to: string;
  bytes: number;
}

/**
 * Copy one asset into the bundle under a name taken from its content.
 *
 * Content addressing is what makes a bundle safe to cache forever and safe to publish
 * beside an older one: the same bytes always land on the same name, and different bytes
 * never collide. It also means republishing an experience whose video did not change does
 * not invalidate the video.
 */
export async function copyAsset(source: string, sourceDir: string, outDir: string): Promise<CopiedAsset> {
  // A fragment names a part of a file rather than a file, which is how one symbol in an
  // SVG sprite is referenced. It is not part of the name on disk, and it has to survive to
  // the rewritten path or the reference stops meaning anything.
  const hash = source.indexOf("#");
  const file = hash < 0 ? source : source.slice(0, hash);
  const fragment = hash < 0 ? "" : source.slice(hash);

  const absolute = await realWithin(sourceDir, file);
  const bytes = await readFile(absolute);
  if (extname(file).toLowerCase() === ".svg") refuseActiveSvg(source, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}${extname(file).toLowerCase()}`;
  const assets = join(outDir, "assets");
  await mkdir(assets, { recursive: true });
  await copyFile(absolute, join(assets, name));
  return { from: source, to: `assets/${name}${fragment}`, bytes: bytes.length };
}

/**
 * An SVG is a document, not a picture, and it can carry script.
 *
 * The runtime loads content through an `img` element, which does not run script, so this
 * is not reachable through the experience. Navigating straight to the asset is: the file
 * sits at its own address in the bundle, and a browser opening it runs whatever is inside
 * on the bundle's own origin.
 *
 * This was written down as something only a header on the host could fix. That is wrong in
 * a way that matters here, because a bundle is meant to be served by any static host,
 * including one that sets no headers, and the console accepts uploads: an operator can be
 * handed an SVG by a designer or a client and publish it onto their own domain without
 * ever opening it.
 *
 * So it is refused rather than stripped. Stripping would quietly change somebody's artwork
 * and publish a thing they did not draw; refusing tells them which file and what is in it.
 */
function refuseActiveSvg(source: string, bytes: Buffer): void {
  // Comments first, or a commented-out handler reads as live and an author is refused for
  // nothing. Text nodes are not stripped: script inside a `title` is still inside the file
  // a browser parses.
  const text = bytes.toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
  const found: string[] = [];
  if (/<\s*script[\s>/]/i.test(text)) found.push("a script element");
  // Any `on*` attribute is an event handler. Matched on the attribute position rather than
  // anywhere in the text, so a word like `one=` inside a path or a title does not trip it.
  if (/\son[a-z]+\s*=\s*["']/i.test(text)) found.push("an event handler attribute");
  if (/(?:href|xlink:href)\s*=\s*["']\s*javascript:/i.test(text)) found.push("a javascript: link");
  // Anything inside this is HTML, parsed as HTML, script included.
  if (/<\s*foreignObject[\s>/]/i.test(text)) found.push("a foreignObject");
  if (found.length === 0) return;
  throw new Error(
    `${source} is an SVG carrying ${found.join(" and ")}, and a bundle is served from a host that may set no headers. Take it out, or export the artwork as a PNG.`,
  );
}

/**
 * Resolve a manifest path against the directory it belongs to, refusing anything that
 * leaves it.
 *
 * A manifest is written by someone else, and this runs with the file system rights of
 * whoever publishes. `../../../etc/passwd` in a `src` must not put that file in a public
 * bundle. The schema already forbids it; this is the second lock, on the side that would
 * actually do the reading.
 */
export function within(sourceDir: string, source: string): string {
  // Decoded first, and backslashes read as separators, because both are ways of writing a
  // parent step that a naive check waves through and a browser then resolves. The schema
  // refuses them too; this is the side that would do the reading.
  let decoded = source;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    throw new Error(`${source} is not a readable path`);
  }
  if (decoded.includes("\\")) {
    throw new Error(`${source} uses backslashes, which are not path separators in a manifest`);
  }
  const base = resolve(sourceDir);
  const target = resolve(base, normalize(decoded));
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`${source} is outside the manifest's own directory and will not be bundled`);
  }
  return target;
}

/**
 * The same containment check, made against where the file really is.
 *
 * `within` compares paths as text, which is all it can do without touching the disk, and
 * that is not enough: a symbolic link or a Windows directory junction inside the source
 * folder passes it and then `copyFile` follows the link out. Proved by publishing
 * `/etc/passwd` through a link named `logo.png`, and on Windows by publishing a secrets
 * file through a junction, which needs no administrator rights to create.
 *
 * So the path is resolved on the disk before anything is read, and checked again. The
 * source directory is resolved too, because it may itself sit behind a link, and comparing
 * a real path against a lexical one would refuse ordinary setups on macOS where /tmp is a
 * link to /private/tmp.
 */
export async function realWithin(sourceDir: string, source: string): Promise<string> {
  const lexical = within(sourceDir, source);
  let real: string;
  let realBase: string;
  try {
    real = await realpath(lexical);
    realBase = await realpath(sourceDir);
  } catch (error) {
    // A path that cannot be resolved is a missing asset, which is the caller's problem to
    // hear about plainly rather than a containment failure.
    throw new Error(`${source} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new Error(
      `${source} points outside the manifest's own directory and will not be bundled: it resolves to ${real}`,
    );
  }
  return real;
}

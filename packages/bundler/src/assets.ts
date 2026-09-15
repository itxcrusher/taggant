import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { whyNotADrawing } from "./svg.js";

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
  refuseUnsafeAsset(source, file, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}${extname(file).toLowerCase()}`;
  const assets = join(outDir, "assets");
  await mkdir(assets, { recursive: true });
  // The bytes that were read, not the file they came from. This was `copyFile`, which opens
  // the source again: the checked bytes and the published bytes were two reads of a path,
  // and anything that rewrote it in between shipped unchecked content under the hash of
  // content it no longer had. The console accepts uploads, so that window is reachable.
  await writeFile(join(assets, name), bytes);
  return { from: source, to: `assets/${name}${fragment}`, bytes: bytes.length };
}

/**
 * Refuse an asset a browser would treat as a document rather than a picture.
 *
 * This was gated on the `.svg` extension, and a manifest may name any file: an `.html` or
 * `.xhtml` asset carrying a script was copied in untouched and served as a document by any
 * static host, at its own address on the bundle's origin. So the decision is made on what
 * the bytes are, not on what the file is called.
 *
 * Only SVG is examined and allowed through. Every other document format is refused whole:
 * this bundler has no business publishing HTML nobody wrote for it, and the runtime cannot
 * show one anyway.
 */
function refuseUnsafeAsset(source: string, file: string, bytes: Buffer): void {
  const head = bytes
    .subarray(0, 1024)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  const extension = extname(file).toLowerCase();
  const looksLikeMarkup = head.startsWith("<?xml") || head.startsWith("<!doctype") || head.startsWith("<");
  if (!looksLikeMarkup && ![".svg", ".html", ".xhtml", ".xml"].includes(extension)) return;

  const isSvg = extension === ".svg" || /<\s*(?:[\w.:-]*:)?svg[\s>]/.test(head);
  if (!isSvg) {
    throw new Error(
      `${source} is a document rather than a picture, and a bundle serves every asset at its own address on its own origin. Export the artwork as a PNG or an SVG.`,
    );
  }

  const wrong = whyNotADrawing(bytes);
  if (wrong.length === 0) return;
  throw new Error(
    `${source} is an SVG carrying ${wrong.join(" and ")}, and a bundle has to work with nothing else running. Take it out, or export the artwork as a PNG.`,
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

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
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
  const absolute = within(sourceDir, source);
  const bytes = await readFile(absolute);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}${extname(source).toLowerCase()}`;
  const assets = join(outDir, "assets");
  await mkdir(assets, { recursive: true });
  await copyFile(absolute, join(assets, name));
  return { from: source, to: `assets/${name}`, bytes: bytes.length };
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

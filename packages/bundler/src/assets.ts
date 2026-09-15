import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
 *
 * The bytes written are the bytes this function read and, for an SVG, rendered. Nothing is
 * read from the path a second time, so a file rewritten between the check and the copy
 * cannot ship unchecked content under the hash of something else.
 */
export async function copyAsset(source: string, sourceDir: string, outDir: string): Promise<CopiedAsset> {
  // A fragment used to be kept so that one symbol of an SVG sprite could be referenced. No
  // SVG ships any more, a raster has no symbols, and nothing in this repository or its
  // documents ever used one, so a fragment is refused rather than carried into a path
  // where it can no longer mean anything.
  if (source.includes("#")) {
    throw new Error(
      `${source} names a fragment, and a bundle carries no document a fragment could point into. Name the file on its own.`,
    );
  }

  const absolute = await realWithin(sourceDir, source);
  const read = await readFile(absolute);
  const { bytes, extension } = await prepareAsset(source, read);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}${extension}`;
  const assets = join(outDir, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, name), bytes);
  return { from: source, to: `assets/${name}`, bytes: bytes.length };
}

/**
 * The longest edge, in pixels, an SVG is rendered at.
 *
 * Content is placed by the runtime as a fraction of the artwork's size, so what matters is
 * that the raster is larger than any phone will show it. A postcard-sized target on a phone
 * is a few hundred pixels across; this is several times that.
 */
export const RASTER_EDGE = 2048;

/**
 * The most units an SVG may declare on its long side.
 *
 * The renderer is asked for the drawing at RASTER_EDGE by setting the density it reads the
 * document at, and the lowest density it accepts is one dot per inch, so past this a
 * document cannot be brought to RASTER_EDGE that way. Measured, the library still scales a
 * million-unit document down on the way in (2048 px, a third of a second, 27 MB), but that
 * is its behaviour rather than a property this code sets, and no drawing anyone prints
 * declares fourteen metres at a tenth of a millimetre a unit. Past this it is refused by
 * name, so the bound on what a publish allocates is this file's own.
 */
export const LARGEST_DECLARED_EDGE = 72 * RASTER_EDGE;

/**
 * What ships and as what, decided from the bytes rather than from the file's name.
 *
 * A bundle is served by any static host, including one that sets no headers, and every
 * asset sits at its own address on that origin. A browser opening the address of a
 * document runs whatever the document says. So a bundle carries no document: rasters, video
 * and audio pass through as bytes once their own signatures say what they are, an SVG is
 * rendered to a PNG, and anything else is refused by name.
 *
 * **This replaces two attempts at reading SVG and deciding what was safe in it, and the
 * reason is the whole design.** The first matched patterns in the text, and an adversarial
 * pass produced five bypasses, one executing. The second read the document with a
 * tokeniser and an allowlist, and the next pass produced seven, ten payloads executing or
 * fetching in two browsers: a UTF-16 encoding made the text invisible to it, a self-closing
 * metadata element switched it off for the rest of the file, a closing angle bracket inside
 * a quoted attribute hid every attribute after it, a stylesheet inside CDATA was blanked
 * before it was read, a newline entity inside a scheme turned an absolute address into a
 * relative one, and an unterminated tag made the tokeniser quadratic. It also still refused
 * a default Inkscape, Illustrator or Affinity export, because a style attribute reads as a
 * scheme. Twelve bypasses across the two, each found by somebody other than the person who
 * wrote the control.
 *
 * Rendering does not have that shape. The renderer is librsvg, through libvips, which has
 * no script engine and no network stack, and it is given a buffer with no base location, so
 * a file: or relative reference has nowhere to resolve; measured, an embedded data: image
 * renders and a file: reference to the same image renders nothing. What comes out is pixels
 * of the drawing the author drew, and pixels cannot run or fetch. Whatever was in the
 * document that was not a drawing is not in the output, which is the property the two
 * earlier controls were trying to establish by inspection.
 *
 * What it costs: an overlay is a raster rather than a vector, rendered at RASTER_EDGE on its
 * long side; the bundler depends on sharp where before only the compiler did; and every SVG
 * costs a process, because the renderer is held to a clock and kept where a crash cannot
 * reach the publisher (`render-child.ts`).
 */
export async function prepareAsset(
  source: string,
  bytes: Buffer,
  options: { renderTimeoutMs?: number } = {},
): Promise<{ bytes: Buffer; extension: string }> {
  const kind = sniff(bytes);
  switch (kind) {
    case "png":
    case "jpg":
    case "gif":
    case "webp":
    case "avif":
    case "mp4":
    case "webm":
    case "mp3":
    case "wav":
    case "ogg":
    case "glb":
      return { bytes, extension: `.${kind}` };
    case "svg":
      return {
        bytes: await rasterise(source, bytes, options.renderTimeoutMs ?? RENDER_TIMEOUT_MS),
        extension: ".png",
      };
    case "utf16":
      throw new Error(
        `${source} is UTF-16 text, which no image or video is. If it is an SVG, save it as UTF-8; a bundle cannot carry it as it is.`,
      );
    case "document":
      throw new Error(
        `${source} is a document rather than a picture, and a bundle serves every asset at its own address on its own origin. Export the artwork as a PNG or an SVG.`,
      );
    default:
      throw new Error(
        `${source} is not a format this bundler publishes: its bytes are not a PNG, JPEG, GIF, WebP, AVIF, SVG, MP4, WebM, MP3, WAV, OGG or GLB file.`,
      );
  }
}

type Kind =
  | "png"
  | "jpg"
  | "gif"
  | "webp"
  | "avif"
  | "mp4"
  | "webm"
  | "mp3"
  | "wav"
  | "ogg"
  | "glb"
  | "svg"
  | "utf16"
  | "document"
  | "unknown";

/** What the bytes are, from their own signature. The name on disk is not consulted. */
function sniff(bytes: Buffer): Kind {
  const at = (offset: number, text: string) =>
    bytes.length >= offset + text.length &&
    bytes.subarray(offset, offset + text.length).toString("latin1") === text;
  if (at(0, "\x89PNG\r\n\x1a\n")) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (at(0, "RIFF") && at(8, "WAVE")) return "wav";
  if (at(4, "ftyp")) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "avif";
    return "mp4";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return "webm";
  if (at(0, "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2))
    return "mp3";
  if (at(0, "OggS")) return "ogg";
  if (at(0, "glTF")) return "glb";
  // Text from here on. A UTF-16 byte order mark is refused by name, because a browser will
  // read such a file as a document while nothing in this function can see into it.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return "utf16";
  const head = bytes
    .subarray(0, 4096)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (!head.startsWith("<")) return "unknown";
  return /<(?:[\w.-]+:)?svg[\s>/]/i.test(head) ? "svg" : "document";
}

/**
 * How long a render may take before its process is killed and the asset refused.
 *
 * An ordinary drawing renders in well under a second. Anything near this is a document
 * built to hold the renderer, and this is the most a publish will wait for one.
 */
export const RENDER_TIMEOUT_MS = 20_000;

/**
 * The render process's script: beside this file once built, and in `dist` when this file
 * itself is running from source under the test runner.
 */
function renderScript(): string {
  for (const relative of ["./render-child.js", "../dist/render-child.js"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("the bundler's render process is not built; run pnpm build in packages/bundler first");
}

/** What the render process came back with. */
interface Rendered {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  stopped: boolean;
}

/**
 * The drawing as pixels, at a size larger than any phone will show it, from a process of
 * its own.
 *
 * The renderer is a native library reading a document somebody else wrote. Handed a filter
 * with a radius in the hundreds it ran for minutes, and its own timeout, checked between
 * steps rather than inside one, noticed at three percent; handed a convolution matrix of
 * order thirty it took the process down with an illegal instruction. So it never runs in
 * the process that publishes. `render-child.ts` renders, this side holds the clock, and a
 * child that overruns is killed rather than asked, because inside a native call it would
 * not hear.
 */
async function rasterise(source: string, bytes: Buffer, timeoutMs: number): Promise<Buffer> {
  const script = renderScript();
  const result = await new Promise<Rendered>((settle) => {
    const child = spawn(process.execPath, [script, String(RASTER_EDGE), String(LARGEST_DECLARED_EDGE)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let stopped = false;
    const clock = setTimeout(() => {
      stopped = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(clock);
      settle({ code: null, stdout: Buffer.alloc(0), stderr: error.message, stopped });
    });
    child.on("close", (code) => {
      clearTimeout(clock);
      settle({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8").trim(),
        stopped,
      });
    });
    // A child that dies before reading everything closes the pipe under the write.
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);
  });

  if (result.stopped) {
    throw new Error(
      `${source} took longer than ${timeoutMs / 1000} s to render and was stopped. A drawing that slow carries a filter or a size no phone would show; simplify it, or export the artwork as a PNG.`,
    );
  }
  if (result.code === 0) return result.stdout;
  const lines = result.stderr.split("\n").filter((line) => line.trim() !== "");
  const why = lines[lines.length - 1] ?? "";
  if (result.code === 2) {
    throw new Error(
      `${source} declares a size too large to render: ${why}, and the most is ${LARGEST_DECLARED_EDGE} on the long side. Give it a smaller viewBox; it is rendered at ${RASTER_EDGE} px on its long side whatever it declares.`,
    );
  }
  // What an author can put right is named as what it is. The renderer reports a drawing
  // with no size as a corrupt header, and it is not corrupt.
  if (why.includes("bad dimensions")) {
    throw new Error(
      `${source} has no size to render at: give its root svg element a viewBox, or a width and a height. Nothing else in the file says how big the picture is.`,
    );
  }
  if (result.code !== 1) {
    throw new Error(
      `${source} could not be rendered: the renderer stopped without saying why (exit ${result.code ?? "by signal"}), which is what a document built to break it does. Export the artwork as a PNG.`,
    );
  }
  throw new Error(`${source} could not be rendered as an SVG (${why}). Export the artwork as a PNG.`);
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

#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process, { argv, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { type CompiledTarget, compileTarget, toTargetJson } from "./compile.js";
import { type Report, describeWidth } from "./report.js";

/**
 * Exit codes, so a build script can read the outcome instead of parsing stderr.
 *
 * They used to be 1 for four different things, one of them returned after stdout had
 * already printed "ready for press".
 */
export const EXIT = {
  ok: 0,
  usage: 1,
  artworkNotReady: 2,
  cannotRead: 3,
  cannotWrite: 4,
} as const;

const USAGE = "usage: taggant-compile <artwork> [--id <id>] [--scan-distance <mm>] [--out <file>]\n";

/** Distances a person can actually hold a phone at, or stand back to, in millimetres. */
const MIN_SCAN_DISTANCE_MM = 50;
const MAX_SCAN_DISTANCE_MM = 10_000;

const FLAGS = new Set(["--id", "--scan-distance", "--out"]);

export interface Arguments {
  source: string;
  id: string;
  scanDistanceMm: number;
  out?: string;
}

/**
 * Read the arguments, refusing anything ambiguous rather than guessing.
 *
 * The quiet failures are the ones worth refusing. A flag with no value falls through to a
 * default and prints millimetres for a distance nobody asked for. A misspelled flag is
 * ignored the same way. `--out` with no value writes nothing and reports success, so a
 * build carries on without the file. `--id` followed by another flag takes that flag as
 * its value and writes it into the compiled target as an id, which then fails the
 * manifest package's own rule for one. All four would otherwise exit 0.
 */
export function parseArguments(args: string[]): { arguments: Arguments } | { error: string } {
  const values = new Map<string, string>();
  let source: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined) continue;
    // A single dash is an option somebody meant, not a file. `-h` was taken as the artwork, its
    // name became the id, and the answer was a rule about ids.
    if (token.startsWith("-") && !token.startsWith("--")) {
      return { error: `unknown option ${token}; the options are ${[...FLAGS].join(", ")} and --help` };
    }
    if (!token.startsWith("--")) {
      if (source !== undefined) return { error: `unexpected extra argument ${token}` };
      source = token;
      continue;
    }
    if (!FLAGS.has(token)) return { error: `unknown option ${token}` };
    const value = args[i + 1];
    if (value === undefined) return { error: `${token} needs a value` };
    if (value.startsWith("--")) return { error: `${token} needs a value, and ${value} is another option` };
    // Last wins, which is what every other command line does.
    values.set(token, value);
    i++;
  }

  if (source === undefined) return { error: "no artwork given" };

  // Number() accepts hex, exponents and surrounding space. A scan distance is millimetres
  // typed by a person, so it is read as plain decimal or refused.
  const given = values.get("--scan-distance");
  const scanDistanceMm = given === undefined ? 400 : /^\d+(\.\d+)?$/.test(given) ? Number(given) : Number.NaN;
  if (!Number.isFinite(scanDistanceMm)) return { error: "scan distance must be a number of millimetres" };
  if (scanDistanceMm < MIN_SCAN_DISTANCE_MM || scanDistanceMm > MAX_SCAN_DISTANCE_MM) {
    return {
      error: `scan distance must be between ${MIN_SCAN_DISTANCE_MM} and ${MAX_SCAN_DISTANCE_MM} mm, and this is ${scanDistanceMm}`,
    };
  }

  const id =
    values.get("--id") ??
    basename(source)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
  // The same rule the manifest schema applies, so the compiler cannot emit an id its own
  // sibling package rejects.
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
    return { error: `id must be 3 to 64 lower case letters, digits or hyphens, and this is ${id}` };
  }

  const out = values.get("--out");
  // Writing the target over the artwork it was compiled from destroyed the artwork, printed
  // "written" and exited 0, so the one file nobody can regenerate was the one that went. The
  // comparison folds case where the filesystem does, because there `Art.png` and `art.png`
  // are one file.
  if (out !== undefined && samePath(out, source)) {
    return { error: `--out ${out} is the artwork being compiled, and writing there would destroy it` };
  }
  return {
    arguments: out === undefined ? { source, id, scanDistanceMm } : { source, id, scanDistanceMm, out },
  };
}

/**
 * The report as a person reads it in a terminal.
 *
 * Two arguments. It took the scan distance as a third and never read it, which is the shape of
 * the defect the report carries its own distance to prevent: a caller holding a width and a
 * distance separately can pair them wrongly, and the linter does not notice an unread parameter.
 */
export function formatReportLines(source: string, target: CompiledTarget): string[] {
  const { report } = target;
  const lines = [
    "",
    `  ${basename(source)}`,
    `  size                  ${target.width} x ${target.height} px`,
    `  tracking quality      ${report.score} / 100`,
    // Areas rather than a percentage: a feature is a point, and points do not cover
    // anything, so "covering 100% of the artwork" was saying more than it knew.
    `  features              ${report.featureCount}, reaching ${report.areasWithFeatures} of ${report.areas} areas`,
    // Said in full rather than as a bare number, because it is a resolution
    // requirement set by the camera and the target, not a measurement of the design, and
    // a bare millimetre figure under a filename reads as the latter.
    `  minimum print width   ${describeWidth(report)}`,
    // What the verdict is made of, beside it. The line here before was a repetition figure
    // under a judgement it could not support: it fell as a design repeated, so a sheet of
    // sixteen identical postcards read "31%, which is normal" above "ready for press".
    `  recognised            ${describeRecognition(report)}`,
    `  verdict               ${report.pass ? "ready for press" : "not ready"}`,
  ];
  for (const reason of report.reasons) lines.push(`      ${reason}`);
  lines.push("");
  return lines;
}

export async function main(args: string[]): Promise<number> {
  // Help anywhere on the line, not only first: `taggant-compile art.png --help` was refused as an
  // unknown option, which is the one flag every command line is expected to know.
  if (args.length === 0 || args.includes("--help")) {
    const asked = args.includes("--help");
    (asked ? stdout : stderr).write(USAGE);
    return asked ? EXIT.ok : EXIT.usage;
  }

  const parsed = parseArguments(args);
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n${USAGE}`);
    return EXIT.usage;
  }
  const { source, id, scanDistanceMm, out } = parsed.arguments;

  let target: CompiledTarget;
  try {
    target = await compileTarget(await readFile(source), { id, scanDistanceMm });
  } catch (error) {
    // Everything reaching here is the input being unusable: a missing file, a directory,
    // artwork below the minimum size, a format that cannot be decoded. One line, then stop.
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.cannotRead;
  }

  stdout.write(`${formatReportLines(source, target).join("\n")}\n`);

  if (out !== undefined) {
    try {
      await writeTarget(out, JSON.stringify(toTargetJson(target)));
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT.cannotWrite;
    }
    stdout.write(`  written ${out}\n\n`);
  }
  return target.report.pass ? EXIT.ok : EXIT.artworkNotReady;
}

// argv[1] is a filesystem path, and on Windows it uses backslashes, so it has to be
// converted to a URL before it can be compared with import.meta.url.
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  // exitCode rather than exit(), so node finishes flushing stdout before it goes. On
  // Windows a write to a pipe is asynchronous, and exit() mid write truncates the report.
  main(argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

/** What the recogniser made of the artwork, in the sentence a printer can check. */
function describeRecognition(report: Report): string {
  const seen = report.recognition;
  if (seen === null) return "not asked, because the artwork did not get that far";
  if (report.pass) {
    return `at that size, every turn found it with ${seen.needed} or more points agreeing at ${seen.widthsAgreed} of ${seen.widths} widths, ${seen.inliers} at the middle one, and no look put it in the wrong place`;
  }
  return `at the size that came closest, every turn found it with ${seen.needed} or more points agreeing at ${seen.widthsAgreed} of ${seen.widths} widths, where most are needed${seen.misplaced > 0 ? `, and ${seen.misplaced} looks put it in the wrong place` : ""}`;
}

/**
 * Whether two paths name one file.
 *
 * Compared by what the filesystem says the file is, not by how it is spelled. Folding case was
 * not enough: the short name Windows keeps beside a long one, `ARTWOR~1.PNG`, and a junction to
 * the artwork's folder both named the artwork, and `--out` through either replaced it with the
 * target and printed "written".
 */
function samePath(a: string, b: string): boolean {
  try {
    const first = statSync(a);
    const second = statSync(b);
    if (first.ino !== 0 && first.dev === second.dev && first.ino === second.ino) return true;
  } catch {
    // One of the two does not exist, which a file about to be written usually does not: it
    // cannot be the artwork, unless the two spellings are of one path, which is checked below.
  }
  const caseFolds = process.platform === "win32" || process.platform === "darwin";
  const fold = (path: string) => (caseFolds ? canonical(path).toLowerCase() : canonical(path));
  return fold(a) === fold(b);
}

/** The path as the filesystem names it, through its folder when the file is not there yet. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/**
 * Write the target beside its destination and rename it into place.
 *
 * It was the one file in the repository written in place, and it is the one the console and
 * the bundler both read: a write interrupted part way left half a file under the right name,
 * which surfaced later as a JSON parse error with a byte offset and nothing about where it
 * came from.
 */
async function writeTarget(out: string, text: string): Promise<void> {
  const staging = `${out}.writing-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(staging, text);
    await rename(staging, out);
  } catch (error) {
    await rm(staging, { force: true });
    // Said about the file asked for, not the temporary one beside it: `--out` naming a folder
    // was answered with a sentence about `outdir.writing-79b82021`, a name nobody gave it.
    const code = (error as NodeJS.ErrnoException).code;
    const isFolder = await stat(out).then(
      (info) => info.isDirectory(),
      () => false,
    );
    throw new Error(
      isFolder
        ? `${out} is a folder; give --out the name of a file to write`
        : `${out} could not be written${code === undefined ? "" : ` (${code})`}`,
    );
  }
}

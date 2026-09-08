#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
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
  return {
    arguments: out === undefined ? { source, id, scanDistanceMm } : { source, id, scanDistanceMm, out },
  };
}

export function formatReportLines(source: string, target: CompiledTarget, scanDistanceMm: number): string[] {
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
    `  minimum print width   ${describeWidth(report, scanDistanceMm)}`,
    `  repeated detail       ${describeRepetition(report)}`,
    `  verdict               ${report.pass ? "ready for press" : "not ready"}`,
  ];
  for (const reason of report.reasons) lines.push(`      ${reason}`);
  lines.push("");
  return lines;
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help") {
    const asked = args[0] === "--help";
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

  stdout.write(`${formatReportLines(source, target, scanDistanceMm).join("\n")}\n`);

  if (out !== undefined) {
    try {
      await writeFile(out, JSON.stringify(toTargetJson(target)));
    } catch (error) {
      stderr.write(`could not write ${out}: ${error instanceof Error ? error.message : String(error)}\n`);
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

/** How much of the artwork looks like the rest of it, in words rather than a bare fraction. */
function describeRepetition(report: Report): string {
  if (report.repetition === null) return "not measured";
  const percent = Math.round(report.repetition * 100);
  if (percent <= 40) return `${percent}% of features have a look-alike, which is normal`;
  return `${percent}% of features have a look-alike elsewhere on the artwork`;
}

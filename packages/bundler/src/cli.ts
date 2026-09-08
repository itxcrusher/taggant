#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process, { argv, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { bundle } from "./bundle.js";

/** Exit codes, so a publish script can read the outcome instead of parsing stderr. */
export const EXIT = { ok: 0, usage: 1, cannotRead: 3, cannotWrite: 4 } as const;

const USAGE =
  "usage: taggant-bundle <manifest.json> --target <id>=<target.json> [--target ...] --out <folder>\n";

export interface Arguments {
  manifest: string;
  targets: Array<[string, string]>;
  out: string;
}

/**
 * Read the arguments, refusing anything ambiguous rather than guessing.
 *
 * `--target` is repeated once per target, and each one has to say which target id it is
 * for, because a bundle whose targets are matched by position would break the moment
 * someone reordered a manifest.
 */
export function parseArguments(args: string[]): { arguments: Arguments } | { error: string } {
  const targets: Array<[string, string]> = [];
  let manifest: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--target" || arg === "--out") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      i++;
      if (arg === "--out") {
        if (out !== undefined) return { error: "--out was given more than once" };
        out = value;
        continue;
      }
      const split = value.indexOf("=");
      if (split < 1) return { error: `--target must be written as <id>=<file>, and this is ${value}` };
      const id = value.slice(0, split);
      if (targets.some(([existing]) => existing === id)) return { error: `--target ${id} was given twice` };
      targets.push([id, value.slice(split + 1)]);
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    if (manifest !== undefined) return { error: `only one manifest can be bundled, and ${arg} is a second` };
    manifest = arg;
  }

  if (manifest === undefined) return { error: "no manifest was given" };
  if (out === undefined) return { error: "--out is required, so nothing is written by accident" };
  if (targets.length === 0) return { error: "at least one --target is required" };
  return { arguments: { manifest, targets, out } };
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help") {
    stdout.write(USAGE);
    return args.length === 0 ? EXIT.usage : EXIT.ok;
  }

  const parsed = parseArguments(args);
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n${USAGE}`);
    return EXIT.usage;
  }

  const { manifest: manifestPath, targets, out } = parsed.arguments;
  let manifest: unknown;
  const compiled: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const [id, file] of targets) compiled[id] = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.cannotRead;
  }

  try {
    const result = await bundle({
      manifest,
      targets: compiled,
      // Paths in a manifest are relative to the manifest, which is where an author
      // naturally puts the files beside it.
      sourceDir: dirname(resolve(manifestPath)),
      outDir: out,
    });
    stdout.write(`\n  ${result.files.length} files written to ${result.outDir}\n`);
    for (const asset of result.assets) {
      stdout.write(`  ${asset.from} -> ${asset.to} (${asset.bytes} bytes)\n`);
    }
    stdout.write("\n  Serve that folder over HTTPS or from localhost. It needs nothing else.\n\n");
    return EXIT.ok;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.cannotWrite;
  }
}

const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main(argv.slice(2)).then((code) => {
    // Set rather than called, so anything still buffered on stdout is written first.
    process.exitCode = code;
  });
}

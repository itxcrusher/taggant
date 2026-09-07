#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { argv, exit, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { type CompiledTarget, compileTarget } from "./compile.js";

export function formatReportLines(source: string, target: CompiledTarget): string[] {
  const { report } = target;
  const lines = [
    "",
    `  ${basename(source)}`,
    `  size                  ${target.width} x ${target.height} px`,
    `  tracking quality      ${report.score} / 100`,
    `  features              ${report.featureCount}, covering ${Math.round(report.coverage * 100)}% of the artwork`,
    `  minimum print width   ${report.minimumWidthMm} mm`,
    `  verdict               ${report.pass ? "ready for press" : "not ready"}`,
  ];
  for (const reason of report.reasons) lines.push(`      ${reason}`);
  lines.push("");
  return lines;
}

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const source = argv[0];
  if (!source || source === "--help") {
    stdout.write("usage: taggant-compile <artwork> [--id <id>] [--scan-distance <mm>] [--out <file>]\n");
    return source ? 0 : 1;
  }
  const id =
    readOption(argv, "--id") ??
    basename(source)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
  const scanDistanceMm = Number(readOption(argv, "--scan-distance") ?? 400);
  const target = await compileTarget(await readFile(source), { id, scanDistanceMm });
  stdout.write(`${formatReportLines(source, target).join("\n")}\n`);
  const out = readOption(argv, "--out");
  if (out) {
    await writeFile(out, JSON.stringify(target));
    stdout.write(`  written ${out}\n\n`);
  }
  return target.report.pass ? 0 : 2;
}

// argv[1] is a filesystem path, and on Windows it uses backslashes, so it has to be
// converted to a URL before it can be compared with import.meta.url.
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main(argv.slice(2)).then((code) => exit(code));
}

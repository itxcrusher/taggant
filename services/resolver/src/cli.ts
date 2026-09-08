#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process, { argv, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { parseTable } from "./links.js";
import { createResolver } from "./server.js";

export const EXIT = { ok: 0, usage: 1, cannotRead: 3 } as const;

const USAGE = "usage: taggant-resolver <links.json> [--port <n>] [--origin <url>]\n";

export interface Arguments {
  table: string;
  port: number;
  origin?: string;
}

export function parseArguments(args: string[]): { arguments: Arguments } | { error: string } {
  let table: string | undefined;
  let port = 8080;
  let origin: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--port" || arg === "--origin") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      i++;
      if (arg === "--origin") {
        origin = value;
        continue;
      }
      if (!/^\d+$/.test(value)) return { error: `--port must be a number, and this is ${value}` };
      port = Number(value);
      if (port < 1 || port > 65535)
        return { error: `--port must be between 1 and 65535, and this is ${port}` };
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    if (table !== undefined) return { error: `only one link table can be served, and ${arg} is a second` };
    table = arg;
  }

  if (table === undefined) return { error: "no link table was given" };
  return { arguments: origin === undefined ? { table, port } : { table, port, origin } };
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

  const { table: path, port, origin } = parsed.arguments;
  let table: ReturnType<typeof parseTable>;
  try {
    table = parseTable(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.cannotRead;
  }

  const server = createResolver(origin === undefined ? { table } : { table, origin });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const count = Object.values(table.entries).reduce((total, links) => total + links.length, 0);
  stdout.write(
    `\n  resolving ${count} links across ${Object.keys(table.entries).length} identifiers on port ${port}\n`,
  );
  stdout.write("  description at /.well-known/gs1resolver\n\n");
  return EXIT.ok;
}

const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main(argv.slice(2)).then((code) => {
    if (code !== EXIT.ok) process.exitCode = code;
  });
}

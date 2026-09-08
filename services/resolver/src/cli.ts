#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process, { argv, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { parseTable } from "./links.js";
import { createResolver } from "./server.js";
import { watchTable } from "./table-source.js";

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

  if (origin === undefined) {
    // The origin is the subject of every fact this resolver presents. With none set it is
    // taken from the Host header, which the caller controls, so a linkset can be anchored
    // wherever a stranger says. That is fine on a laptop and not fine on the internet.
    stderr.write(
      "no --origin given, so the subject of every answer comes from the Host header. Set it before this is reachable from anywhere.\n",
    );
  }
  // The table is mounted from outside the process and the operator is told to edit it, so
  // an edit has to take effect. Read once, editing it did nothing at all and readiness went
  // on reporting the count it had at boot, including after the file had been replaced with
  // something that was not JSON.
  let current = table;
  let stale: string | null = null;
  const reload = async (): Promise<void> => {
    try {
      current = parseTable(JSON.parse(await readFile(path, "utf8")));
      stale = null;
      stdout.write(`  reloaded ${Object.keys(current.entries).length} identifiers from ${path}\n`);
    } catch (error) {
      // The last table that worked keeps answering, because dropping every link because
      // somebody saved a file half written is worse than serving the previous one. But
      // readiness says so, so nothing goes on believing this process is fine.
      stale = `the table on disk could not be read: ${error instanceof Error ? error.message : String(error)}`;
      stderr.write(`${stale}\n`);
    }
  };

  // Not a watch on the file. A watch dies when the file is replaced by a rename, which is
  // how anything that writes safely writes, and a bind mount often delivers no events at
  // all. Both were measured against this stack; the reasoning is in `table-source.ts`.
  await watchTable(path, { onChange: reload });

  const server = createResolver({
    table: () => current,
    staleReason: () => stale,
    ...(origin === undefined ? {} : { origin }),
  });
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

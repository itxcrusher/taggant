#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process, { argv, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { parseTable } from "./links.js";
import { createResolver } from "./server.js";
import { stampFor, watchTable } from "./table-source.js";

export const EXIT = { ok: 0, usage: 1, cannotRead: 3, cannotListen: 4 } as const;

const USAGE = "usage: taggant-resolver <links.json> --origin <url> [--port <n>]\n";

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

  const { table: path, port } = parsed.arguments;
  let { origin } = parsed.arguments;

  // The origin ends up in a Link header and as a JSON-LD @id, and it was taken as written:
  // `--origin "not a url at all"` produced `Link: <not a url at all/01/...>`, which no
  // client can parse, and a trailing slash produced a doubled one in every subject. It is
  // the remedy the documents name for the two ways a request used to reach the subject, so
  // it is checked rather than trusted.
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      stderr.write(
        `--origin ${origin} is not a URL. It has to be the address this resolver is reached at, such as https://id.example.com\n`,
      );
      return EXIT.usage;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      stderr.write(`--origin ${origin} is not http or https\n`);
      return EXIT.usage;
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      stderr.write(`--origin ${origin} carries a query or a fragment, and a subject URL has neither\n`);
      return EXIT.usage;
    }
    // Normalised to no trailing slash, because every subject is built by appending a path
    // that starts with one.
    origin = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  }

  if (origin === undefined) {
    // Refused rather than warned about. The origin is the subject of every fact this
    // resolver presents, and with none set it used to come from the Host header, which is
    // written by whoever is asking: `Host: evil.example` published that host as the
    // identity of the operator's products. The warning this replaces was printed once at
    // start-up, into a log nobody reads at the moment it matters.
    stderr.write(
      "no --origin given. The origin is the subject of every answer this resolver gives, so it has to be the address this resolver is reached at: --origin https://id.example.com (or http://localhost:8080 while trying it out).\n",
    );
    return EXIT.usage;
  }

  // Stamped before it is read, so that a save between the two is a change the watch sees
  // rather than the state it starts from.
  const since = await stampFor(path);
  let table: ReturnType<typeof parseTable>;
  try {
    table = parseTable(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.cannotRead;
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
      stderr.write(`  reloaded ${Object.keys(current.entries).length} identifiers from ${path}\n`);
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
  await watchTable(path, { onChange: reload, since });

  const server = createResolver({
    table: () => current,
    staleReason: () => stale,
    origin,
  });
  // A listen that fails used to be an unhandled error event: a stack trace with absolute
  // internal paths, and exit 1, which is also the code for a usage error. The common case
  // is another resolver already on the port.
  const listening = await new Promise<string | null>((settle) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      settle(
        error.code === "EADDRINUSE"
          ? `port ${port} is already in use, so this resolver did not start. Something else is listening there; pass --port to use another.`
          : `this resolver could not listen on port ${port}: ${error.message}`,
      );
    });
    server.listen(port, () => settle(null));
  });
  if (listening !== null) {
    stderr.write(`${listening}\n`);
    return EXIT.cannotListen;
  }
  const count = Object.values(table.entries).reduce((total, links) => total + links.length, 0);
  // Standard error, not standard output. Standard output is the event stream, one JSON
  // object per line, and a collector reading it was handed a banner and a reload line to
  // choke on in the middle.
  stderr.write(
    `\n  resolving ${count} links across ${Object.keys(table.entries).length} identifiers on port ${port}\n`,
  );
  stderr.write("  description at /.well-known/gs1resolver\n\n");
  return EXIT.ok;
}

const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main(argv.slice(2)).then((code) => {
    if (code !== EXIT.ok) process.exitCode = code;
  });
}

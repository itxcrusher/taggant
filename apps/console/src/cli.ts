#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process, { argv, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { canonical } from "./in-turn.js";
import { claim } from "./one-console.js";
import { createConsole } from "./server.js";
import { createWorkspace } from "./workspace.js";

/**
 * Exit codes. `alreadyOpen` is another console holding what this one asked for; `cannotLock`
 * is a lock that could not be made at all, a folder that refuses new files or a file where a
 * folder should be. They were one code, so a permissions problem read as a second console.
 */
export const EXIT = { ok: 0, usage: 1, cannotListen: 4, alreadyOpen: 5, cannotLock: 6 } as const;

export const USAGE =
  "usage: taggant-console <workspace> [--port <n>] [--publish-to <dir>] [--links <file>] [--host <addr>] [--allow-host <name>] [--help]\n  --host       the address to listen on. 127.0.0.1 unless you say otherwise.\n  --allow-host a name this console will act on forms from, beyond the loopback ones.\n               Needed once --host is anything else: every page is readable from the\n               network immediately, and no form works until the name is named here.\n";

/**
 * Every flag that takes a value, in one list rather than in two.
 *
 * The usage line and the parser were separate lists, and `--allow-host` was in the parser
 * and in no document: it is the only way a console reached by any other name will act on
 * a form, so the operator who bound to an address and got a refusal had no route forward.
 * A test compares this against the usage text, so the next flag cannot be added silently.
 */
export const FLAGS = ["--port", "--publish-to", "--links", "--host", "--allow-host"] as const;

export interface Arguments {
  workspace: string;
  port: number;
  publishTo: string;
  links: string;
  host: string;
  /** Extra names it will answer forms on, beyond the loopback ones. */
  hosts: string[];
}

export function parseArguments(args: string[]): { arguments: Arguments } | { error: string } {
  let workspace: string | undefined;
  let port = 4000;
  let publishTo: string | undefined;
  let links: string | undefined;
  let host = "127.0.0.1";
  const hosts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if ((FLAGS as readonly string[]).includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      i++;
      if (arg === "--publish-to") publishTo = value;
      else if (arg === "--links") links = value;
      else if (arg === "--allow-host") hosts.push(value);
      else if (arg === "--host") host = value;
      else {
        if (!/^\d+$/.test(value)) return { error: `--port must be a number, and this is ${value}` };
        port = Number(value);
        if (port < 1 || port > 65535)
          return { error: `--port must be between 1 and 65535, and this is ${port}` };
      }
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    if (workspace !== undefined) {
      return { error: `only one workspace can be opened, and ${arg} is a second` };
    }
    workspace = arg;
  }

  if (workspace === undefined) return { error: "no workspace directory was given" };
  return {
    arguments: {
      workspace,
      port,
      host,
      hosts,
      publishTo: publishTo ?? resolve(workspace, "../bundles"),
      links: links ?? resolve(workspace, "../links.json"),
    },
  };
}

export async function main(args: string[]): Promise<number> {
  // Help anywhere on the line, as the compiler's command line takes it: only the first
  // position was looked at, so `taggant-console ./workspace --help` was refused as an unknown
  // option.
  if (args.length === 0 || args.includes("--help")) {
    stdout.write(USAGE);
    return args.length === 0 ? EXIT.usage : EXIT.ok;
  }
  const parsed = parseArguments(args);
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n${USAGE}`);
    return EXIT.usage;
  }

  const { port, host } = parsed.arguments;
  // A path that is a file rather than a directory is an ordinary mistake, and printing a
  // Node stack at somebody for it is not an answer.
  for (const [what, where] of [
    ["the workspace", parsed.arguments.workspace],
    ["the publish folder", parsed.arguments.publishTo],
  ] as const) {
    try {
      await mkdir(resolve(where), { recursive: true });
    } catch (error) {
      stderr.write(
        `${what} could not be opened at ${resolve(where)}: ${error instanceof Error ? error.message : String(error)}
`,
      );
      return EXIT.usage;
    }
  }
  // Each path as the filesystem names it, so one file reached two ways is one file to the
  // lock, to the queues and to the write that replaces it. Two consoles given `links.json`
  // and its short name `LINKS~1.JSO` both started, both operators were told their code
  // pointed somewhere, and the codes ended up in two files or the table vanished.
  const root = canonical(parsed.arguments.workspace);
  const publishTo = canonical(parsed.arguments.publishTo);
  const links = canonical(parsed.arguments.links);

  // One console per workspace and per link table, checked rather than asserted. Every
  // write here is atomic and queued behind the last, and none of that survives a second
  // console in another process: both read a file, both decide what the next version of it
  // is, and one of the two edits is gone with both operators told it was saved.
  const held = await claim(
    [
      { what: "workspace", path: root, kind: "directory" },
      { what: "link table", path: links, kind: "file" },
    ],
    {
      onLost: (sentence) => stderr.write(`\n  WARNING: ${sentence}\n`),
      onWait: (sentence) => stderr.write(`  ${sentence}\n`),
    },
  );
  if (!held.ok) {
    stderr.write(`${held.because}\n`);
    return held.heldByAnother ? EXIT.alreadyOpen : EXIT.cannotLock;
  }
  for (const note of held.notes) stderr.write(`  ${note}\n`);
  // An exit handler cannot await, and a signal does not run one at all unless it is
  // handled, so both paths are covered and the release itself is synchronous.
  process.on("exit", () => held.claim.release());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      held.claim.release();
      process.exit(EXIT.ok);
    });
  }

  // Every write asks the lock first. A console whose lock another console took over printed a
  // warning and went on writing, and the two consoles' edits were lost between them.
  const holds = (): string | null => held.claim.check();
  const workspace = createWorkspace(root, { holds });
  const server = createConsole({
    workspace,
    publishRoot: publishTo,
    linkTablePath: links,
    // Whatever name it is reached by, when that is not the loopback address. The console
    // will not act on a form posted to a name it does not know, because Host is written by
    // whoever is asking and everything same-origin means is compared against it.
    hosts: parsed.arguments.hosts,
    holdsTable: holds,
  });

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    // Everything this does, it does with the rights of whoever started it: it writes
    // files, reads artwork and runs a compiler. There is no login. Binding it anywhere
    // reachable is a decision, and it is not one to make by leaving a flag at its default.
    stderr.write(
      `\n  WARNING: binding to ${host}. This console has no authentication.\n  Anyone who can reach it can read every page: the workspace path, the list of experiences, and every verdict.\n  Forms are refused unless the name they were loaded from is passed with --allow-host, and anyone who is allowed can then write files and run the compiler as you.\n  Put it behind something, or bind it to 127.0.0.1.\n`,
    );
  }

  // A listen that fails was an unhandled error event: a stack trace with absolute
  // internal paths in it, and exit 1, which is also the code for a usage error. The
  // common case is another console already on the port, and it is one the person can act
  // on if they are told which port and which flag changes it.
  const listening = await new Promise<string | null>((settle) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      settle(
        error.code === "EADDRINUSE"
          ? `port ${port} is already in use, so this console did not start. Something else is listening there; pass --port to use another.`
          : error.code === "EADDRNOTAVAIL"
            ? `${host} is not an address on this machine, so this console did not start.`
            : `this console could not listen on ${host}:${port}: ${error.message}`,
      );
    });
    server.listen(port, host, () => settle(null));
  });
  if (listening !== null) {
    held.claim.release();
    stderr.write(`${listening}\n`);
    return EXIT.cannotListen;
  }
  const listed = await workspace.list();
  stdout.write(`\n  taggant console on http://${host === "::1" ? "[::1]" : host}:${port}\n`);
  stdout.write(
    `  workspace   ${workspace.root} (${listed.length} experience${listed.length === 1 ? "" : "s"})\n`,
  );
  stdout.write(`  publishing  ${publishTo}\n`);
  stdout.write(`  link table  ${links}\n\n`);
  return EXIT.ok;
}

/**
 * Whether this file is the program that was run, compared as the files the two paths name. As
 * text, a command line reached through a link did nothing at all and exited 0.
 */
function invokedDirectly(): boolean {
  if (argv[1] === undefined) return false;
  try {
    return realpathSync.native(argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(argv.slice(2)).then((code) => {
    if (code !== EXIT.ok) process.exitCode = code;
  });
}

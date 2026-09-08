#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process, { argv, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { createConsole } from "./server.js";
import { createWorkspace } from "./workspace.js";

export const EXIT = { ok: 0, usage: 1 } as const;

const USAGE =
  "usage: taggant-console <workspace> [--port <n>] [--publish-to <dir>] [--links <file>] [--host <addr>]\n";

export interface Arguments {
  workspace: string;
  port: number;
  publishTo: string;
  links: string;
  host: string;
}

export function parseArguments(args: string[]): { arguments: Arguments } | { error: string } {
  let workspace: string | undefined;
  let port = 4000;
  let publishTo: string | undefined;
  let links: string | undefined;
  let host = "127.0.0.1";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--port" || arg === "--publish-to" || arg === "--links" || arg === "--host") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      i++;
      if (arg === "--publish-to") publishTo = value;
      else if (arg === "--links") links = value;
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
      publishTo: publishTo ?? resolve(workspace, "../bundles"),
      links: links ?? resolve(workspace, "../links.json"),
    },
  };
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

  const { workspace: root, port, host, publishTo, links } = parsed.arguments;
  await mkdir(resolve(root), { recursive: true });
  await mkdir(resolve(publishTo), { recursive: true });

  const workspace = createWorkspace(root);
  const server = createConsole({
    workspace,
    publishRoot: resolve(publishTo),
    linkTablePath: resolve(links),
  });

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    // Everything this does, it does with the rights of whoever started it: it writes
    // files, reads artwork and runs a compiler. There is no login. Binding it anywhere
    // reachable is a decision, and it is not one to make by leaving a flag at its default.
    stderr.write(
      `\n  WARNING: binding to ${host}. This console has no authentication and anyone who can reach it can write files as you. Put it behind something, or bind it to 127.0.0.1.\n`,
    );
  }

  await new Promise<void>((ready) => server.listen(port, host, ready));
  const listed = await workspace.list();
  stdout.write(`\n  taggant console on http://${host === "::1" ? "[::1]" : host}:${port}\n`);
  stdout.write(
    `  workspace   ${workspace.root} (${listed.length} experience${listed.length === 1 ? "" : "s"})\n`,
  );
  stdout.write(`  publishing  ${resolve(publishTo)}\n`);
  stdout.write(`  link table  ${resolve(links)}\n\n`);
  return EXIT.ok;
}

const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main(argv.slice(2)).then((code) => {
    if (code !== EXIT.ok) process.exitCode = code;
  });
}

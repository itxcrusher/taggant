import { describe, expect, it } from "vitest";
import { EXIT, main, parseArguments } from "../src/cli.js";

/**
 * What the command line refuses, and why the origin is one of those things.
 *
 * The origin is the subject of every fact this resolver presents: the linkset anchor, all
 * three `Link` references, and `resolverRoot` in the description file. With none given it
 * used to be taken from the `Host` header, so a request could publish the identity of the
 * operator's products on a host of its own choosing, and the start-up warning about that
 * went into a log at the one moment nobody is reading one. It is required now, and checked,
 * because it is also the remedy the documents name.
 */
describe("the command line", () => {
  it("refuses to start without an origin, and says what one is for", async () => {
    const said: string[] = [];
    const code = await withStderr(said, () => main(["table.json"]));
    expect(code).toBe(EXIT.usage);
    expect(said.join("")).toMatch(/--origin/);
  });

  it("refuses an origin that is not a URL, or is not http, or carries a query", async () => {
    for (const origin of ["not a url at all", "ftp://id.example.com", "https://id.example.com?x=1"]) {
      const said: string[] = [];
      const code = await withStderr(said, () => main(["table.json", "--origin", origin]));
      expect(code, `${origin} was accepted`).toBe(EXIT.usage);
      expect(said.join(""), `${origin} was refused without saying why`).toMatch(/--origin/);
    }
  });

  it("takes the origin off the arguments before anything else looks at it", () => {
    const parsed = parseArguments(["table.json", "--origin", "https://id.example.com"]);
    expect("arguments" in parsed && parsed.arguments.origin).toBe("https://id.example.com");
  });
});

/** Capture what `main` writes to standard error, which is where it says why it refused. */
async function withStderr(into: string[], run: () => Promise<number>): Promise<number> {
  const stderr = await import("node:process").then((process) => process.stderr);
  const original = stderr.write.bind(stderr);
  stderr.write = ((chunk: unknown) => {
    into.push(String(chunk));
    return true;
  }) as typeof stderr.write;
  try {
    return await run();
  } finally {
    stderr.write = original;
  }
}

describe("the command line reached through a link", () => {
  it("runs, as it does when a package manager puts it on the path", async () => {
    // It compared argv[1] with its own module address as text, and through a link the first names
    // the link and the second the file, so it did nothing at all and exited 0. A package manager
    // puts a command line on the path through a link, and pnpm lays out a workspace with them.
    const { spawnSync } = await import("node:child_process");
    const { mkdtemp, rm, rmdir, symlink, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = await mkdtemp(join(tmpdir(), "linked-cli-"));
    const link = join(dir, "dist");
    await symlink(fileURLToPath(new URL("../dist", import.meta.url)), link, "junction");
    try {
      const run = spawnSync(process.execPath, [join(link, "cli.js"), "--help"], { encoding: "utf8" });
      expect(`${run.stdout}${run.stderr}`, "said nothing through the link").toContain("usage:");
      expect(run.status).toBe(0);
    } finally {
      // The link alone, never what it points at.
      await unlink(link).catch(() => rmdir(link));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

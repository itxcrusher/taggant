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

  it("refuses an origin that is not a URL, or is not http, or carries a query or a fragment", async () => {
    for (const origin of [
      "not a url at all",
      "ftp://id.example.com",
      "https://id.example.com?x=1",
      "https://id.example.com#x",
    ]) {
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
      // And named without its extension, which Node runs as the same file.
      const bare = spawnSync(process.execPath, [join(link, "cli"), "--help"], { encoding: "utf8" });
      expect(`${bare.stdout}${bare.stderr}`, "said nothing named without its extension").toContain("usage:");
    } finally {
      // The link alone, never what it points at.
      await unlink(link).catch(() => rmdir(link));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the command line, running", () => {
  it("writes nothing but scan events to standard output, and serves its origin without the slash", async () => {
    // Standard output is the event stream, one JSON object per line, and a collector reading it
    // was handed the start-up banner and every reload notice to choke on in the middle; they go
    // to standard error. The origin loses a trailing slash, because every subject is built by
    // appending a path that starts with one, and `--origin http://localhost:8080/` put two in each.
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "running-cli-"));
    const table = join(dir, "links.json");
    const links = (href: string) =>
      JSON.stringify({
        version: 1,
        entries: { "/01/09520123456788": [{ href, linkType: "gs1:pip", title: "T", default: true }] },
      });
    await writeFile(table, links("https://example.com/first"));
    const port = await freePort();
    const out: string[] = [];
    const err: string[] = [];
    let stop: (() => Promise<void>) | undefined;
    const restore = capture(out, err);
    try {
      const code = await main(
        [table, "--origin", "http://localhost:8080/", "--port", String(port)],
        (given) => {
          stop = given;
        },
      );
      expect(code, err.join("")).toBe(EXIT.ok);
      const at = `http://127.0.0.1:${port}`;
      const described = (await (await fetch(`${at}/.well-known/gs1resolver`)).json()) as {
        resolverRoot: string;
      };
      expect(described.resolverRoot).toBe("http://localhost:8080");
      expect((await fetch(`${at}/01/09520123456788`, { redirect: "manual" })).status).toBe(307);
      await writeFile(table, links("https://example.com/second"));
      expect(await until(() => err.join("").includes("reloaded")), "the edit was never picked up").toBe(true);
    } finally {
      restore();
      await stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
    expect(err.join("")).toMatch(/resolving 1 links/);
    const lines = out
      .join("")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines.length, `standard output held ${JSON.stringify(out)}`).toBe(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ type: "scan", outcome: "redirect" });
  });

  it("says in a sentence that its port is taken, with an exit code of its own", async () => {
    // A listen that failed was an unhandled error event: a stack trace with absolute internal
    // paths, and exit 1, which is also the code for a usage error. Another resolver already on
    // the port is the common case.
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { createServer } = await import("node:net");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "taken-port-"));
    const table = join(dir, "links.json");
    await writeFile(
      table,
      JSON.stringify({
        version: 1,
        entries: {
          "/01/09520123456788": [
            { href: "https://example.com/", linkType: "gs1:pip", title: "T", default: true },
          ],
        },
      }),
    );
    const blocker = createServer();
    const port = await new Promise<number>((resolve) =>
      blocker.listen(0, () => resolve((blocker.address() as { port: number }).port)),
    );
    const out: string[] = [];
    const err: string[] = [];
    const restore = capture(out, err);
    try {
      expect(await main([table, "--origin", "http://localhost:8080", "--port", String(port)])).toBe(
        EXIT.cannotListen,
      );
    } finally {
      restore();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
    expect(err.join("")).toContain(`port ${port} is already in use`);
    expect(out).toEqual([]);
  });
});

/** A port nothing is listening on, found by listening on one and letting it go. */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const probe = createServer();
  const port = await new Promise<number>((resolve) =>
    probe.listen(0, () => resolve((probe.address() as { port: number }).port)),
  );
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Take what is written to standard output and standard error until the returned function runs. */
function capture(out: string[], err: string[]): () => void {
  const writes = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return () => {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
  };
}

/** Wait for a condition rather than for a duration, so this is not a race. */
async function until(condition: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

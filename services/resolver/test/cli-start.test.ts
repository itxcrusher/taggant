/**
 * A table saved while the command line was starting.
 *
 * The command line stamps the table, reads it, and then starts watching it. A save landing after
 * the read and before the watch began was the state the watch started from: the older table was
 * served, readiness said ready, and no later look at the file would ever have found it changed.
 * The moment lasts as long as the read, which is long for a large table, so here it is made to
 * happen every time: the read is wrapped, and the save is made as it returns.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  /** Runs as a read returns, and may change what is on disk first. */
  afterRead: null as null | ((path: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const read = await actual.readFile(...args);
      await hooks.afterRead?.(String(args[0]));
      return read;
    },
  };
});

const { EXIT, main } = await import("../src/cli.js");

describe("the command line, starting", () => {
  it("serves a table saved between its read at start-up and the watch on it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "start-save-"));
    const table = join(dir, "links.json");
    const links = (href: string) =>
      JSON.stringify({
        version: 1,
        entries: { "/01/09520123456788": [{ href, linkType: "gs1:pip", title: "T", default: true }] },
      });
    await writeFile(table, links("https://example.com/first"));
    hooks.afterRead = async (path) => {
      if (path !== table) return;
      hooks.afterRead = null;
      await writeFile(table, links("https://example.com/saved-while-starting"));
    };
    const port = await freePort();
    const restore = silence();
    let stop: (() => Promise<void>) | undefined;
    try {
      const code = await main(
        [table, "--origin", "http://localhost:8080", "--port", String(port)],
        (given) => {
          stop = given;
        },
      );
      expect(code).toBe(EXIT.ok);
      expect(hooks.afterRead, "the command line never read the table").toBeNull();
      const served = async () =>
        (await fetch(`http://127.0.0.1:${port}/01/09520123456788`, { redirect: "manual" })).headers.get(
          "location",
        );
      expect(
        await until(async () => (await served()) === "https://example.com/saved-while-starting"),
        "the table saved while it started was never served",
      ).toBe(true);
    } finally {
      restore();
      await stop?.();
      hooks.afterRead = null;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
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

/** Keep the command line's banner and events out of the test output, until the returned function runs. */
function silence(): () => void {
  const writes = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
  };
}

/** Wait for a condition rather than for a duration, so this is not a race. */
async function until(condition: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

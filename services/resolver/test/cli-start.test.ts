/**
 * The moments that last as long as a read of the table, made to happen every time.
 *
 * The command line stamps the table, reads it, and then starts watching it. A save landing after
 * the read and before the watch began was the state the watch started from: the older table was
 * served, readiness said ready, and no later look at the file would ever have found it changed.
 * And a reload reading the table when the command line stops, or when its port turns out to be
 * taken, is finished before either is over. Each moment lasts as long as the read, which is long
 * for a large table, so here the read is wrapped: a save is made as it returns, or it is held.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  /** Runs before a read begins, and may hold it. */
  beforeRead: null as null | ((path: string) => Promise<void>),
  /** Runs as a read returns, and may change what is on disk first. */
  afterRead: null as null | ((path: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await hooks.beforeRead?.(String(args[0]));
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

describe("the command line, ending", () => {
  const links = (href: string) =>
    JSON.stringify({
      version: 1,
      entries: { "/01/09520123456788": [{ href, linkType: "gs1:pip", title: "T", default: true }] },
    });

  /** Hold the next read of `table` until the returned release runs, and say when it began. */
  function holdNextRead(table: string): { began: () => boolean; release: () => void } {
    let begun = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.beforeRead = async (path) => {
      if (path !== table) return;
      hooks.beforeRead = null;
      begun = true;
      await held;
    };
    return { began: () => begun, release: () => release() };
  }

  it("does not say it has stopped while a reload is still reading the table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stop-reading-"));
    const table = join(dir, "links.json");
    await writeFile(table, links("https://example.com/first"));
    const port = await freePort();
    const err: string[] = [];
    const restore = silence(err);
    let stop: (() => Promise<void>) | undefined;
    let reload: ReturnType<typeof holdNextRead> = { began: () => false, release: () => undefined };
    try {
      const code = await main(
        [table, "--origin", "http://localhost:8080", "--port", String(port)],
        (given) => {
          stop = given;
        },
      );
      expect(code).toBe(EXIT.ok);
      reload = holdNextRead(table);
      await writeFile(table, links("https://example.com/second"));
      expect(await until(async () => reload.began()), "the save was never reloaded").toBe(true);
      let stopped = false;
      const stopping = stop?.().then(() => {
        stopped = true;
      });
      stop = undefined;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stopped, "the stop resolved while the reload was still reading").toBe(false);
      reload.release();
      await stopping;
      expect(err.join(""), "the stop resolved before the reload had finished").toMatch(
        /reloaded 1 identifiers/,
      );
    } finally {
      reload.release();
      restore();
      await stop?.();
      hooks.beforeRead = null;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  });

  it("does not return on a taken port while a reload is still reading the table", async () => {
    // The table is saved as the command line starts to listen, and the listen goes ahead only
    // once the reload that save begins is reading, so the port is found taken with the read in
    // flight.
    const { createServer } = await import("node:net");
    const { Server } = await import("node:http");
    const dir = await mkdtemp(join(tmpdir(), "taken-reading-"));
    const table = join(dir, "links.json");
    await writeFile(table, links("https://example.com/first"));
    const blocker = createServer();
    const port = await new Promise<number>((resolve) =>
      blocker.listen(0, () => resolve((blocker.address() as { port: number }).port)),
    );
    const err: string[] = [];
    const restore = silence(err);
    const listen = Server.prototype.listen;
    let reload: ReturnType<typeof holdNextRead> = { began: () => false, release: () => undefined };
    Server.prototype.listen = function (this: InstanceType<typeof Server>, ...args: unknown[]) {
      Server.prototype.listen = listen;
      reload = holdNextRead(table);
      void (async () => {
        await writeFile(table, links("https://example.com/second"));
        await until(async () => reload.began());
        listen.apply(this, args as Parameters<typeof listen>);
      })();
      return this;
    } as typeof listen;
    try {
      let returned = false;
      const ending = main([table, "--origin", "http://localhost:8080", "--port", String(port)]).then(
        (code) => {
          returned = true;
          return code;
        },
      );
      expect(await until(async () => reload.began()), "the save was never reloaded").toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(returned, "it returned while the reload was still reading").toBe(false);
      reload.release();
      expect(await ending).toBe(EXIT.cannotListen);
      expect(err.join(""), "it returned before the reload had finished").toMatch(/reloaded 1 identifiers/);
      expect(err.join("")).toMatch(/already in use/);
    } finally {
      Server.prototype.listen = listen;
      reload.release();
      restore();
      hooks.beforeRead = null;
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
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

/**
 * Keep the command line's banner and events out of the test output, until the returned function
 * runs, keeping what it writes to standard error in `err`.
 */
function silence(err: string[] = []): () => void {
  const writes = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (() => true) as typeof process.stdout.write;
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
async function until(condition: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

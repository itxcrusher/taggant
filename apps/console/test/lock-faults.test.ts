/**
 * The lock's answers to what another process does between two of its steps.
 *
 * These are moments a test cannot arrange with two real claimants, because they last
 * microseconds: a lock replaced between the look and the move that takes it away, and a name
 * Windows is part way through deleting. The filesystem's own calls are wrapped so the moment
 * happens every time, on every platform.
 */
import { utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  /** Runs before a rename, and may change what is on disk first. */
  rename: null as null | ((from: string, to: string) => Promise<void>),
  /** Returns an error code to fail an exclusive create of this path with, or null to let it be. */
  create: null as null | ((path: string) => string | null),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await hooks.rename?.(String(from), String(to));
      return actual.rename(from, to);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [path, , options] = args;
      const exclusive =
        typeof options === "object" && options !== null && (options as { flag?: string }).flag === "wx";
      const code = exclusive ? (hooks.create?.(String(path)) ?? null) : null;
      if (code !== null) {
        throw Object.assign(new Error(`${code}: refused for the test, open '${String(path)}'`), { code });
      }
      return actual.writeFile(...args);
    },
  };
});

const { STALE_AFTER_MS, claim, lockFor } = await import("../src/one-console.js");

const WORKSPACE = (path: string) => ({ what: "workspace", path, kind: "directory" as const });
const roots: string[] = [];

afterEach(async () => {
  hooks.rename = null;
  hooks.create = null;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function staleLock(): Promise<{ workspace: string; lock: string }> {
  const root = await mkdtemp(join(tmpdir(), "console-fault-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const lock = lockFor(WORKSPACE(workspace));
  await writeFile(lock, JSON.stringify({ pid: 1, host: "gone", nonce: "old" }));
  const longAgo = new Date(Date.now() - (STALE_AFTER_MS + 5_000));
  await utimes(lock, longAgo, longAgo);
  return { workspace, lock };
}

describe("taking over a lock", () => {
  it("puts back a lock replaced between the look and the move, and leaves it with its maker", async () => {
    // A takeover looks at the lock under its marker and then moves it aside. Another claimant
    // that replaced the lock in between, with a fresh one of its own, had that fresh lock removed
    // by name when removal was by name, and both then held the workspace. What was moved is read
    // before it is deleted, and a lock that is not the one judged goes back.
    const { workspace, lock } = await staleLock();
    const theirs = JSON.stringify({ pid: 7, host: "quick", nonce: "theirs" });
    hooks.rename = async (from) => {
      if (from !== lock) return;
      hooks.rename = null;
      await writeFile(lock, theirs);
    };
    const held = await claim([WORKSPACE(workspace)], { watchMs: 100 });
    expect(held.ok, "held a lock another console had just made").toBe(false);
    if (!held.ok) expect(held.heldByAnother).toBe(true);
    expect(await readFile(lock, "utf8")).toBe(theirs);
    expect((await readdir(workspace)).filter((name) => name.includes("removing"))).toEqual([]);
  });

  it("backs off a lock touched between the watch and the takeover", async () => {
    // The lock is looked at again under the marker, because its holder may have touched it at
    // the last moment: a console that resumed just then is running, and its lock is its own.
    const { workspace, lock } = await staleLock();
    hooks.create = (path) => {
      if (!path.includes(".taking-over-")) return null;
      hooks.create = null;
      const now = new Date();
      utimesSync(lock, now, now);
      return null;
    };
    const held = await claim([WORKSPACE(workspace)], { watchMs: 100 });
    expect(held.ok, "took a lock its holder had just touched").toBe(false);
    if (!held.ok) expect(held.heldByAnother).toBe(true);
    expect(JSON.parse(await readFile(lock, "utf8")).nonce).toBe("old");
  });

  it("steps back when another claimant makes the next marker first, and leaves that marker alone", async () => {
    // Two claimants can both list the folder before either makes the next numbered marker, and
    // one exclusive create wins. The other holds no marker, so it steps back as another console
    // taking over. Carried on, it took the lock with nobody's marker and finished by clearing
    // every marker for that lock, the winner's included, while the winner was using it.
    const { workspace, lock } = await staleLock();
    let theirs = "";
    hooks.create = (path) => {
      if (!path.includes(".taking-over-")) return null;
      hooks.create = null;
      theirs = path;
      writeFileSync(path, "another claimant, a moment earlier");
      return null;
    };
    const held = await claim([WORKSPACE(workspace)], { watchMs: 100 });
    expect(theirs, "the claim never reached a marker").not.toBe("");
    expect(held.ok, "took the lock without holding a marker").toBe(false);
    if (!held.ok) {
      expect(held.heldByAnother).toBe(true);
      expect(held.because).toContain("at this moment");
    }
    expect(await readdir(workspace)).toContain(basename(theirs));
    expect(JSON.parse(await readFile(lock, "utf8")).nonce).toBe("old");
  });

  it("waits out a name that is being deleted, rather than calling the folder unwritable", async () => {
    // On Windows a name whose file is part way through being deleted refuses a new file with
    // EPERM for a moment. A claim landing there exited with the code for a lock that cannot be
    // made, which sends the operator to look at permissions.
    const root = await mkdtemp(join(tmpdir(), "console-fault-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const lock = lockFor(WORKSPACE(workspace));
    let refused = 0;
    hooks.create = (path) => (path === lock && refused++ < 3 ? "EPERM" : null);
    const held = await claim([WORKSPACE(workspace)]);
    expect(held.ok, held.ok ? "" : held.because).toBe(true);
    expect(refused).toBeGreaterThanOrEqual(3);
    if (held.ok) held.claim.release();
  });

  it("tells a name that stays busy from a folder that refuses every file", async () => {
    const root = await mkdtemp(join(tmpdir(), "console-fault-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const lock = lockFor(WORKSPACE(workspace));

    // Only the lock's own name refused: the folder takes other files, so something holds that
    // name, which is another console's business and exit 5.
    hooks.create = (path) => (path === lock ? "EPERM" : null);
    const busy = await claim([WORKSPACE(workspace)]);
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.heldByAnother, busy.because).toBe(true);

    // Every name in the folder refused: the folder does not take files, which is exit 6.
    hooks.create = (path) => (path.startsWith(workspace) ? "EPERM" : null);
    const refused = await claim([WORKSPACE(workspace)]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.heldByAnother, refused.because).toBe(false);
      expect(refused.because).toContain("could not be locked");
    }
  });
});

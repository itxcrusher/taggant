/**
 * One console at a time on a workspace and on a link table.
 *
 * Every write this console makes is atomic and every write to one resource is queued
 * behind the last, so nothing here can leave a half-written file. What none of that
 * survives is a second console in another process: each one reads a file, decides what the
 * next version of it is, and writes that version, and the queue that orders those steps
 * lives inside one process. Two consoles open on one workspace can therefore lose an edit
 * outright, with both operators told their edit was saved. The files stay readable, which
 * is the thing that makes it hard to notice.
 *
 * So the arrangement is one console per resource, and this is what notices when it is not:
 * a lock file per resource, which the console holding it touches every few seconds for as
 * long as it runs. A lock touched recently belongs to a running console and is refused; a
 * lock nobody has touched for longer than the stale interval was left by a console that is
 * not running, and is taken over with the takeover printed.
 *
 * The publish folder has no lock, and that is deliberate rather than an omission: the static
 * host serves everything in it, so a lock file there is a file anyone can download. What
 * protects a published experience is the bundler's swap, which replaces it by renames and
 * leaves it whole whichever of two publishes finishes first.
 *
 * **It used to ask whether the process the lock named was alive**, and three things were
 * wrong with that, all found by an adversarial pass. A process id means nothing off the
 * machine that wrote it, so a lock from a container that no longer exists was refused for
 * ever with a sentence naming a file to delete. Inside a container the console is process 1
 * every time, so a container restarted after an unclean stop found a lock naming its own
 * pid, asked whether process 1 was alive, got yes from itself, and refused to start on every
 * restart. And a Windows machine and a WSL distribution on it report one hostname with two
 * process tables, so a lock from one was checked against the other's processes. A heartbeat
 * asks the only question that matters, whether the holder is still running, and asks it the
 * same way on every machine that can see the file.
 *
 * **Two consoles starting at the same instant** were able to both believe they held it: the
 * lock was created empty and then written, and a second claimant reading the empty file in
 * between took it for a lock that named nobody. A fresh file is now held whatever is in it,
 * and every claim is confirmed by reading the lock back after a moment: it carries a value
 * only this claim knows, and a claim that reads back somebody else's has lost and says so.
 *
 * **Two consoles taking over one stale lock** were the race after that, and the read-back
 * did not close it. Each one looked at the lock's age and then at what it held, as two
 * steps, and removed it by name: between the two looks the other could replace the stale
 * lock with its own fresh one, so the age read was the old file's and the removal took the
 * new file. Driven as two processes started in the same millisecond, sixty rounds, one round
 * ended with both holding the workspace, because the removal came after the first had
 * already confirmed. Now the age and the contents come from one open file, and a takeover
 * happens only while holding a second file that one claimant at a time can create, inside
 * which the stale lock is looked at again before it is removed.
 *
 * The command line is what claims these, not `createConsole`. A server handed a workspace
 * object is a library call, and taking a lock underneath one would be a surprise: the tests
 * stand several consoles up at once on purpose. Anything embedding the server can call
 * `claim` itself, which is why it is exported from the package.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

/** A resource that may only have one console on it, and where its lock file goes. */
export interface Exclusive {
  /** Named the way the refusal will read: "workspace", "link table". */
  what: string;
  /** The path being protected. */
  path: string;
  /**
   * Whether the path is a directory or a file, which decides where the lock goes.
   *
   * A directory holds its own lock and a file has one beside it, and the reason is the
   * container rather than the lock. In the compose stack the workspace is a bind mount under
   * a read-only root: `/srv/workspace` is writable and `/srv/workspace.console-lock` is not,
   * so a lock beside the directory made the console refuse to start in its own stack. A
   * file's lock beside it is inside the same mount, which is why that one stays where it was.
   */
  kind: "directory" | "file";
}

export interface Claim {
  /**
   * Stop touching the locks and give up every one still carrying this claim's value.
   *
   * Synchronous because the last place it runs is an exit handler, where a promise is never
   * awaited and the work is silently dropped.
   */
  release(): void;
}

export interface ClaimOptions {
  /** How often a held lock is touched. */
  heartbeatMs?: number;
  /** How long since the last touch before a lock counts as left behind. */
  staleAfterMs?: number;
  /** How long to wait before reading a fresh lock back to confirm it. */
  settleMs?: number;
  /**
   * Called once if a held lock stops carrying this claim's value, which means another
   * console took it over. The command line prints it; nothing else here can act on it.
   */
  onLost?: (sentence: string) => void;
}

/**
 * Touched every five seconds, and left behind once twenty have passed with no touch.
 *
 * Twenty rather than ten, because the time compared is the file's modification time against
 * this machine's clock, and a lock on a mount shared with a container or a network share can
 * be stamped by a clock a few seconds off. Four missed touches is not a pause.
 */
export const HEARTBEAT_MS = 5_000;
export const STALE_AFTER_MS = 20_000;

/**
 * How long a takeover may hold its marker before the marker itself counts as left behind.
 *
 * A takeover is a look, a removal and a create, which is milliseconds. A marker older than
 * this was left by a console that stopped part way through one, and leaving it would refuse
 * every takeover of that lock for ever.
 */
const TAKEOVER_STALE_MS = 10_000;

/** Where the lock for a resource lives. */
export function lockFor(resource: Exclusive): string {
  return resource.kind === "directory"
    ? join(resource.path, ".console-lock")
    : `${resource.path}.console-lock`;
}

interface Held {
  pid: number;
  host: string;
  since: string;
  what: string;
  /** A value only the claim that wrote this file knows, so it can tell its lock from a copy. */
  nonce: string;
}

/** Values this process holds right now. A lock naming this process with one of these is live. */
const holding = new Set<string>();

function parseHeld(text: string): Partial<Held> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<Held>) : null;
  } catch {
    return null;
  }
}

function describeHolder(held: Partial<Held> | null): string {
  if (held === null || typeof held.pid !== "number") return "a console that left no details";
  const where = typeof held.host === "string" && held.host !== "" ? ` on ${held.host}` : "";
  const since = typeof held.since === "string" ? `, since ${held.since}` : "";
  return `process ${held.pid}${where}${since}`;
}

/** What is at a lock's path, read through one open file so the age and the contents agree. */
type Seen =
  | { kind: "gone" }
  | { kind: "folder" }
  | { kind: "lock"; held: Partial<Held> | null; ageMs: number };

async function look(lock: string): Promise<Seen> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lock, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EISDIR") return { kind: "folder" };
    if (code === "ENOENT") return { kind: "gone" };
    // Windows refuses to open a file another process is deleting, with EPERM rather than
    // ENOENT, and that is gone too. A file that is there and cannot be read is not, and
    // calling it gone would retry until the attempts ran out and blame another console.
    if (code === "EPERM") {
      const there = await stat(lock).then(
        () => true,
        () => false,
      );
      if (!there) return { kind: "gone" };
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) return { kind: "folder" };
    const text = await handle.readFile("utf8");
    return { kind: "lock", held: parseHeld(text), ageMs: Date.now() - info.mtimeMs };
  } finally {
    await handle.close();
  }
}

type Refused = { ok: false; because: string; heldByAnother: boolean };

/**
 * Take a lock on each resource, or say which one could not be taken.
 *
 * Either every lock is held or none is: a console that claimed the workspace and then found
 * the link table taken must not leave the workspace looking occupied.
 */
export async function claim(
  resources: readonly Exclusive[],
  options: ClaimOptions = {},
): Promise<{ ok: true; claim: Claim; notes: string[] } | Refused> {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const settleMs = options.settleMs ?? 40;
  const nonce = randomBytes(12).toString("hex");
  // Registered before anything is created, so a second claim in this process reads this one's
  // lock as live rather than as left behind by an earlier run.
  holding.add(nonce);
  const taken: string[] = [];
  const notes: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let lostReported = false;

  const ours = (lock: string): boolean => {
    try {
      return parseHeld(readFileSync(lock, "utf8"))?.nonce === nonce;
    } catch {
      return false;
    }
  };
  const release = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    holding.delete(nonce);
    for (const lock of taken) {
      // Only ours. A lock another console has taken over is not this one's to delete.
      if (!ours(lock)) continue;
      try {
        unlinkSync(lock);
      } catch {
        // Nothing to do about a lock that cannot be removed, and an exit handler is not the
        // place to throw. It goes stale on its own once nobody touches it.
      }
    }
    taken.length = 0;
  };
  const refuse = (because: string, heldByAnother: boolean): Refused => {
    release();
    return { ok: false, because, heldByAnother };
  };
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const mine = (what: string): string =>
    `${JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString(), what, nonce }, null, 2)}\n`;

  /**
   * Whether a lock that is there belongs to a console that is running.
   *
   * A lock naming this very process and host, with a value this process is not holding, was
   * written by an earlier run of it. In a container the console is process 1 on every restart,
   * so that is the ordinary case after an unclean stop, not a coincidence.
   */
  const live = (seen: { held: Partial<Held> | null; ageMs: number }): boolean => {
    const earlierRunOfThis =
      seen.held?.pid === process.pid &&
      seen.held?.host === hostname() &&
      !holding.has(String(seen.held?.nonce));
    return seen.ageMs < staleAfterMs && !earlierRunOfThis;
  };

  /**
   * Remove a lock judged left behind and create this claim's, as one claimant at a time.
   *
   * Under a marker only one claimant can create, the lock is looked at again, and removed only
   * if it is still the one that was judged: the same value and still untouched. Anything else
   * means another claimant got there first, and that one is now the holder.
   */
  const takeOver = async (
    lock: string,
    judged: Partial<Held> | null,
    what: string,
  ): Promise<"ours" | "busy" | "changed" | Refused> => {
    const marker = `${lock}.taking-over`;
    try {
      await writeFile(marker, nonce, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return refuse(
          `the lock at ${lock} was left behind and could not be taken over: ${reason(error)}`,
          false,
        );
      }
      const left = await stat(marker).catch(() => null);
      if (left !== null && Date.now() - left.mtimeMs > TAKEOVER_STALE_MS) {
        await rm(marker, { force: true }).catch(() => undefined);
        return "changed";
      }
      return "busy";
    }
    try {
      const again = await look(lock);
      if (again.kind === "folder") return "changed";
      if (again.kind === "lock") {
        if (again.held?.nonce !== judged?.nonce || live(again)) return "changed";
        await rm(lock, { force: true });
      }
      try {
        await writeFile(lock, mine(what), { flag: "wx" });
        return "ours";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return "changed";
        throw error;
      }
    } finally {
      // Only our own marker. One left by a takeover that stopped part way is removed above.
      try {
        if (readFileSync(marker, "utf8") === nonce) unlinkSync(marker);
      } catch {
        // Already gone.
      }
    }
  };

  for (const resource of resources) {
    const lock = lockFor(resource);
    const folder = dirname(lock);
    try {
      await mkdir(folder, { recursive: true });
    } catch (error) {
      // A file where the folder should be arrives as EEXIST or ENOTDIR from mkdir, and was read
      // as a lock somebody held, with a sentence naming a lock file that could not exist.
      return refuse(
        `the ${resource.what} at ${resource.path} cannot be used, because ${folder} is not a folder that can be created or written: ${reason(error)}`,
        false,
      );
    }

    let created = false;
    for (let attempt = 0; attempt < 4 && !created; attempt++) {
      try {
        // Exclusive create, so of two claims at the same instant only one creates the file.
        await writeFile(lock, mine(resource.what), { flag: "wx" });
        created = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return refuse(
            `the ${resource.what} at ${resource.path} could not be locked, so this console will not open it: ${reason(error)}`,
            false,
          );
        }
      }
      let seen: Seen;
      try {
        seen = await look(lock);
      } catch (error) {
        return refuse(`the lock at ${lock} could not be read: ${reason(error)}`, false);
      }
      // Gone between the create and the look, which means another claim just released or
      // replaced it: try again.
      if (seen.kind === "gone") continue;
      if (seen.kind === "folder") {
        return refuse(
          `the ${resource.what} at ${resource.path} cannot be locked, because ${lock} is a folder. Nothing this console writes is a folder by that name; remove it and start again.`,
          false,
        );
      }
      if (live(seen)) {
        const seconds = Math.max(0, Math.round(seen.ageMs / 1000));
        return refuse(
          `another console is already open on the ${resource.what} at ${resource.path}: ${describeHolder(seen.held)}, last seen ${seconds} s ago. Two consoles on one ${resource.what} can lose an edit, and both operators are told it was saved. Close that one, or point this one somewhere else. If no console is running, ${lock} is taken over once ${Math.round(staleAfterMs / 1000)} s pass without a sign of life.`,
          true,
        );
      }
      let outcome: Awaited<ReturnType<typeof takeOver>>;
      try {
        outcome = await takeOver(lock, seen.held, resource.what);
      } catch (error) {
        return refuse(
          `the lock at ${lock} was left behind and could not be taken over: ${reason(error)}`,
          false,
        );
      }
      if (typeof outcome === "object") return outcome;
      if (outcome === "busy") {
        return refuse(
          `another console is starting on the ${resource.what} at ${resource.path} at this moment, and is taking over the lock an earlier one left. Only one of them can run.`,
          true,
        );
      }
      if (outcome === "ours") {
        const earlierRunOfThis = seen.held?.pid === process.pid && seen.held?.host === hostname();
        notes.push(
          earlierRunOfThis
            ? `took over ${lock}, left by an earlier run of this console`
            : `took over ${lock}, left by ${describeHolder(seen.held)}, untouched for ${Math.round(seen.ageMs / 1000)} s`,
        );
        created = true;
      }
      // "changed": another claimant moved first. Look again; it is now the one to refuse to.
    }
    if (!created) {
      return refuse(
        `the ${resource.what} at ${resource.path} could not be locked after four attempts.`,
        true,
      );
    }
    // Read back after a moment. A claim that wrote the file and then finds another claim's
    // value in it lost a race and must not go on as if it held it.
    await new Promise((settle) => setTimeout(settle, settleMs));
    if (ours(lock)) {
      taken.push(lock);
    } else {
      return refuse(
        `another console started on the ${resource.what} at ${resource.path} at the same moment and took it. Only one of them can run.`,
        true,
      );
    }
  }

  timer = setInterval(() => {
    for (const lock of taken) {
      if (ours(lock)) {
        try {
          const now = new Date();
          utimesSync(lock, now, now);
        } catch {
          // Missed once; the stale interval allows for several.
        }
        continue;
      }
      if (!lostReported) {
        lostReported = true;
        let holder = "another console";
        try {
          holder = describeHolder(parseHeld(readFileSync(lock, "utf8")));
          statSync(lock);
        } catch {
          holder = "nobody, because the lock file is gone";
        }
        options.onLost?.(
          `this console no longer holds ${lock}: it is held by ${holder}. Another console may be editing the same files; stop one of them.`,
        );
      }
    }
  }, heartbeatMs);
  // The touches must not keep a process alive that has nothing else to do.
  timer.unref();
  return { ok: true, claim: { release }, notes };
}

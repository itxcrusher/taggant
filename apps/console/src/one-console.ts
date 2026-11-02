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
 * long as it runs, and checks before every write it makes.
 *
 * The publish folder has no lock, and that is deliberate rather than an omission: the static
 * host serves everything in it, so a lock file there is a file anyone can download. What
 * protects a published experience is the bundler's swap, which replaces it by renames and
 * leaves it whole whichever of two publishes finishes first.
 *
 * **When a lock is taken over.** A lock is evidence of a console, and how good the evidence is
 * depends on where the console was:
 *
 * - On this machine, the process it names is asked whether it is running. If it is, the lock is
 *   its own whatever its age: a console stopped with Ctrl+Z, held by a debugger, or busy for
 *   twenty seconds in one synchronous step stops touching its lock without stopping being a
 *   console, and taking its lock while it went on writing lost sixteen codes of forty.
 * - A lock touched recently, by this machine's clock, is refused as a running console's.
 * - Anything else is watched for one heartbeat. A running console touches its lock whatever its
 *   clock says, so a lock that changes while it is watched is refused, and one that does not
 *   was left behind. Judged by the clock alone, a console on a mount shared with a machine whose
 *   clock ran thirty seconds behind had its lock taken while it ran.
 *
 * A lock naming this very process with a value it is not holding is an earlier run of it, which
 * is every container restarted after an unclean stop, or another process with the same id in
 * another namespace, which two containers on the host's network are. It is watched too, and
 * only the first is taken over.
 *
 * **Taking one over** happens under a marker that one claimant at a time can create, named for
 * the lock being taken over and numbered: a marker left by a takeover that stopped part way is
 * stepped past by creating the next number, never removed by name while anyone might be using
 * it. Removing an old marker by name let a claimant remove the fresh marker another had just
 * made, and then both were inside the takeover and both held the lock. Under its marker the lock
 * is looked at again, moved aside under a name only this claim knows, and deleted only if what
 * moved is what was judged.
 *
 * **A console that loses its lock** says so for every lock it loses, and refuses every write
 * after that: `check` is what the console's writes ask first. It used to say so once, for the
 * first lock, and go on writing.
 *
 * The command line is what claims these, not `createConsole`. A server handed a workspace
 * object is a library call, and taking a lock underneath one would be a surprise: the tests
 * stand several consoles up at once on purpose. Anything embedding the server can call
 * `claim` itself, which is why it is exported from the package.
 */
import { createHash, randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, utimesSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
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
  /**
   * Null while every lock is still this claim's; otherwise the sentence saying which is not and
   * who holds it. Asked before every write, so a console whose lock was taken writes nothing.
   */
  check(): string | null;
}

export interface ClaimOptions {
  /** How often a held lock is touched. */
  heartbeatMs?: number;
  /** How long since the last touch, by this machine's clock, before a lock is watched. */
  staleAfterMs?: number;
  /** How long a lock that looks left behind is watched for a touch before it is taken over. */
  watchMs?: number;
  /** How long to wait before reading a fresh lock back to confirm it. */
  settleMs?: number;
  /**
   * Called once for each held lock that stops carrying this claim's value, which means another
   * console took it over. The command line prints it.
   */
  onLost?: (sentence: string) => void;
  /** Called before a lock is watched, since watching makes a start take seconds. */
  onWait?: (sentence: string) => void;
}

/**
 * Touched every five seconds, and watched once twenty have passed with no touch.
 *
 * Twenty rather than ten, because the time compared is the file's modification time against
 * this machine's clock, and a lock on a mount shared with a container or a network share can
 * be stamped by a clock a few seconds off. Four missed touches is not a pause.
 */
export const HEARTBEAT_MS = 5_000;
export const STALE_AFTER_MS = 20_000;

/** Watched for a heartbeat and a half, so a running holder touches it at least once. */
export const WATCH_MS = 7_500;

/**
 * How long a takeover may hold its marker before the marker itself counts as left behind.
 *
 * A takeover is a look, a move and a create, which is milliseconds. A marker older than this
 * was left by a console that stopped part way through one, and the next number is taken.
 */
const TAKEOVER_STALE_MS = 10_000;

/** Where the lock for a resource lives. */
export function lockFor(resource: Exclusive): string {
  return resource.kind === "directory"
    ? join(resource.path, ".console-lock")
    : `${resource.path}.console-lock`;
}

/**
 * The start of the name every takeover marker for this lock, as it read, takes: the lock's own
 * name, then a digest of exactly what it held, then the attempt's number. A lock rewritten by
 * anyone holds something else, so its takeover is a different set of markers.
 */
export function markerPrefix(lock: string, held: string): string {
  const digest = createHash("sha256").update(held, "utf8").digest("hex").slice(0, 16);
  return `${basename(lock)}.taking-over-${digest}-`;
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

/** Whether a process with this id is running on this machine. */
function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Running, and not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What is at a lock's path, read through one open file so the age and the contents agree. */
type Seen =
  | { kind: "gone" }
  | { kind: "folder" }
  | { kind: "lock"; text: string; held: Partial<Held> | null; ageMs: number; mtimeMs: number };

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
    return {
      kind: "lock",
      text,
      held: parseHeld(text),
      ageMs: Date.now() - info.mtimeMs,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Create a file only if nothing is at its name.
 *
 * On Windows a name whose file is being deleted refuses a new file with EPERM until the delete
 * completes, which is a moment, and a claim racing another's takeover lands there: it exited
 * with the code for a lock that cannot be made, sending the operator to look at permissions. So
 * EPERM is waited out, and if it stays, a file of another name in the same folder tells a folder
 * that refuses files from a name that is busy.
 */
async function createOnly(path: string, contents: string): Promise<"made" | "taken" | Error> {
  let refusal: Error | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await writeFile(path, contents, { flag: "wx" });
      return "made";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "taken";
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") return error as Error;
      refusal = error as Error;
      await new Promise((settle) => setTimeout(settle, 15 * (attempt + 1)));
    }
  }
  const probe = `${path}.probe-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(probe, "", { flag: "wx" });
    await unlink(probe).catch(() => undefined);
    return "taken";
  } catch {
    return refusal ?? new Error(`${path} could not be created`);
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
  const watchMs = options.watchMs ?? WATCH_MS;
  const settleMs = options.settleMs ?? 40;
  const nonce = randomBytes(12).toString("hex");
  // Registered before anything is created, so a second claim in this process reads this one's
  // lock as live rather than as left behind by an earlier run.
  holding.add(nonce);
  const taken: string[] = [];
  const lost = new Map<string, string>();
  const notes: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

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
      // Only ours, and checked after it has been moved out of the way rather than before it is
      // deleted by name: a lock taken over between the check and the delete was another
      // console's, and deleting it by name is how one console removes another's.
      const away = `${lock}.releasing-${nonce}`;
      try {
        renameSync(lock, away);
      } catch {
        // Gone, or held open; either way not something an exit handler can wait on. A lock left
        // here is watched and taken over by the next console.
        continue;
      }
      try {
        if (parseHeld(readFileSync(away, "utf8"))?.nonce === nonce) {
          unlinkSync(away);
        } else {
          putBack(away, lock);
        }
      } catch {
        // Nothing to do in an exit handler about a file that cannot be read or removed.
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
   * Watch a lock for a heartbeat: `touched` when its holder touches it, `changed` when it is
   * replaced or removed while watched, `untouched` when nothing happens to it for `watchMs`.
   */
  const watch = async (
    lock: string,
    judged: Extract<Seen, { kind: "lock" }>,
  ): Promise<"touched" | "changed" | "untouched"> => {
    const until = Date.now() + watchMs;
    while (Date.now() < until) {
      await new Promise((settle) => setTimeout(settle, Math.min(250, Math.max(10, until - Date.now()))));
      const now = await look(lock).catch(() => ({ kind: "gone" }) as const);
      if (now.kind !== "lock" || now.text !== judged.text) return "changed";
      if (now.mtimeMs !== judged.mtimeMs) return "touched";
    }
    return "untouched";
  };

  /** Whether the console a lock names is running, and why, as the refusal will say it. */
  const judge = async (
    lock: string,
    what: string,
    seen: Extract<Seen, { kind: "lock" }>,
  ): Promise<{ live: false } | { live: true; because: string } | { changed: true }> => {
    const held = seen.held;
    const here = held?.host === hostname();
    const seconds = Math.max(0, Math.round(seen.ageMs / 1000));
    const holder = describeHolder(held);
    if (here && held?.pid === process.pid) {
      // This very process: either a claim it is making now, or an earlier run or a namespace
      // twin, which only a heartbeat tells apart.
      if (holding.has(String(held?.nonce))) {
        return {
          live: true,
          because: `${holder}, which is this console starting on it a second time; the lock is ${lock}`,
        };
      }
    } else if (seen.ageMs < staleAfterMs) {
      // Fresh first, so a console that is simply running is described as one.
      return {
        live: true,
        because: `${holder}, last seen ${seconds} s ago. If no console is running, ${lock} is taken over once ${Math.round(staleAfterMs / 1000)} s pass without a sign of life`,
      };
    } else if (here && typeof held?.pid === "number" && running(held.pid)) {
      return {
        live: true,
        because: `${holder}, which is running on this machine and last touched the lock ${seconds} s ago. A console that is paused, held by a debugger or busy stops touching its lock without stopping; if process ${held.pid} is not a console, remove ${lock} and start again`,
      };
    }
    options.onWait?.(
      `the ${what}'s lock at ${lock} names ${holder}, untouched for ${seconds} s; watching it for ${Math.round(watchMs / 1000)} s to see whether that console is still running`,
    );
    const watched = await watch(lock, seen);
    if (watched === "changed") return { changed: true };
    if (watched === "touched") {
      return {
        live: true,
        because: `${holder}, which touched the lock at ${lock} while this console watched it, so it is running, whatever its clock says`,
      };
    }
    return { live: false };
  };

  /**
   * Remove a lock judged left behind and create this claim's, as one claimant at a time.
   *
   * Under a marker only one claimant can create, the lock is looked at again, moved aside under a
   * name only this claim knows, and deleted only if what moved is still exactly what was judged.
   * Anything else means another claimant got there first, and that one is now the holder.
   */
  const takeOver = async (
    lock: string,
    judged: Extract<Seen, { kind: "lock" }>,
    what: string,
  ): Promise<"ours" | "busy" | "changed" | Refused> => {
    const folder = dirname(lock);
    const prefix = markerPrefix(lock, judged.text);
    const numbers = (await readdir(folder))
      .filter((name) => name.startsWith(prefix))
      .map((name) => Number(name.slice(prefix.length)))
      .filter((number) => Number.isInteger(number) && number > 0);
    const last = numbers.length === 0 ? 0 : Math.max(...numbers);
    if (last > 0) {
      const left = await stat(join(folder, `${prefix}${last}`)).catch(() => null);
      // Fresh: another console is taking this lock over now. Gone between the listing and here:
      // that takeover finished, so the lock is not what was judged any more.
      if (left === null) return "changed";
      if (Date.now() - left.mtimeMs <= TAKEOVER_STALE_MS) return "busy";
    }
    const marker = join(folder, `${prefix}${last + 1}`);
    const made = await createOnly(marker, nonce);
    if (made === "taken") return "busy";
    if (made instanceof Error) {
      return refuse(
        `the lock at ${lock} was left behind and could not be taken over: ${reason(made)}`,
        false,
      );
    }

    let outcome: "ours" | "changed" = "changed";
    let judgedGone = false;
    try {
      const again = await look(lock);
      if (again.kind === "folder") return "changed";
      if (again.kind === "lock") {
        if (again.text !== judged.text || again.mtimeMs !== judged.mtimeMs) return "changed";
        const away = `${lock}.removing-${nonce}`;
        await moveAside(lock, away);
        const moved = await readFile(away, "utf8").catch(() => null);
        if (moved !== null && moved !== judged.text) {
          // Not the lock that was judged: another claimant replaced it between the look and the
          // move. It goes back, and that claimant holds it.
          putBack(away, lock);
          return "changed";
        }
        if (moved !== null) await unlink(away).catch(() => undefined);
      }
      judgedGone = true;
      const created = await createOnly(lock, mine(what));
      if (created instanceof Error) throw created;
      outcome = created === "made" ? "ours" : "changed";
      return outcome;
    } finally {
      // Once the lock that was judged is gone, nobody will take it over again, and every marker
      // made for it is litter: removed, whoever made it. Until then only this claim's own goes.
      await clearMarkers(folder, prefix, judgedGone ? null : nonce);
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
      // Exclusive create, so of two claims at the same instant only one creates the file.
      const made = await createOnly(lock, mine(resource.what));
      if (made === "made") {
        created = true;
        break;
      }
      if (made instanceof Error) {
        return refuse(
          `the ${resource.what} at ${resource.path} could not be locked, so this console will not open it: ${reason(made)}`,
          false,
        );
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
      const verdict = await judge(lock, resource.what, seen);
      if ("changed" in verdict) continue;
      if (verdict.live) {
        return refuse(
          `another console is already open on the ${resource.what} at ${resource.path}: ${verdict.because}. Two consoles on one ${resource.what} can lose an edit, and both operators are told it was saved. Close that one, or point this one somewhere else.`,
          true,
        );
      }
      let outcome: Awaited<ReturnType<typeof takeOver>>;
      try {
        outcome = await takeOver(lock, seen, resource.what);
      } catch (error) {
        return refuse(
          `the lock at ${lock} was left behind and could not be taken over: ${reason(error)}`,
          false,
        );
      }
      if (typeof outcome === "object") return outcome;
      if (outcome === "busy") {
        return refuse(
          `another console is starting on the ${resource.what} at ${resource.path} at this moment, and is taking over the lock at ${lock} that an earlier one left. Only one of them can run.`,
          true,
        );
      }
      if (outcome === "ours") {
        const earlierRunOfThis = seen.held?.pid === process.pid && seen.held?.host === hostname();
        notes.push(
          earlierRunOfThis
            ? `took over ${lock}, left by an earlier run of this console`
            : `took over ${lock}, left by ${describeHolder(seen.held)}, untouched for ${Math.round(seen.ageMs / 1000)} s and not touched while watched`,
        );
        created = true;
      }
      // "changed": another claimant moved first. Look again; it is now the one to refuse to.
    }
    if (!created) {
      return refuse(
        `the ${resource.what} at ${resource.path} could not be locked after four attempts, because other consoles kept taking the lock at ${lock}.`,
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
        `another console started on the ${resource.what} at ${resource.path} at the same moment and took the lock at ${lock}. Only one of them can run.`,
        true,
      );
    }
  }

  /** Ticks a taken lock has read as not yet a lock, while its new holder writes it. */
  const unreadable = new Map<string, number>();
  /** Note a lock that is no longer this claim's, once, and say so. */
  const noticeIfTaken = (lock: string): void => {
    if (lost.has(lock) || ours(lock)) return;
    let text: string | null = null;
    try {
      text = readFileSync(lock, "utf8");
    } catch {
      // Gone: said as such.
    }
    const held = text === null ? null : parseHeld(text);
    // A lock is created and then written, so the console that took this one can be caught
    // between the two, and the sentence named nobody for good. Said once it reads, or after a
    // few ticks of not reading, which is a lock that is not one.
    if (text !== null && held === null && (unreadable.get(lock) ?? 0) < 3) {
      unreadable.set(lock, (unreadable.get(lock) ?? 0) + 1);
      return;
    }
    const holder = text === null ? "nobody, because the lock file is gone" : describeHolder(held);
    const sentence = `this console no longer holds ${lock}: it is held by ${holder}. Nothing more is written from here; close this console and use the other one.`;
    lost.set(lock, sentence);
    options.onLost?.(sentence);
  };
  const check = (): string | null => {
    for (const lock of taken) noticeIfTaken(lock);
    for (const lock of taken) {
      const sentence = lost.get(lock);
      if (sentence !== undefined) return sentence;
      // Refused whether or not the holder can be named yet: a write is not the place to wait.
      if (!ours(lock)) {
        return `this console no longer holds ${lock}. Nothing more is written from here; close this console and use the other one.`;
      }
    }
    return null;
  };

  timer = setInterval(() => {
    for (const lock of taken) {
      if (lost.has(lock)) continue;
      if (ours(lock)) {
        try {
          const now = new Date();
          utimesSync(lock, now, now);
        } catch {
          // Missed once; the stale interval allows for several.
        }
        continue;
      }
      // Every lock that goes is said, not only the first: one flag for all of them named the
      // workspace's and never the link table's.
      noticeIfTaken(lock);
    }
  }, heartbeatMs);
  // The touches must not keep a process alive that has nothing else to do.
  timer.unref();
  return { ok: true, claim: { release, check }, notes };
}

/**
 * Move a lock out of the way, under a name only this claim uses. Already gone is fine. On
 * Windows a file in the middle of being opened or touched refuses a rename for a moment, and
 * that is waited out rather than reported as a lock that cannot be taken over.
 */
async function moveAside(lock: string, away: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(lock, away);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= 5) throw error;
      await new Promise((settle) => setTimeout(settle, 15 * (attempt + 1)));
    }
  }
}

/**
 * Put a lock moved aside by mistake back where it was, if nothing has taken its place.
 *
 * A link rather than a rename, because a rename replaces whatever is at the name, and what might
 * be there is a lock another console has just made.
 */
function putBack(away: string, lock: string): void {
  try {
    linkSync(away, lock);
  } catch {
    // Something holds the name now, or the filesystem cannot link. The lock that was moved
    // belonged to a console that is about to find it gone and stop writing, which is the safe
    // way for this to fail.
  }
  try {
    unlinkSync(away);
  } catch {
    // Left beside the lock, named for this claim, where nothing reads it.
  }
}

/** Remove the markers made for one lock, or only one claim's when `only` is given. */
async function clearMarkers(folder: string, prefix: string, only: string | null): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(folder, name);
    if (only !== null) {
      const holder = await readFile(path, "utf8").catch(() => null);
      if (holder !== only) continue;
    }
    await unlink(path).catch(() => undefined);
  }
}

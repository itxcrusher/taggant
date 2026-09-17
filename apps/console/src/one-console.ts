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
 * So the arrangement is one console per workspace and per link table, and this is what
 * notices when it is not. It is a lock file per resource holding the process that took it,
 * checked at startup: a live process means this console does not start, a process that is
 * gone means the lock was left by a crash and is taken over.
 *
 * The command line is what claims it, not `createConsole`. A server handed a workspace
 * object is a library call, and taking a process-wide lock underneath one would be a
 * surprise: the tests stand several consoles up at once on purpose. So the guarantee is a
 * property of the tool, and anything embedding the server owns the arrangement itself.
 *
 * A process id can be reused by the operating system, so a lock naming a live id is not
 * proof that the live process is a console. That is why the refusal prints the id: it is
 * checkable by whoever reads it, which a bare refusal would not be.
 *
 * And an id means nothing at all off the machine that wrote it, which is the failure branch
 * of this check rather than of the thing it guards. A console in a container writes a lock
 * on a mounted workspace; the container is killed; the next container starts the ids again
 * from one, so the lock names a process that is alive there and is its own init. Checked by
 * id alone, that console would refuse to start for ever. So a lock records where it was
 * taken, and one from somewhere else is refused with a sentence saying that this machine
 * cannot tell and naming the file to delete: a few seconds of somebody's attention, against
 * a second console that loses an edit and says it saved it.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
   * container rather than the lock. In the compose stack the workspace is a bind mount
   * under a read-only root: `/srv/workspace` is writable and `/srv/workspace.console-lock`
   * is not, so a lock beside the directory made the console refuse to start in its own
   * stack. A file's lock beside it is inside the same mount, which is why that one stays
   * where it was.
   */
  kind: "directory" | "file";
}

export interface Claim {
  /**
   * Give up every lock taken, and only those still naming this process.
   *
   * Synchronous because the last place it runs is an exit handler, where a promise is
   * never awaited and the work is silently dropped.
   */
  release(): void;
}

/** Where the lock for a resource lives. */
export function lockFor(resource: Exclusive): string {
  return resource.kind === "directory"
    ? join(resource.path, ".console-lock")
    : `${resource.path}.console-lock`;
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 asks the question without sending anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process owned by somebody else is alive and unsignalable, which is not the same
    // answer as gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Held {
  pid: number;
  /**
   * Where the lock was taken.
   *
   * A process id means nothing off the machine that wrote it, and in a container the ids
   * start again at one: a lock left by a container that was killed names a pid that is
   * alive in the next container, which is its own init, so a check by id alone would
   * refuse to start for ever. Recorded so that case is recognised and said rather than
   * guessed at.
   */
  host: string;
  since: string;
  what: string;
}

function readHeld(lock: string): Held | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lock, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const held = parsed as Partial<Held>;
    if (typeof held.pid !== "number") return null;
    return {
      pid: held.pid,
      host: String(held.host ?? ""),
      since: String(held.since ?? "an unknown time"),
      what: String(held.what ?? ""),
    };
  } catch {
    // An unreadable lock is treated as a lock nobody holds. It cannot name a process, so
    // there is nothing to check and nothing to wait for.
    return null;
  }
}

/**
 * Take a lock on each resource, or say which one is already taken.
 *
 * Either every lock is held or none is: a console that claimed the workspace and then
 * found the link table taken must not leave the workspace looking occupied.
 */
export async function claim(
  resources: readonly Exclusive[],
): Promise<{ ok: true; claim: Claim; notes: string[] } | { ok: false; because: string }> {
  const taken: string[] = [];
  const notes: string[] = [];
  const release = (): void => {
    for (const lock of taken) {
      const held = readHeld(lock);
      // Only ours. A lock that has been taken over by another console after this one
      // stopped being the owner is not this one's to delete.
      if (held?.pid === process.pid) {
        try {
          unlinkSync(lock);
        } catch {
          // Nothing to do about a lock that cannot be removed, and an exit handler is not
          // the place to throw. The next console reads the process id and finds it gone.
        }
      }
    }
    taken.length = 0;
  };

  for (const resource of resources) {
    const lock = lockFor(resource);
    const mine: Held = {
      pid: process.pid,
      host: hostname(),
      since: new Date().toISOString(),
      what: resource.what,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(dirname(lock), { recursive: true });
        // Exclusive create: the check and the claim are one operation, so two consoles
        // starting together cannot both believe they took it.
        await writeFile(lock, `${JSON.stringify(mine, null, 2)}\n`, { flag: "wx" });
        taken.push(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          release();
          return {
            ok: false,
            because: `the ${resource.what} at ${resource.path} could not be claimed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        const held = readHeld(lock);
        // Taken somewhere else, so whether that process is alive is not a question this
        // machine can answer. Refused rather than guessed at, because starting a second
        // console loses an edit silently and refusing is a sentence somebody can act on
        // in a few seconds.
        if (held !== null && held.host !== "" && held.host !== hostname()) {
          release();
          return {
            ok: false,
            because: `the ${resource.what} at ${resource.path} is locked by process ${held.pid} on ${held.host}, since ${held.since}, and this machine cannot tell whether that process is still running. If nothing is using it, delete ${lock} and start again.`,
          };
        }
        if (held !== null && alive(held.pid)) {
          release();
          return {
            ok: false,
            because: `another console is already open on the ${resource.what} at ${resource.path}: process ${held.pid}, since ${held.since}. Two consoles on one ${resource.what} can lose an edit, and both operators are told it was saved. Close that one, or point this one somewhere else.`,
          };
        }
        if (attempt === 1) {
          release();
          return {
            ok: false,
            because: `the lock on the ${resource.what} at ${resource.path} could not be taken over, and this console will not open a ${resource.what} it cannot claim. Delete ${lock} if no console is running.`,
          };
        }
        notes.push(
          held === null
            ? `took over ${lock}, which named no process`
            : `took over ${lock}, left by process ${held.pid}, which is gone`,
        );
        await rm(lock, { force: true });
      }
    }
  }

  return { ok: true, claim: { release }, notes };
}

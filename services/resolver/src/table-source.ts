/**
 * Noticing that the link table on disk has changed.
 *
 * This is more than one line of code because watching a file does not work, in two
 * different ways that both end in the same place: the operator edits the table, the
 * resolver goes on serving the old one, and readiness reports that everything is fine.
 *
 * **A watch on a path dies when the path is replaced.** Anything that writes a file
 * safely writes it beside the destination and renames over it: this project's own console
 * does, vim does by default, `sed -i` does, and so does most deployment tooling. On Linux
 * the watch is bound to the old inode, so it reports that one rename and then never fires
 * again, for any later edit. Measured: after a rename replace, a second in-place write
 * produced no events at all on the file watch and two on the directory watch.
 *
 * **A bind mount often delivers no events at all.** Measured against this project's own
 * compose stack on Docker Desktop: an in-place edit to the mounted table on the host
 * produced nothing inside the container, and the resolver went on answering from the table
 * it had at boot. The same is true of NFS and of several other network file systems, which
 * is to say of a good share of the places a resolver actually runs.
 *
 * So the watch is the fast path and not the mechanism. What decides is a stat of the file,
 * taken on a timer, compared against the last one. It costs one system call every couple
 * of seconds and it is the only part of this that works everywhere.
 */

import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** How often the file is checked when nothing has said it changed. */
export const DEFAULT_POLL_MS = 2000;

export interface TableSourceOptions {
  pollMs?: number;
  /** Called whenever the file on disk is not the one last seen. */
  onChange: () => void | Promise<void>;
}

export interface TableSource {
  /** Check now rather than waiting for the timer, and say whether it had changed. */
  check(): Promise<boolean>;
  stop(): void;
}

/**
 * What identifies a version of the file.
 *
 * Size and modification time catch an edit; the inode catches a replacement that happened
 * to land on the same size and timestamp, which a rename can. Absent is a state too: a
 * table that is deleted and put back is a change.
 */
async function stampOf(path: string): Promise<string | null> {
  try {
    const found = await stat(path);
    return `${found.mtimeMs}:${found.size}:${found.ino}`;
  } catch {
    return null;
  }
}

export async function watchTable(path: string, options: TableSourceOptions): Promise<TableSource> {
  let stamp = await stampOf(path);
  let stopped = false;
  let running = false;

  const check = async (): Promise<boolean> => {
    if (stopped || running) return false;
    running = true;
    try {
      const now = await stampOf(path);
      if (now === stamp) return false;
      stamp = now;
      await options.onChange();
      return true;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void check();
  }, options.pollMs ?? DEFAULT_POLL_MS);
  // The timer is the mechanism, and it must not be the reason the process stays alive.
  timer.unref?.();

  // The fast path. Watching the directory rather than the file, because that is the one
  // that survives the file being replaced. Failing to establish it is not an error: the
  // timer above is what this actually relies on.
  let watcher: FSWatcher | undefined;
  try {
    const name = basename(path);
    watcher = watch(dirname(path), { persistent: false }, (_event, changed) => {
      if (changed === null || changed === undefined || changed === name) void check();
    });
    watcher.on("error", () => {
      // A watch that fails later is the ordinary case on a network file system.
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    watcher = undefined;
  }

  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
    },
  };
}

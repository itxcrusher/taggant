/**
 * The queues that put the console's writes to one file in order, and the one spelling of a
 * path they are keyed by.
 *
 * Three of these queues existed, each with its own copy of the same few lines, and they
 * disagreed about the one thing that matters: what counts as the same file. The workspace's
 * belonged to the object that made it, so two objects on one folder had two queues; the link
 * table's and the publish folder's compared paths as text with case folded, which two
 * spellings of one file defeat.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

/**
 * The path as the filesystem names it.
 *
 * A file has more spellings than its letter case. On a volume that keeps short names,
 * `LINKS~1.JSO` is `links.json`; a junction or a symbolic link puts one file under two
 * folders. Two consoles given the two spellings of one link table took two locks and wrote
 * the same table each from its own copy, and one console given the short spelling renamed the
 * table itself to `LINKS~1.JSO`, so the resolver's file was gone. The native lookup is the one
 * that answers this: Node's other `realpath` resolves links and leaves a short name as typed.
 *
 * A path that does not exist yet is named through its folder, which usually does.
 */
export function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/**
 * The key a path takes in a queue.
 *
 * Case is folded where the platform folds it and left alone where it does not, because on
 * Linux `case.json` and `CASE.JSON` are two files and sharing a queue between them would be
 * the opposite mistake. This follows the platform rather than the volume, so a folder mounted
 * case-insensitively into Linux, as a container's bind mount from Windows or macOS is, gets
 * one queue per spelling there.
 */
export function queueKey(path: string): string {
  const named = canonical(path);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  return caseInsensitive ? named.toLowerCase() : named;
}

/**
 * Run `work` after everything queued under `key` before it, whatever became of that.
 *
 * A failed step does not wedge the queue behind it, and a key is dropped once nothing waits
 * on it, so an idle console holds nothing.
 */
export function inTurn<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return result;
}

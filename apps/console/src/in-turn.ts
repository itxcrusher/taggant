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
 * A path that does not exist yet is named through its folder, which usually does, and by the
 * name the file will have once it does.
 */
export function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), asStored(basename(absolute)));
    } catch {
      return absolute;
    }
  }
}

/**
 * A file name as Windows will store it, which is without trailing dots or spaces.
 *
 * A link table given as `links.json.` is written to `links.json`, and before it existed its lock
 * was taken under the name as typed: a console given each spelling opened the same table, each
 * with its own lock, and forty codes registered through the two left twenty in the table.
 */
function asStored(name: string): string {
  if (process.platform !== "win32") return name;
  const stored = name.replace(/[. ]+$/, "");
  return stored === "" ? name : stored;
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

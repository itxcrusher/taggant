/**
 * The three things the console does that are not editing a manifest.
 *
 * Each one is a call into a package that already exists and is already tested, which is
 * the point: the console is the place where a person drives the compiler, the bundler and
 * the resolver's table, not a second implementation of any of them.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { bundle, realWithin } from "@taggant/bundler";
import {
  type Report,
  carriesItsDistance,
  compileTarget,
  distanceBehind,
  toTargetJson,
} from "@taggant/compiler";
import {
  type LinkTable,
  type StoredLink,
  parseDigitalLink,
  parseTable,
  sameLinkType,
} from "@taggant/resolver";
import { fromTargetFile } from "@taggant/vision";
import { type Experience, type Workspace, WorkspaceError, publishable } from "./workspace.js";

/**
 * Distance a person is expected to hold the camera from the print, in millimetres.
 *
 * It is the one input the compiler cannot infer, and it changes the answer: the same
 * artwork asks for more width the further away it will be read.
 *
 * 150 mm, which is closer than it sounds and is what this actually reaches. Recognition
 * runs on a frame reduced to a fixed width, so a mark has to fill roughly two thirds of the
 * picture to put enough pixels across itself, and that is a short working distance for
 * anything pack-sized: a 120 mm front panel is readable to about 155 mm and an A6 postcard
 * to about 190. This was 350 mm, a pack held at arm's length, which the report agreed with
 * because the report was dividing by the wrong pixels; it never worked. Reaching further is
 * a change to how far down the compiled target is described, not to this number.
 */
export const DEFAULT_SCAN_DISTANCE_MM = 150;

export interface CompileOutcome {
  targetId: string;
  report: Report;
  /** Where the compiled target was written, relative to the experience. */
  path: string;
}

/**
 * Compile one of an experience's targets from the artwork the manifest names.
 *
 * The artwork is read through the manifest rather than from wherever the caller says,
 * so the thing compiled is the thing that will be published.
 */
export async function compile(
  workspace: Workspace,
  experience: Experience,
  targetId: string,
  scanDistanceMm: number = DEFAULT_SCAN_DISTANCE_MM,
): Promise<CompileOutcome> {
  const target = experience.manifest.targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new WorkspaceError(`${experience.id} has no target called ${targetId}`);
  }
  if (!Number.isFinite(scanDistanceMm) || scanDistanceMm < 50 || scanDistanceMm > 5000) {
    throw new WorkspaceError(
      `a scan distance of ${scanDistanceMm} mm is not one a person could hold: 50 to 5000`,
    );
  }
  // Resolved the way the bundler resolves it, so artwork that compiles here is artwork
  // that publishes. `realWithin` refuses a path that leaves the experience even through
  // a link.
  // The artwork can be gone: renamed, tidied away, or on a drive that is not mounted.
  // Both `realWithin` and `readFile` report that as an errno with a path in it, and the
  // server turns anything that is not a `WorkspaceError` into a 500 with a stack trace in
  // the log. Publishing already wrapped its own rebuild in a sentence, so the same moved
  // file was a sentence on one route and a crash on the other, which is the worse of the
  // two for the person who moved it.
  let artwork: Buffer;
  try {
    artwork = await readFile(await realWithin(experience.directory, target.source));
  } catch (error) {
    throw new WorkspaceError(
      `${targetId} points at ${target.source} and it could not be read: ${
        error instanceof Error ? error.message : String(error)
      }. Upload the artwork again, or put the file back where the manifest says it is.`,
    );
  }
  const compiled = await compileTarget(artwork, {
    id: targetId,
    scanDistanceMm,
  });
  const path = await workspace.writeTarget(experience.id, targetId, toTargetJson(compiled));
  return { targetId, report: compiled.report, path };
}

export interface PublishOutcome {
  outDir: string;
  files: string[];
  /** Targets that had to be compiled first, in the order they were. */
  compiled: CompileOutcome[];
}

/**
 * One queue per destination, so two publishes of one experience happen one after the other.
 *
 * The bundler builds each publish in its own staging directory and swaps it in with a
 * rename, and that is not enough on its own: the swap removes the destination and renames
 * over it, so two publishes doing that at once collide there instead. Measured over
 * fourteen pairs each way, publishing into a destination that already held a bundle:
 *
 *   one staging path for all publishes, no queue      8 of 14 pairs failed
 *   a staging path per publish, no queue             14 of 14 pairs failed
 *   a staging path per publish and this queue         0 of 14
 *
 * The failures are a raw ENOENT or EPERM naming a path that is ours, reaching an operator
 * who was told how many files had been written; one round of the middle row left the
 * destination empty with nothing published at all. So serialising is what makes the
 * sentence true, and the unique staging path is what makes the loser's work discarded
 * whole rather than half of it surviving.
 *
 * Keyed on the destination rather than the experience id, because that is the thing being
 * written and two ids cannot share it, and through `queueKey` for the same reason the
 * table's queue is.
 */
const publishQueues = new Map<string, Promise<void>>();

/**
 * The key a path takes in a queue.
 *
 * `resolve` alone was not enough, and the comment that said it was is the finding. It
 * normalises separators and relative segments and does not normalise case, which is the
 * spelling difference that matters on the filesystem this is developed on: two calls
 * spelled `case.json` and `CASE.JSON` took two queues, ran together, and one of the two
 * codes was gone. Case is folded where the platform folds it and left alone where it does
 * not, because on Linux those two names are two files and sharing a queue between them
 * would be the opposite mistake.
 */
function queueKey(path: string): string {
  const resolved = resolve(path);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

function inTurnForPublish<T>(outDir: string, work: () => Promise<T>): Promise<T> {
  const key = queueKey(outDir);
  const previous = publishQueues.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  publishQueues.set(key, settled);
  void settled.then(() => {
    if (publishQueues.get(key) === settled) publishQueues.delete(key);
  });
  return result;
}

export interface PublishOptions {
  runtimeDir?: string;
  scanDistanceMm?: number;
  /**
   * Called as each target is rebuilt, before anything is published.
   *
   * A rebuild writes to the workspace, and the publish can still fail afterwards at the
   * bundler, so what was rebuilt has to be reportable on the failure path too. Reading it
   * off the returned outcome only worked when there was a returned outcome.
   */
  onRebuild?: (targetId: string, atDistanceMm: number) => void;
}

/**
 * Publish an experience as a static folder.
 *
 * Anything not compiled yet is compiled first, because publishing an experience whose
 * artwork was changed after its last compile would ship a bundle that recognises the old
 * artwork, and nothing downstream could tell.
 */
export function publish(
  workspace: Workspace,
  experience: Experience,
  outDir: string,
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  return inTurnForPublish(outDir, () => publishOnce(workspace, experience, outDir, options));
}

async function publishOnce(
  workspace: Workspace,
  experience: Experience,
  outDir: string,
  options: PublishOptions,
): Promise<PublishOutcome> {
  // Refused here rather than half way through writing a folder. `publishable` is where
  // the schema stops being advice and becomes a gate: a bundle is what the world sees, and
  // it is the one artefact that has to be valid.
  const manifest = publishable(experience);
  const compiled: CompileOutcome[] = [];
  const targets: Record<string, unknown> = {};
  for (const target of manifest.targets) {
    // Usable, not merely present. A target file can exist and still be one the runtime
    // cannot read: compiled before the descriptor's sampling pattern changed, half
    // written, or edited by hand. The workspace holds the artwork it was built from, so
    // the answer is to build it again rather than to refuse and leave the operator with a
    // message about a file format and no way to act on it.
    let stored: unknown;
    // The distance to rebuild at, when a rebuild turns out to be needed. Undefined means
    // nothing better than the default is known.
    let rebuildAt = options.scanDistanceMm;
    if (await workspace.hasTarget(experience.id, target.id)) {
      try {
        stored = await workspace.readTarget(experience.id, target.id);
        fromTargetFile(stored);
        // Usable to recognise with and still not one to publish. A target written before
        // the report carried its own scan distance carries a minimum print width from the
        // model that divided by the sensor's pixels instead of the recogniser's, and the
        // bundler compares the declared print width against exactly that number. Left
        // alone it publishes with a gate that is four times too lenient.
        const report = (stored as { report?: unknown }).report;
        if (report !== undefined && !carriesItsDistance(report)) {
          stored = undefined;
          // Rebuilt at the distance that report was computed for, which the old model's
          // own arithmetic gives back exactly. Falling back to the default instead was
          // silently moving an operator who chose 350 mm to 150, where the same artwork
          // needs less than half the width, so a piece the gate had to refuse published
          // clean and the choice they made was gone from disk with it.
          rebuildAt = distanceBehind(report) ?? options.scanDistanceMm;
        }
      } catch {
        stored = undefined;
      }
    }
    if (stored === undefined) {
      try {
        const outcome = await compile(workspace, experience, target.id, rebuildAt);
        compiled.push(outcome);
        options.onRebuild?.(target.id, outcome.report.scanDistanceMm);
      } catch (error) {
        // `compile` reaches the artwork through the manifest, and the artwork can be gone:
        // renamed, tidied away, or on a drive that is not mounted. That arrives from the
        // path resolver as a plain error, which the server renders as "something failed",
        // so an operator whose file moved gets a 500 and no idea which target or which
        // file. Before this rebuild existed the same experience published, with a bad
        // width in it, so the opaque failure is new and is ours.
        throw new WorkspaceError(
          `${target.id} had to be compiled again before publishing and could not be: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      stored = await workspace.readTarget(experience.id, target.id);
    }
    targets[target.id] = stored;
  }
  if (Object.keys(targets).length === 0) {
    throw new WorkspaceError(`${experience.id} has no targets, so there is nothing to recognise`);
  }
  let result: Awaited<ReturnType<typeof bundle>>;
  try {
    result = await bundle({
      manifest,
      targets,
      sourceDir: experience.directory,
      outDir,
      ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
    });
  } catch (error) {
    // A bundle carries the runtime rather than pointing at it, so publishing needs a
    // built runtime to carry. Run from a checkout that has not been built, that arrives
    // as a missing file with a path in it and no explanation at all.
    const missingRuntime =
      (error as NodeJS.ErrnoException)?.code === "ENOENT" && String(error).includes("runtime");
    throw new WorkspaceError(
      missingRuntime
        ? "the runtime has not been built, and a bundle carries it rather than pointing at it. Run the build once, then publish again."
        : `publishing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { outDir: result.outDir, files: result.files, compiled };
}

/**
 * Point a printed code at a published bundle, by writing the resolver's own table.
 *
 * The console does not talk to the resolver and the resolver does not know the console
 * exists. The table is a file one writes and the other watches, which is the same
 * boundary the continuity claim rests on: a table that can only be changed by asking a
 * service is a table the operator does not own.
 */
/**
 * One queue per link table, so a read and the write that follows it are not separated.
 *
 * Registering a code is read, change, write. Two registrations at the same moment both
 * read the table before either wrote, so the second write was built on the table as it was
 * before the first: measured, two codes registered together left one identifier in the
 * table, and both operators were told theirs "points here". A printed code that points at
 * nothing, and a person who was told it does not, which is the worst pairing available in
 * this system.
 *
 * The workspace has the same queue for the same reason, keyed per experience, and it does
 * not cover this: the link table is one shared file and this function never went through
 * the workspace. Keyed through `queueKey`, so two spellings of one file share a queue.
 * Like the workspace's, this is an in-process queue and not a lock file, so it orders
 * this console's writes and knows nothing about another console's. That arrangement is
 * one console per link table: `claim` in `one-console.ts` takes a lock beside the table
 * at startup and refuses to open a table another live console holds, and the README says
 * so in the words an operator would use. Until that check existed this comment cited a
 * document that said nothing of the kind.
 */
const tableQueues = new Map<string, Promise<void>>();

function inTurnForTable<T>(tablePath: string, work: () => Promise<T>): Promise<T> {
  const key = queueKey(tablePath);
  const previous = tableQueues.get(key) ?? Promise.resolve();
  // Run on either outcome of the one before, so a failed registration does not wedge the
  // queue behind it.
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  tableQueues.set(key, settled);
  void settled.then(() => {
    if (tableQueues.get(key) === settled) tableQueues.delete(key);
  });
  return result;
}

export async function registerCode(
  tablePath: string,
  entry: { path: string; href: string; title: string; linkType?: string; language?: string },
): Promise<{ path: string; replaced: number; kept: number }> {
  return await inTurnForTable(tablePath, () => writeCode(tablePath, entry));
}

async function writeCode(
  tablePath: string,
  entry: { path: string; href: string; title: string; linkType?: string; language?: string },
): Promise<{ path: string; replaced: number; kept: number }> {
  // The path is the key the resolver looks scans up by, so it is canonicalised here by
  // the resolver's own parser rather than taken as typed. A code written as an EAN-13
  // and a code written as a GTIN-14 are the same code, and a table holding both under
  // two keys answers one of them and not the other.
  //
  // A code typed wrongly is the ordinary case, not a crash: the resolver's parser says
  // exactly what is wrong with it, and that sentence is worth more to whoever typed it
  // than anything this could write instead.
  let canonical: string;
  try {
    canonical = parseDigitalLink(entry.path).canonicalPath;
  } catch (error) {
    throw new WorkspaceError(
      `${entry.path} is not a Digital Link this resolver would answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let current: LinkTable;
  try {
    current = parseTable(JSON.parse(await readFile(tablePath, "utf8")));
  } catch (error) {
    // A table that is not there yet is the ordinary case for a first code. A table that
    // is there and unreadable is not, and overwriting it would lose every other code.
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!missing) {
      throw new WorkspaceError(
        `${tablePath} could not be read, and writing over it would lose the codes already in it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    current = { version: 1, entries: {} };
  }

  // A title is required rather than optional, because the resolver's own parser refuses a
  // link without one. Optional here meant this function could build a table the resolver
  // would then reject, which is the shape of a defect that only appears in production.
  const linkType = entry.linkType ?? "gs1:pip";
  const link: StoredLink = {
    href: entry.href,
    linkType,
    title: entry.title,
    default: true,
    ...(entry.language === undefined ? {} : { hreflang: [entry.language] }),
  };

  /**
   * A code carries several links, and this replaces the ones it is about.
   *
   * Writing the whole array deleted every sibling: against this repository's own worked
   * table, registering one destination took a code from an English page, a French page and
   * a certification link down to one, and said "replacing what it pointed at before" while
   * it did it. A certification link is a different fact about the same product and has no
   * business being removed because the product page moved.
   *
   * What does go is every link of the same type. Those are the same fact in another
   * language and they point at the old destination. Keeping them looks tidier and is
   * worse: the resolver picks the best language match among siblings of the default's
   * type, so a French page left behind would go on answering French scans with the old
   * address while the console reported that the code now points somewhere else.
   */
  const existing = current.entries[canonical] ?? [];
  const adjusted = existing.filter((other) => !sameLinkType(other.linkType, linkType));
  const replaced = existing.length - adjusted.length;
  // Exactly the two fields the format has, rather than a spread of whatever was on disk.
  // Spreading carried unknown top-level keys forward, `__proto__` among them, so a table
  // this console rewrote kept junk that neither it nor the resolver understands.
  const next = {
    version: current.version,
    entries: { ...current.entries, [canonical]: [...adjusted, link] },
  };
  // Validated before it is written, so a table this console produced is one the resolver
  // will accept. Writing a table the resolver then refuses would take every other code
  // down with it.
  try {
    parseTable(next);
  } catch (error) {
    throw new WorkspaceError(
      `that would have written a table the resolver refuses, so nothing was written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const staging = `${tablePath}.writing-${randomBytes(4).toString("hex")}`;
  try {
    // The folder the table lives in need not exist yet. The console is told where to put
    // the table and nothing creates that folder on the way, so on a fresh checkout the
    // first code anyone registered came back as an ENOENT naming an internal staging
    // path: a 500, a stack trace in the log, and nothing said about the folder.
    await mkdir(dirname(tablePath), { recursive: true });
    await writeFile(staging, `${JSON.stringify(next, null, 2)}\n`);
    await rename(staging, tablePath);
  } catch (error) {
    await rm(staging, { force: true });
    throw new WorkspaceError(
      `the link table at ${tablePath} could not be written, so the code was not registered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { path: canonical, replaced, kept: adjusted.length };
}

/** Where an experience publishes to, under the folder the static host serves. */
export function bundleDirFor(publishRoot: string, id: string): string {
  return join(publishRoot, id);
}

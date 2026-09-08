/**
 * The three things the console does that are not editing a manifest.
 *
 * Each one is a call into a package that already exists and is already tested, which is
 * the point: the console is the place where a person drives the compiler, the bundler and
 * the resolver's table, not a second implementation of any of them.
 */

import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundle, realWithin } from "@taggant/bundler";
import { type Report, compileTarget, toTargetJson } from "@taggant/compiler";
import { type LinkTable, parseDigitalLink, parseTable } from "@taggant/resolver";
import { type Experience, type Workspace, WorkspaceError, publishable } from "./workspace.js";

/**
 * Distance a person is expected to hold the camera from the print, in millimetres.
 *
 * It is the one input the compiler cannot infer, and it changes the answer: the same
 * artwork asks for more width the further away it will be read. 350 mm is a pack held in
 * the hand, which is the common case, and it is offered rather than imposed.
 */
export const DEFAULT_SCAN_DISTANCE_MM = 350;

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
  const artworkPath = await realWithin(experience.directory, target.source);
  const compiled = await compileTarget(await readFile(artworkPath), {
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
 * Publish an experience as a static folder.
 *
 * Anything not compiled yet is compiled first, because publishing an experience whose
 * artwork was changed after its last compile would ship a bundle that recognises the old
 * artwork, and nothing downstream could tell.
 */
export async function publish(
  workspace: Workspace,
  experience: Experience,
  outDir: string,
  options: { runtimeDir?: string; scanDistanceMm?: number } = {},
): Promise<PublishOutcome> {
  // Refused here rather than half way through writing a folder. `publishable` is where
  // the schema stops being advice and becomes a gate: a bundle is what the world sees, and
  // it is the one artefact that has to be valid.
  const manifest = publishable(experience);
  const compiled: CompileOutcome[] = [];
  const targets: Record<string, unknown> = {};
  for (const target of manifest.targets) {
    if (!(await workspace.hasTarget(experience.id, target.id))) {
      compiled.push(await compile(workspace, experience, target.id, options.scanDistanceMm));
    }
    targets[target.id] = await workspace.readTarget(experience.id, target.id);
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
export async function registerCode(
  tablePath: string,
  entry: { path: string; href: string; title: string; linkType?: string; language?: string },
): Promise<{ path: string; replaced: boolean }> {
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
  const link: Record<string, unknown> = {
    href: entry.href,
    linkType: entry.linkType ?? "gs1:pip",
    title: entry.title,
    default: true,
  };
  if (entry.language !== undefined) link.hreflang = [entry.language];

  const replaced = Object.hasOwn(current.entries, canonical);
  // Exactly the two fields the format has, rather than a spread of whatever was on disk.
  // Spreading carried unknown top-level keys forward, `__proto__` among them, so a table
  // this console rewrote kept junk that neither it nor the resolver understands.
  const next = {
    version: current.version,
    entries: { ...current.entries, [canonical]: [link] },
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
    await writeFile(staging, `${JSON.stringify(next, null, 2)}\n`);
    await rename(staging, tablePath);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  return { path: canonical, replaced };
}

/** Where an experience publishes to, under the folder the static host serves. */
export function bundleDirFor(publishRoot: string, id: string): string {
  return join(publishRoot, id);
}

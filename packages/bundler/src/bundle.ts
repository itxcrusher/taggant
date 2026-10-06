import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { carriesItsDistance, describesTarget, isCurrentReport, targetDigest } from "@taggant/compiler";
import { validateManifest } from "@taggant/manifest";
import { fromTargetFile } from "@taggant/vision";
import { type CopiedAsset, RENDER_BUDGET_MS, copyAsset, within } from "./assets.js";
import { entryPage } from "./page.js";

export interface BundleOptions {
  /** The manifest, as read from disk. Validated here rather than trusted. */
  manifest: unknown;
  /** Compiled target files, keyed by the target id the manifest uses. */
  targets: Record<string, unknown>;
  /** Where the manifest's own paths are resolved from. */
  sourceDir: string;
  outDir: string;
  /**
   * Where to take the runtime from. Defaults to the installed `@taggant/runtime` build.
   * Passed explicitly by the tests so they bundle a known copy.
   */
  runtimeDir?: string;
  /**
   * How long every SVG render in this publish may take together. Defaults to
   * `RENDER_BUDGET_MS`; the tests pass a short one to prove the bound.
   */
  renderBudgetMs?: number;
}

export interface BundleResult {
  outDir: string;
  assets: CopiedAsset[];
  targets: string[];
  /** Every file written, relative to the bundle, so a publisher can see what shipped. */
  files: string[];
}

/** Written into every bundle, so publishing again knows what it is allowed to replace. */
const MARKER = ".taggant-bundle";

/**
 * Whether this publish is allowed to replace what is at the destination.
 *
 * Nothing is deleted here. A published bundle is a live thing that people are scanning a
 * printed code to reach, and emptying its folder before knowing the new one can even be
 * built is how a typo in a manifest takes an experience off the air. So the destination is
 * only inspected, the new bundle is built beside it, and the swap happens at the end.
 *
 * Replacing is only allowed for a directory this tool published to before, which the
 * marker file records. Anything else is refused by name, because emptying a directory
 * somebody else filled is not a thing to do on a guess.
 *
 * Two publishes of one experience build independently, each into its own staging
 * directory, and then meet here. This is where they collide, and it is not harmless: the
 * destination is removed and the staging directory renamed over it, and with two publishes
 * doing that at once fourteen of fourteen measured pairs failed one or both requests with
 * an errno from this region, one of them leaving the destination empty with nothing
 * published. **A caller who publishes twice to one destination has to serialise**, and the
 * console does, per destination. Without that, unique staging directories alone are worse
 * than the shared one they replaced, because under the shared one the loser usually failed
 * before reaching this point.
 */
async function mayReplace(outDir: string): Promise<boolean> {
  let existing: string[];
  try {
    existing = await readdir(outDir);
  } catch {
    return false;
  }
  if (existing.length === 0) return true;
  if (!existing.includes(MARKER)) {
    throw new Error(
      `${outDir} already holds files and was not published by this tool, so it will not be replaced. Publish into a new directory, or empty this one yourself.`,
    );
  }
  return true;
}

/** The new bundle is built at `<destination>.publishing-<hex>`, beside the destination. */
const STAGING = "publishing-";
/** What was live is moved to `<destination>.replaced-<hex>` while the new one moves in. */
const ASIDE = "replaced-";

/**
 * How old a folder left by a publish that stopped part way has to be before a later publish
 * of the same experience removes it.
 *
 * Long, because the folder may belong to a publish that is still running in another console:
 * a publish spends up to two minutes rendering, then copies, and its staging folder is not to
 * be taken from under it. An hour is far past any publish and short of anyone noticing.
 */
const LEFTOVER_AFTER_MS = 60 * 60 * 1000;

/**
 * Remove what earlier publishes of this destination left beside it.
 *
 * Each publish builds in a folder of its own and moves it in at the end, so a publish that
 * failed or was killed part way leaves a whole bundle beside the destination, and the folder
 * the destination sits in is the one the static host serves. Nothing removed them: the clean
 * before each publish looked for the name this publish was about to use, which is random, so
 * it never found an earlier one. Measured, every failed swap left one, and three publishes
 * later it was still there.
 *
 * Only names this module writes, and an old copy of what was live only while something is
 * live: with the destination missing, that copy may be the only one there is.
 */
async function sweepLeftovers(outDir: string): Promise<void> {
  const parent = dirname(outDir);
  const base = basename(outDir);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  const live = await readdir(outDir).then(
    () => true,
    () => false,
  );
  for (const name of names) {
    const kind = name.startsWith(`${base}.${STAGING}`)
      ? STAGING
      : name.startsWith(`${base}.${ASIDE}`)
        ? ASIDE
        : null;
    if (kind === null || !/^[0-9a-f]{8}$/.test(name.slice(base.length + 1 + kind.length))) continue;
    if (kind === ASIDE && !live) continue;
    const path = join(parent, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory() || Date.now() - info.mtimeMs < LEFTOVER_AFTER_MS) continue;
      await rm(path, { recursive: true, force: true });
    } catch {
      // Left for the next publish. A leftover that cannot be removed now is not a reason to
      // refuse a publish that can otherwise go ahead.
    }
  }
}

/**
 * Put a finished bundle where the published one is, without ever deleting the published one
 * first.
 *
 * It was removed and then the new one renamed over the gap, outside the try that cleans up a
 * failed build, and both halves failed in practice. A process holding the published folder
 * open made the removal fail part way, which on Windows deletes every file it can and then
 * refuses the folder itself: the experience was emptied, the staging folder stayed in the
 * served tree, and the operator read a raw EBUSY naming an internal path. Two consoles
 * publishing into one folder failed the same way on most rounds measured.
 *
 * Now the published folder is moved aside by a rename, which either happens whole or not at
 * all, and the new one is renamed into its place; the old one is deleted only after that. A
 * folder that cannot be moved is left exactly as it was. A swap that loses to another publish
 * puts back what it moved, or, when the other publish's bundle is already in place, leaves that
 * one live and says so. Either way nothing of this publish is left behind, or the sentence says
 * where it was left.
 *
 * Swaps of one destination run one at a time within a process. On Windows two renames of one
 * folder to two names can both succeed, the second moving the folder from where the first put
 * it, so two publishes each believed they had set the live version aside; with a third publish
 * in between, one put back the version all three had replaced and another deleted a bundle its
 * operator had been told was published. Measured, three publishes in one process went wrong in
 * 6 rounds of 100 and two publishes never did. Across processes the same swap is
 * what decides it, and the check that the folder is where this publish put it is what notices
 * the rename that moved it.
 */
async function swapIn(staging: string, outDir: string, replacing: boolean, suffix: string): Promise<void> {
  const aside = `${outDir}.${ASIDE}${suffix}`;
  const reason = (error: unknown): string => {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code ?? (error instanceof Error ? error.message : String(error));
  };
  await mkdir(dirname(outDir), { recursive: true });
  if (replacing) {
    let moved = true;
    try {
      await rename(outDir, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new Error(
          `the published folder at ${outDir} could not be moved aside to be replaced (${reason(error)}), so it was left exactly as it was and nothing was published. Something has that folder or a file in it open; close it and publish again.${await discard(staging)}`,
        );
      }
      moved = false;
    }
    // A rename that succeeded and left nothing where it said: another publish's rename of the
    // same folder took it from here. Only nothing there means that. A look that fails some other
    // way says nothing about where the folder is, and giving up then would leave what was live
    // set aside with nothing in its place.
    if (moved)
      moved = await stat(aside).then(
        () => true,
        (error: NodeJS.ErrnoException) => error?.code !== "ENOENT",
      );
    if (!moved) {
      throw new Error(
        `another publish of ${basename(outDir)} was replacing it at the same moment, so this one was not published. Publish again if this version should be the live one.${await discard(staging)}`,
      );
    }
  }
  try {
    await rename(staging, outDir);
  } catch (error) {
    let restored = false;
    if (replacing) {
      restored = await rename(aside, outDir).then(
        () => true,
        () => false,
      );
    }
    const left = await discard(staging);
    const anotherIsLive =
      !restored &&
      (await readdir(outDir).then(
        (names) => names.includes(MARKER),
        () => false,
      ));
    if (anotherIsLive) {
      // The copy moved aside is older than the bundle now live, and is nobody's to keep.
      if (replacing) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(
        `another publish of ${basename(outDir)} finished at the same moment, and its version is the live one, so this one was not published. Publish again if this version should be the live one.${left}`,
      );
    }
    throw new Error(
      `${
        replacing && !restored
          ? `the new bundle could not be moved into ${outDir} (${reason(error)}), and the version that was live could not be put back either: it is at ${aside}. Rename it back to ${basename(outDir)} to restore it.`
          : `the new bundle could not be moved into ${outDir} (${reason(error)}), so nothing was published${replacing ? " and the version that was live is unchanged" : ""}.`
      }${left}`,
    );
  }
  if (replacing) {
    // Best effort. A copy that cannot be deleted now is swept by a later publish.
    await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Remove an unfinished bundle, saying where it was left when it could not be.
 *
 * Unguarded, a removal that failed replaced the sentence it was cleaning up after: a scanner
 * holding one freshly written file turned "nothing was published" into a raw EBUSY naming an
 * internal path, and the unfinished bundle stayed in the served tree.
 */
async function discard(staging: string): Promise<string> {
  try {
    // Retried, because what holds a new file on Windows usually lets go within a moment.
    await rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    return "";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "";
    return ` The unfinished bundle could not be removed${code === "" ? "" : ` (${code})`} and is at ${staging}; a later publish of this experience removes it once it is an hour old.`;
  }
}

/** Swaps waiting on one another, one queue per destination. */
const swaps = new Map<string, Promise<void>>();

/** Run a swap after every earlier swap of the same destination in this process. */
function inTurnForSwap<T>(outDir: string, work: () => Promise<T>): Promise<T> {
  const absolute = resolve(outDir);
  const key =
    process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
  const previous = swaps.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  swaps.set(key, settled);
  void settled.then(() => {
    if (swaps.get(key) === settled) swaps.delete(key);
  });
  return result;
}

/**
 * Refuse a target whose stored report does not say it can be printed at the width the manifest
 * declares. Everything is held to `isCurrentReport`, which the console's rebuild uses too; the
 * checks before it say which earlier build wrote a report, in words an operator can act on.
 */
function checkReadiness(
  target: { id: string; physicalWidthMm: number },
  compiled: { width?: unknown; height?: unknown; features?: unknown[]; report?: unknown },
): void {
  const report = compiled.report;
  // A report that is not an object, `null` among them, reached the checks below as a raw
  // TypeError naming a property of null.
  const fields =
    typeof report === "object" && report !== null && !Array.isArray(report)
      ? (report as Record<string, unknown>)
      : null;
  if (fields === null) {
    throw new Error(
      `${target.id} carries a print readiness report that is not one at all. Compile it again before publishing.`,
    );
  }
  // A report with no distance was written by the build whose width was computed against the
  // sensor's pixels rather than the recogniser's, so the width in it is about four times
  // too small and this comparison would pass a piece that cannot be read. A gate that is
  // four times too lenient is worse than an absent one, because it reads as a gate.
  if (!carriesItsDistance(fields)) {
    throw new Error(
      `${target.id} was compiled by an older build, whose minimum print width was too small to trust. Compile it again before publishing.`,
    );
  }
  // A report that never asked the recogniser is from the build whose readiness was inferred
  // from how often features had look-alikes, a figure that fell as a design repeated: it
  // called a sheet of sixteen identical postcards ready for press at a width where it is not
  // found. Its pass is not a pass this gate can stand behind.
  if (fields.recognition === undefined) {
    throw new Error(
      `${target.id} was compiled before readiness was checked against the recogniser, and its verdict cannot be trusted. Compile it again before publishing.`,
    );
  }
  // A report without the repetition measure is from the build that settled a design printed
  // twice by whether one look in twenty landed on the wrong copy, which turned on the export
  // width: the same postcard printed twice was ready at eleven of seventeen.
  if (typeof fields.repetition !== "object" || fields.repetition === null) {
    throw new Error(
      `${target.id} was compiled before readiness checked whether the design repeats itself, when a design printed twice could be called ready for press. Compile it again before publishing.`,
    );
  }
  // A passing report with no width has nothing for the comparison below to compare, and
  // was how a NaN width got through: written to JSON it is null, and a gate that only
  // compares numbers read that as nothing to say.
  if (fields.pass === true && !(typeof fields.minimumWidthMm === "number" && fields.minimumWidthMm > 0)) {
    throw new Error(
      `${target.id} claims to be ready for press and carries no print width, so nothing says how small it can be printed. Compile it again.`,
    );
  }
  if (!isCurrentReport(fields)) {
    throw new Error(
      `${target.id} carries a print readiness report this build does not stand behind: written by an earlier build, whose verdict could turn on a millimetre of scan distance, or edited by hand. Compile it again before publishing.`,
    );
  }
  // And the report has to be this target's, asked before its verdict and its width are read,
  // which would otherwise be another artwork's: a refused design carrying a passing report was
  // told the other design's width, and the other way round the other design's refusal. Edited
  // together, an analysed width of 1 px and the figures worked out from it made a report the
  // stored check stood behind, and a piece that needs 147 mm published declared 10 mm wide; the
  // same through the smallest size. And every landscape artwork is analysed 640 px wide at the
  // same four sizes, often with the same count of features, so the report of a design that passed
  // published on the target of one that was refused. The report carries its target's
  // fingerprint, which settles it; the console asks the same question before it shows a verdict.
  if (!describesTarget(compiled)) {
    const features = Array.isArray(compiled.features) ? compiled.features : [];
    const scaleOf = (feature: unknown) => (feature as { scale?: unknown } | null)?.scale;
    const built = new Set(features.map(scaleOf));
    const atFullSize = features.filter((feature) => scaleOf(feature) === 1).length;
    const own =
      fields.targetDigest ===
      targetDigest({ width: compiled.width, height: compiled.height, features: compiled.features });
    // A size only a passing report confirms; a refusal's is the full size, confirming nothing.
    const confirmed = fields.pass === true;
    const said = `the report says the artwork was analysed ${String(fields.analysisWidth)} px wide, with ${String(fields.featureCount)} features at full size${confirmed ? `, and confirmed at ${String(fields.smallestUsableScale)} of that` : ""}`;
    const ofTarget = [
      `the target was built ${String(compiled.width)} px wide with ${atFullSize} features at full size`,
      ...(confirmed
        ? [`${built.has(fields.smallestUsableScale) ? "has" : "has no"} features at that size`]
        : []),
      `${own ? "is" : "is not"} the target the report's fingerprint names`,
    ];
    const targetSays = `${ofTarget.slice(0, -1).join(", ")}, and ${ofTarget[ofTarget.length - 1]}`;
    throw new Error(
      `${target.id} carries a print readiness report that does not describe its own target: ${said}; ${targetSays}. Compile it again before publishing.`,
    );
  }
  // Refused before the width is looked at, because a failing report has no width: it is
  // null, and comparing against null compares nothing.
  if (!fields.pass) {
    throw new Error(
      `${target.id} did not pass its print readiness check, so it cannot be published. Compile it again and read what it says about the artwork.`,
    );
  }
  const needs = fields.minimumWidthMm as number;
  if (target.physicalWidthMm < needs) {
    throw new Error(
      `${target.id} is declared ${target.physicalWidthMm} mm wide, and its artwork needs at least ${needs} mm to be read at ${fields.scanDistanceMm} mm, the distance it was compiled for`,
    );
  }
}

/**
 * Turn a manifest and its assets into a folder that runs on its own.
 *
 * The rule the whole thing exists for is that nothing in the output reaches for the
 * network. The runtime is copied in rather than linked, assets are copied in under names
 * taken from their content, and the manifest inside the bundle points at those names. A
 * bundle written today keeps working when every service in this project is switched off,
 * which is the promise being made to anyone who prints a code on something that will
 * outlive a vendor.
 */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const validated = validateManifest(options.manifest);
  if (!validated.ok) {
    const first = validated.errors[0];
    throw new Error(`the manifest is not valid: ${first?.path ?? "/"} ${first?.message ?? "unknown"}`);
  }
  const manifest = validated.value;

  const missing = manifest.targets.filter((target) => !(target.id in options.targets));
  if (missing.length > 0) {
    // Publishing an experience whose targets were never compiled produces a bundle that
    // can never recognise anything, which is not a thing to find out from a viewer.
    throw new Error(`no compiled target was given for: ${missing.map((target) => target.id).join(", ")}`);
  }

  // This is where the compiler's answer and the manifest's claim meet, and until they did
  // an experience could be published for a piece printed smaller than the artwork can be
  // read at. The compiler works out the smallest width the mark can be printed at; the
  // manifest states the width it will actually be printed at. Nothing else in the system
  // sees both numbers.
  for (const target of manifest.targets) {
    // Read the way the published page will read it, before anything else is asked of it, so a
    // target that is not a target at all is refused with the runtime's own sentence. `null`
    // reached the report checks below and threw a TypeError naming the `in` operator.
    try {
      fromTargetFile(options.targets[target.id]);
    } catch (error) {
      throw new Error(
        `the compiled target for ${target.id} cannot be read by the runtime, so publishing it would ship a bundle that recognises nothing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const compiled = options.targets[target.id] as {
      width?: unknown;
      height?: unknown;
      features?: unknown[];
      report?: unknown;
    };
    // Nothing to recognise with. The parser accepts an empty list, because an array of zero
    // is a legal array, so a target truncated in a copy or built from artwork that produced
    // nothing publishes a bundle that points a camera at a page and can never answer.
    if (Array.isArray(compiled.features) && compiled.features.length === 0) {
      // Said for what it is. A target whose own compile found nothing is artwork too plain or too
      // soft to track, which no compile changes, and the console's card gives the compile's reason;
      // it was told to compile again, as a file that lost its features in a copy is.
      const foundNothing = isCurrentReport(compiled.report) && describesTarget(compiled);
      throw new Error(
        foundNothing
          ? `${target.id} has no features in it, so nothing in a camera frame could ever match it: its compile found none in the artwork, which is too plain or too soft to track. Compiling it again will not change that; artwork with more detail will.`
          : `${target.id} has no features in it, so nothing in a camera frame could ever match it. Compile it again.`,
      );
    }
    // A target with no report was let through, as never claimed to have been checked, and that
    // made removing one key from a target file the way past every check below: a sheet the
    // compiler refused published clean. Everything is held to `isCurrentReport`, the one
    // definition the console's rebuild also uses.
    if (compiled.report === undefined) {
      throw new Error(
        `${target.id} carries no print readiness report, so nothing says its artwork was checked against the width it is declared at. Compile it again before publishing.`,
      );
    }
    checkReadiness(target, compiled);
  }

  const assets: CopiedAsset[] = [];
  const seen = new Map<string, string>();
  const names: string[] = [];
  const result: BundleResult = { outDir: options.outDir, assets, targets: names, files: [] };

  const replacing = await mayReplace(options.outDir);

  // Built beside the destination and swapped in at the end, so a failure part way through
  // leaves whatever is published exactly as it was.
  //
  // The suffix is per publish, and that is the whole of a defect. It was
  // `${outDir}.publishing`, one path for every publish of an experience, so two at once
  // shared a staging directory: the second emptied it while the first was writing into it,
  // and the first renamed whatever survived into place. Measured over twenty-five pairs,
  // sixteen requests came back with a raw ENOENT or EPERM naming that internal directory,
  // and one pair published a folder holding four of its six entries while both operators
  // were told eight files had been written, because the count comes from what the bundler
  // meant to write rather than from what is on disk. Both other atomic writers in this
  // repository already suffix per write (`writeAtomic` in the console's workspace and the
  // link table's own write); this one did not, and a single clean run of the race is what
  // let it stand.
  //
  // Necessary and not sufficient, and the measurement is worth carrying because the
  // obvious reading of this fix is wrong. Unique staging directories on their own are
  // worse: with the shared one, one publish usually destroyed the other early enough that
  // only one reached the destination, and with one each they both reach it and collide on
  // the removal and rename there. Fourteen rounds of fourteen failed that way against
  // eight of fourteen before, and one round published nothing at all while both operators
  // were told how many files had been written. `swapIn` carries the rest.
  const suffix = randomBytes(4).toString("hex");
  const staging = `${options.outDir}.${STAGING}${suffix}`;
  await sweepLeftovers(options.outDir);
  await mkdir(staging, { recursive: true });
  try {
    await write(staging);
  } catch (error) {
    // The build's own reason first, with where its leftovers are if they could not be removed.
    const left = await discard(staging);
    if (left !== "" && error instanceof Error) error.message += left;
    throw error;
  }
  await inTurnForSwap(options.outDir, async () => {
    // Asked again in turn: a publish of the same destination that swapped in while this one was
    // building has put a bundle there, which this one now replaces rather than collides with.
    const now =
      replacing ||
      (await readdir(options.outDir).then(
        () => true,
        () => false,
      ));
    await swapIn(staging, options.outDir, now, suffix);
  });

  return result;

  async function write(into: string): Promise<void> {
    // One clock over every render in the publish, on top of the one over each. Renders
    // run one at a time and a manifest may name up to 32 drawings per target across up to
    // 64 targets, so without this a publish was bounded only at twenty seconds a drawing.
    const deadline = Date.now() + (options.renderBudgetMs ?? RENDER_BUDGET_MS);
    const rewritten = structuredClone(manifest);
    for (const target of rewritten.targets) {
      for (const item of target.content) {
        // Keyed by where the path resolves, so that `o.svg` and `./o.svg` are one render
        // and not two; content addressing already made them one file.
        const key = within(options.sourceDir, item.src);
        const already = seen.get(key);
        if (already !== undefined) {
          item.src = already;
          continue;
        }
        const copied = await copyAsset(item.src, options.sourceDir, into, { deadline });
        seen.set(key, copied.to);
        item.src = copied.to;
        // Counted by where it landed, not by what it was called. The same bytes under two
        // paths are one file in the bundle, and reporting them as two made the count the
        // command line prints disagree with the folder.
        if (!assets.some((asset) => asset.to === copied.to)) assets.push(copied);
      }
    }

    const targetDir = join(into, "targets");
    await mkdir(targetDir, { recursive: true });
    for (const target of manifest.targets) {
      // Read it the way the published page will read it, before shipping it. The page
      // calls `fromTargetFile` in the viewer's browser; without this, a target the page
      // cannot read is published successfully and fails on a phone instead, which is the
      // most expensive place to find out. A target compiled before the descriptor's
      // sampling pattern changed is exactly this case: it parses as JSON, carries the
      // right shape, and matches nothing.
      try {
        fromTargetFile(options.targets[target.id]);
      } catch (error) {
        throw new Error(
          `the compiled target for ${target.id} cannot be read by the runtime, so publishing it would ship a bundle that recognises nothing: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await writeFile(join(targetDir, `${target.id}.json`), JSON.stringify(options.targets[target.id]));
      names.push(target.id);
    }

    const runtime = await vendorRuntime(into, options.runtimeDir);
    await writeFile(join(into, "manifest.json"), JSON.stringify(rewritten, null, 2));
    await writeFile(
      join(into, "index.html"),
      entryPage({ title: manifest.title ?? manifest.id, targets: names }),
    );
    // Written last, so a folder only carries the marker once it holds a whole bundle.
    await writeFile(
      join(into, MARKER),
      `${new Date().toISOString()}
`,
    );

    result.files = [
      MARKER,
      "index.html",
      "manifest.json",
      ...names.map((name) => `targets/${name}.json`),
      ...assets.map((asset) => asset.to),
      ...runtime,
    ];
  }
}

/**
 * Copy the runtime and the two packages it loads by URL into the bundle.
 *
 * Vendored rather than fetched, because a bundle that pulls its runtime from anywhere is
 * a bundle that stops working when that anywhere does. The worker is copied under the
 * name the runtime looks for beside itself.
 */
async function vendorRuntime(outDir: string, runtimeDir?: string): Promise<string[]> {
  const source = runtimeDir ?? dirname(createRequire(import.meta.url).resolve("@taggant/runtime"));
  const into = join(outDir, "runtime");
  await mkdir(into, { recursive: true });

  // Everything the runtime build emitted, not a list of names written here. Naming them
  // meant this file had to be edited whenever that build changed shape, and forgetting
  // would publish a bundle missing a file it imports: no error here, and a page that does
  // not start on somebody's phone.
  const emitted = (await readdir(source)).filter((name) => name.endsWith(".js")).sort();
  if (!emitted.includes("index.js") || !emitted.includes("worker.js")) {
    throw new Error(
      `the runtime at ${source} does not look built: expected index.js and worker.js, found ${emitted.join(", ") || "nothing"}`,
    );
  }
  for (const name of emitted) await copyFile(join(source, name), join(into, name));

  // No separate copy of the vision core. The page rebuilds target files into tracking
  // targets and the runtime re-exports the one function that takes, so it comes from the
  // build already here rather than from a second one. The manifest validator is still not
  // shipped: it was run here, on the manifest being written, and its build imports a JSON
  // schema library a browser cannot resolve.
  return emitted.map((name) => `runtime/${name}`);
}

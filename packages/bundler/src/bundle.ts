import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { validateManifest } from "@taggant/manifest";
import { fromTargetFile } from "@taggant/vision";
import { type CopiedAsset, copyAsset } from "./assets.js";
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
}

export interface BundleResult {
  outDir: string;
  assets: CopiedAsset[];
  targets: string[];
  /** Every file written, relative to the bundle, so a publisher can see what shipped. */
  files: string[];
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
    const compiled = options.targets[target.id] as { report?: { minimumWidthMm?: number | null } };
    const needs = compiled?.report?.minimumWidthMm;
    if (typeof needs === "number" && target.physicalWidthMm < needs) {
      throw new Error(
        `${target.id} is declared ${target.physicalWidthMm} mm wide, and its artwork needs at least ${needs} mm to be read at the distance it was compiled for`,
      );
    }
  }

  const assets: CopiedAsset[] = [];
  const seen = new Map<string, string>();
  const names: string[] = [];
  const result: BundleResult = { outDir: options.outDir, assets, targets: names, files: [] };

  const replacing = await mayReplace(options.outDir);

  // Built beside the destination and swapped in at the end, so a failure part way through
  // leaves whatever is published exactly as it was.
  const staging = `${options.outDir}.publishing`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await write(staging);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  if (replacing) await rm(options.outDir, { recursive: true, force: true });
  await mkdir(dirname(options.outDir), { recursive: true });
  await rename(staging, options.outDir);

  return result;

  async function write(into: string): Promise<void> {
    const rewritten = structuredClone(manifest);
    for (const target of rewritten.targets) {
      for (const item of target.content) {
        const already = seen.get(item.src);
        if (already !== undefined) {
          item.src = already;
          continue;
        }
        const copied = await copyAsset(item.src, options.sourceDir, into);
        seen.set(item.src, copied.to);
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

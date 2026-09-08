import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { validateManifest } from "@taggant/manifest";
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
 * Make the output directory hold this bundle and nothing else.
 *
 * A published folder has to be authoritative, and it was not. Publishing again left the
 * assets of the previous publish in place, so content an author had removed went on being
 * served from its hashed address forever, and publishing into a directory that already had
 * something in it shipped that too.
 *
 * Emptying a directory is not something to do on a guess, so it is only done to a directory
 * this has published to before, which is what the marker file records. Anything else is
 * refused by name.
 */
async function prepare(outDir: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(outDir);
  } catch {
    await mkdir(outDir, { recursive: true });
    return;
  }
  if (existing.length === 0) return;
  if (!existing.includes(MARKER)) {
    throw new Error(
      `${outDir} already holds files and was not published by this tool, so it will not be emptied. Publish into a new directory, or empty this one yourself.`,
    );
  }
  for (const entry of existing) await rm(join(outDir, entry), { recursive: true, force: true });
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

  await prepare(options.outDir);

  const assets: CopiedAsset[] = [];
  const seen = new Map<string, string>();
  const rewritten = structuredClone(manifest);
  for (const target of rewritten.targets) {
    for (const item of target.content) {
      const already = seen.get(item.src);
      if (already !== undefined) {
        item.src = already;
        continue;
      }
      const copied = await copyAsset(item.src, options.sourceDir, options.outDir);
      assets.push(copied);
      seen.set(item.src, copied.to);
      item.src = copied.to;
    }
  }

  const targetDir = join(options.outDir, "targets");
  await mkdir(targetDir, { recursive: true });
  const names: string[] = [];
  for (const target of manifest.targets) {
    await writeFile(join(targetDir, `${target.id}.json`), JSON.stringify(options.targets[target.id]));
    names.push(target.id);
  }

  const runtime = await vendorRuntime(options.outDir, options.runtimeDir);
  await writeFile(
    join(options.outDir, MARKER),
    `${new Date().toISOString()}
`,
  );
  await writeFile(join(options.outDir, "manifest.json"), JSON.stringify(rewritten, null, 2));
  await writeFile(
    join(options.outDir, "index.html"),
    entryPage({ title: manifest.title ?? manifest.id, targets: names }),
  );

  return {
    outDir: options.outDir,
    assets,
    targets: names,
    files: [
      MARKER,
      "index.html",
      "manifest.json",
      ...names.map((name) => `targets/${name}.json`),
      ...assets.map((asset) => asset.to),
      ...runtime,
    ],
  };
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

  const copies: Array<[string, string]> = [
    [join(source, "index.js"), join(into, "index.js")],
    [join(source, "worker.js"), join(into, "worker.js")],
  ];
  for (const [from, to] of copies) await copyFile(from, to);

  // The page rebuilds target files into tracking targets, so that one build travels with
  // it. The validator does not: it was already run, here, on the manifest being written,
  // and its build imports a JSON schema library that a browser cannot resolve. Shipping it
  // would put a broken import in a bundle whose whole claim is that it runs on its own.
  const visionDir = dirname(createRequire(import.meta.url).resolve("@taggant/vision"));
  await copyFile(join(visionDir, "index.js"), join(into, "vision.js"));

  return ["runtime/index.js", "runtime/worker.js", "runtime/vision.js"];
}

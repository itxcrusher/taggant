import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { within } from "../src/assets.js";
import { bundle } from "../src/bundle.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = join(here, "../../runtime/dist");

const MANIFEST = {
  schemaVersion: "1.0.0",
  id: "postcard",
  title: "Postcard",
  targets: [
    {
      id: "front",
      source: "artwork.png",
      physicalWidthMm: 148,
      content: [{ type: "image", src: "overlay.svg" }],
    },
  ],
};

const TARGET = { formatVersion: 2, id: "front", width: 100, height: 100, features: [] };

async function scratch(): Promise<{ sourceDir: string; outDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "taggant-bundle-"));
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "overlay.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(sourceDir, "other.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return { sourceDir, outDir: join(root, "out") };
}

describe("bundle", () => {
  it("writes a folder holding everything the experience needs", async () => {
    const { sourceDir, outDir } = await scratch();
    const result = await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });

    const written = await readdir(outDir);
    expect(written).toContain("index.html");
    expect(written).toContain("manifest.json");
    expect(written).toContain("targets");
    expect(written).toContain("assets");
    expect(written).toContain("runtime");
    expect(result.targets).toEqual(["front"]);
  });

  it("names assets after their content, so the same bytes never land twice", async () => {
    const { sourceDir, outDir } = await scratch();
    const twice = structuredClone(MANIFEST) as typeof MANIFEST;
    twice.targets[0]?.content.push({ type: "image", src: "overlay.svg" });
    const result = await bundle({
      manifest: twice,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    expect(result.assets.length).toBe(1);
    expect(result.assets[0]?.to).toMatch(/^assets\/[0-9a-f]{16}\.svg$/);
  });

  it("rewrites the manifest inside the bundle to point at what was copied", async () => {
    const { sourceDir, outDir } = await scratch();
    await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    const written = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    expect(written.targets[0].content[0].src).toMatch(/^assets\//);
    // And the file it names is really there.
    await expect(readFile(join(outDir, written.targets[0].content[0].src))).resolves.toBeDefined();
  });

  it("carries the runtime rather than pointing at it", async () => {
    const { sourceDir, outDir } = await scratch();
    await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    const runtime = await readdir(join(outDir, "runtime"));
    // The worker is loaded by URL from beside the runtime, so it has to travel with it.
    // The validator does not travel: its build imports a JSON schema library that no
    // browser can resolve, and a bundle that ships a broken import is not self contained.
    expect(runtime.sort()).toEqual(["index.js", "vision.js", "worker.js"]);
  });

  it("refuses a manifest that does not validate", async () => {
    const { sourceDir, outDir } = await scratch();
    await expect(
      bundle({
        manifest: { schemaVersion: "1.0.0", id: "x" },
        targets: {},
        sourceDir,
        outDir,
        runtimeDir: RUNTIME_DIST,
      }),
    ).rejects.toThrow(/not valid/i);
  });

  it("refuses to publish an experience whose targets were never compiled", async () => {
    const { sourceDir, outDir } = await scratch();
    await expect(
      bundle({ manifest: MANIFEST, targets: {}, sourceDir, outDir, runtimeDir: RUNTIME_DIST }),
    ).rejects.toThrow(/no compiled target was given for: front/);
  });
});

describe("within", () => {
  it("keeps a manifest to its own directory", () => {
    expect(() => within("/srv/experience", "../../etc/passwd")).toThrow(/outside/);
    expect(() => within("/srv/experience", "nested/../../../etc/passwd")).toThrow(/outside/);
  });

  it("allows ordinary paths, including nested ones", () => {
    expect(within("/srv/experience", "overlay.svg")).toMatch(/overlay\.svg$/);
    expect(within("/srv/experience", "media/clip.mp4")).toMatch(/clip\.mp4$/);
  });
});

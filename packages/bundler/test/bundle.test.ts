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

const TARGET = { formatVersion: 3, id: "front", width: 100, height: 100, features: [] };

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

  it("refuses to publish a piece printed smaller than its artwork can be read at", async () => {
    const { sourceDir, outDir } = await scratch();
    const tooSmall = structuredClone(MANIFEST) as typeof MANIFEST;
    const first = tooSmall.targets[0];
    if (first) first.physicalWidthMm = 20;
    await expect(
      bundle({
        manifest: tooSmall,
        // The compiler says this artwork needs 70 mm; the manifest says it will be printed
        // at 20. Nothing else in the system sees both numbers.
        targets: { front: { ...TARGET, report: { minimumWidthMm: 70 } } },
        sourceDir,
        outDir,
        runtimeDir: RUNTIME_DIST,
      }),
    ).rejects.toThrow(/declared 20 mm wide, and its artwork needs at least 70 mm/);
  });

  it("publishes when the piece is wide enough", async () => {
    const { sourceDir, outDir } = await scratch();
    await expect(
      bundle({
        manifest: MANIFEST,
        targets: { front: { ...TARGET, report: { minimumWidthMm: 70 } } },
        sourceDir,
        outDir,
        runtimeDir: RUNTIME_DIST,
      }),
    ).resolves.toBeDefined();
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

  it("refuses the other ways of writing a parent step", () => {
    // A browser resolves both of these, so refusing only the plain form is a guarantee
    // that is stated and not kept.
    expect(() => within("/srv/experience", "%2e%2e/%2e%2e/secret.json")).toThrow(/outside/);
    expect(() => within("/srv/experience", String.raw`..\..\windows\win.ini`)).toThrow(/backslashes/);
    expect(() => within("/srv/experience", String.raw`\\evil.example\share\x.mp4`)).toThrow(/backslashes/);
  });

  it("allows ordinary paths, including nested ones", () => {
    expect(within("/srv/experience", "overlay.svg")).toMatch(/overlay\.svg$/);
    expect(within("/srv/experience", "media/clip.mp4")).toMatch(/clip\.mp4$/);
  });
});

describe("publishing again", () => {
  it("leaves the folder holding this bundle and nothing else", async () => {
    const { sourceDir, outDir } = await scratch();
    // Distinct content, or content addressing correctly stores the two as one.
    await writeFile(join(sourceDir, "other.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>');
    const both = structuredClone(MANIFEST) as typeof MANIFEST;
    both.targets[0]?.content.push({ type: "image", src: "other.svg" });
    await bundle({ manifest: both, targets: { front: TARGET }, sourceDir, outDir, runtimeDir: RUNTIME_DIST });
    expect((await readdir(join(outDir, "assets"))).length).toBe(2);

    // The author takes one piece of content out and publishes again.
    await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    // The withdrawn asset must not go on being served from its hashed address.
    expect((await readdir(join(outDir, "assets"))).length).toBe(1);
  });

  it("refuses a folder it did not publish, rather than emptying it", async () => {
    const { sourceDir, outDir } = await scratch();
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "someone-elses-file.txt"), "not ours");
    await expect(
      bundle({ manifest: MANIFEST, targets: { front: TARGET }, sourceDir, outDir, runtimeDir: RUNTIME_DIST }),
    ).rejects.toThrow(/was not published by this tool/);
  });

  it("does not ship files that were already sitting in the folder", async () => {
    const { sourceDir, outDir } = await scratch();
    await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    await writeFile(join(outDir, "stray.txt"), "left behind");
    await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    expect(await readdir(outDir)).not.toContain("stray.txt");
  });
});

describe("an asset referenced by a fragment", () => {
  it("bundles the file and keeps the fragment on the rewritten path", async () => {
    const { sourceDir, outDir } = await scratch();
    const sprite = structuredClone(MANIFEST) as typeof MANIFEST;
    const content = sprite.targets[0]?.content[0];
    // How one symbol in an SVG sprite is named. The schema allows it; the bundler treated
    // the whole string as a filename and could not find it.
    if (content) content.src = "overlay.svg#badge";
    await bundle({
      manifest: sprite,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    const written = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    expect(written.targets[0].content[0].src).toMatch(/^assets\/[0-9a-f]{16}\.svg#badge$/);
    // And the file the fragment points into is really there, under its name without it.
    const withoutFragment = written.targets[0].content[0].src.split("#")[0];
    await expect(readFile(join(outDir, withoutFragment))).resolves.toBeDefined();
  });
});

describe("a target the runtime could not read", () => {
  it("is refused at publish time rather than shipped to a phone", async () => {
    // Publishing is the last cheap place to find this. The page calls `fromTargetFile` in
    // the viewer's browser, so without this check a target compiled before the descriptor
    // pattern changed publishes successfully and recognises nothing on the device.
    const { sourceDir, outDir } = await scratch();
    const stale = { ...TARGET, formatVersion: 2 };
    await expect(
      bundle({ manifest: MANIFEST, targets: { front: stale }, sourceDir, outDir, runtimeDir: RUNTIME_DIST }),
    ).rejects.toThrow(/recognises nothing/);
  });

  it("names the target and the reason", async () => {
    const { sourceDir, outDir } = await scratch();
    const stale = { ...TARGET, formatVersion: 2 };
    await expect(
      bundle({ manifest: MANIFEST, targets: { front: stale }, sourceDir, outDir, runtimeDir: RUNTIME_DIST }),
    ).rejects.toThrow(/front.*format 2 is not supported/s);
  });
});

describe("what the README says a bundle is", () => {
  it("writes the number of files the README quotes", async () => {
    // The count changed when a marker file was added to make republishing safe, and the
    // README went on saying seven. It is the first command anyone runs from that page.
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
    const { sourceDir, outDir } = await scratch();
    const result = await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    expect(readme).toContain(`${result.files.length} files written to dist/postcard`);
  });
});

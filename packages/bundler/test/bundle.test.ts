import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
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

// One feature rather than none. An empty list is what every fixture here used to carry,
// and the bundler now refuses it: a target with nothing in it publishes a bundle that
// points a camera at a page and can never answer, which is worth refusing even though it
// costs every fixture a line.
const FEATURE = { x: 50, y: 50, strength: 1, angle: 0, scale: 1, descriptor: [0, 1, 2, 3, 4, 5, 6, 7] };
const TARGET = { formatVersion: 2, id: "front", width: 100, height: 100, features: [FEATURE] };

/** Every directory this file made, so the run can take them away again. */
const scratchRoots: string[] = [];

afterAll(async () => {
  // Twenty of these a run, kept for ever, is how the system temp directory reached a
  // thousand of them and a gigabyte. A test that leaves rubbish behind costs a disk.
  for (const root of scratchRoots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** A root element with a size, and a drawing filling it. */
const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c33" />';
const CLOSE = "</svg>";

/**
 * Two drawings that render to different pixels. An SVG ships as a PNG of what it draws and
 * is named by those pixels, so two files that draw the same picture land once; a fixture
 * meant to be a second asset has to look different, not only read differently.
 */
const OVERLAY = `${OPEN}${CLOSE}`;
const OTHER = `${OPEN}<circle cx="5" cy="5" r="4" fill="#36c" />${CLOSE}`;

async function scratch(): Promise<{ sourceDir: string; outDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "taggant-bundle-"));
  scratchRoots.push(root);
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "overlay.svg"), OVERLAY);
  await writeFile(join(sourceDir, "other.svg"), OTHER);
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
    // Named by the rendered pixels, and a PNG whatever the source was called.
    expect(result.assets[0]?.to).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
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
    // Whatever the runtime build emits, plus the guarantee that matters: nothing the
    // bundle imports is missing from it.
    expect(runtime).toContain("index.js");
    expect(runtime).toContain("worker.js");
    let imports = 0;
    for (const name of ["index.js", "worker.js"]) {
      const source = await readFile(join(outDir, "runtime", name), "utf8");
      for (const match of source.matchAll(/from\s*"(\.[^"]+)"/g)) {
        const relative = match[1] ?? "";
        imports++;
        expect(runtime, `${name} imports ${relative}, which is not in the bundle`).toContain(
          relative.replace(/^\.\//, ""),
        );
      }
    }
    // The loop above only says anything if there was something to follow. Relative imports
    // exist here because the runtime build splits a shared chunk out; turn that off and this
    // check would go green having read two files and compared nothing.
    expect(imports, "the runtime build emitted no relative imports, so nothing was followed").toBeGreaterThan(
      0,
    );
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
        targets: { front: { ...TARGET, report: { minimumWidthMm: 70, scanDistanceMm: 150 } } },
        sourceDir,
        outDir,
        runtimeDir: RUNTIME_DIST,
      }),
    ).rejects.toThrow(/declared 20 mm wide, and its artwork needs at least 70 mm to be read at 150 mm/);
  });

  it("publishes when the piece is wide enough", async () => {
    const { sourceDir, outDir } = await scratch();
    await expect(
      bundle({
        manifest: MANIFEST,
        targets: { front: { ...TARGET, report: { minimumWidthMm: 70, scanDistanceMm: 150 } } },
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
    // The two fixtures draw different pictures, or content addressing correctly stores
    // them as one.
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
  it("is refused, because a bundle carries no document a fragment could point into", async () => {
    const { sourceDir, outDir } = await scratch();
    const sprite = structuredClone(MANIFEST) as typeof MANIFEST;
    const content = sprite.targets[0]?.content[0];
    // How one symbol in an SVG sprite is named. The schema allows it, and a bundle once
    // carried it onto the rewritten path. An SVG now ships as a PNG, which has no symbols,
    // so the fragment would name nothing; the author hears that at publish rather than
    // shipping a path that resolves to nothing on a phone.
    if (content) content.src = "overlay.svg#badge";
    await expect(
      bundle({ manifest: sprite, targets: { front: TARGET }, sourceDir, outDir, runtimeDir: RUNTIME_DIST }),
    ).rejects.toThrow(/fragment/);
    // And it was refused before anything was written.
    await expect(readdir(outDir)).rejects.toThrow();
  });
});

describe("an SVG that carries script", () => {
  const publish = async (svg: string) => {
    const { sourceDir, outDir } = await scratch();
    await writeFile(join(sourceDir, "overlay.svg"), svg);
    const result = await bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
    return { result, outDir };
  };

  // A bundle is served by any static host, including one that sets no headers, and the
  // console takes uploads: an operator can be handed an SVG and publish it onto their own
  // domain without opening it. The runtime loads content through an img element and would
  // not run any of this; navigating straight to the asset would. So the file is not what
  // ships. It is rendered, and pixels of a drawing carry nothing that was written round it.
  // The payloads every review produced go through `nothing-reaches-out.test.ts`; these are
  // the four shapes the first version of this control was written against.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const active: [string, string][] = [
    ["a script element", `${OPEN}<script>fetch("//evil.example")</script>${CLOSE}`],
    ["an event handler", `${OPEN}<rect width="10" height="10" onload="fetch(1)" />${CLOSE}`],
    [
      "a javascript: link",
      `${OPEN}<a href="javascript:alert(1)"><rect width="10" height="10" /></a>${CLOSE}`,
    ],
    ["a foreignObject", `${OPEN}<foreignObject><b>x</b></foreignObject>${CLOSE}`],
  ];
  for (const [what, svg] of active) {
    it(`ships ${what} as pixels of the drawing and nothing else`, async () => {
      const { result, outDir } = await publish(svg);
      expect(result.assets.map((asset) => asset.to)).toEqual([
        expect.stringMatching(/^assets\/[0-9a-f]{16}\.png$/),
      ]);
      const written = await readFile(join(outDir, result.assets[0]?.to ?? ""));
      expect(written.subarray(0, 8)).toEqual(PNG);
      expect(written.toString("latin1")).not.toMatch(/evil\.example|fetch|alert|foreignObject/);
      expect(await readdir(join(outDir, "assets"))).not.toContainEqual(expect.stringMatching(/\.svg$/));
    });
  }

  it("publishes an ordinary drawing, including one that says the word script", async () => {
    // Nothing is refused for a word appearing. The text of the file is never what decides.
    const { result } = await publish(
      `${OPEN}<title>A script of the play</title><!-- <script>once, in a comment</script> --><path d="M0 0h10v10H0z" />${CLOSE}`,
    );
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.to).toMatch(/\.png$/);
  });
});

describe("what an SVG declares as its size", () => {
  const publish = async (svg: string) => {
    const { sourceDir, outDir } = await scratch();
    await writeFile(join(sourceDir, "overlay.svg"), svg);
    return bundle({
      manifest: MANIFEST,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
    });
  };

  it("does not decide how large it is rendered", async () => {
    // A drawing declared across a hundred thousand units, as a poster in tenths of a
    // millimetre might be, renders at the same size as a label of ten. Read at its declared
    // size it would exceed the renderer's pixel limit and be refused for being large.
    const result = await publish(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000"><rect width="100000" height="100000" fill="#c33" /></svg>',
    );
    expect(result.assets[0]?.to).toMatch(/\.png$/);
  });

  // What a size is refused for, and what an author is told, is in `what-ships.test.ts`,
  // which drives the decision and the render without the cost of a publish each time.
});

describe("how long a publish may spend rendering", () => {
  it("is bounded for the publish and not only for each drawing", async () => {
    // The clock on a render bounds a drawing. Renders run one at a time and a manifest may
    // name up to 32 drawings per target, so before this a publish was bounded at twenty
    // seconds multiplied by however many content items somebody wrote, and thirty ordinary
    // drawings took three minutes. The console answers a publish over HTTP with no timeout
    // of its own, so that number is how long an operator waits on a page.
    const { sourceDir, outDir } = await scratch();
    const many = structuredClone(MANIFEST) as typeof MANIFEST;
    many.targets[0]?.content.push({ type: "image", src: "other.svg" });
    await expect(
      bundle({
        manifest: many,
        targets: { front: TARGET },
        sourceDir,
        outDir,
        runtimeDir: RUNTIME_DIST,
        renderBudgetMs: 1,
      }),
    ).rejects.toThrow(/render budget/);
    // And nothing was published: the staging directory goes with the refusal.
    await expect(readdir(outDir)).rejects.toThrow();
  }, 60_000);

  it("renders one drawing once, however many ways the manifest spells its path", async () => {
    // Content addressing made two spellings one file, so this was invisible in the output
    // and paid for twice in the render: the cache was keyed on the string in the manifest.
    const { sourceDir, outDir } = await scratch();
    const twice = structuredClone(MANIFEST) as typeof MANIFEST;
    twice.targets[0]?.content.push({ type: "image", src: "./overlay.svg" });
    const started = Date.now();
    const result = await bundle({
      manifest: twice,
      targets: { front: TARGET },
      sourceDir,
      outDir,
      runtimeDir: RUNTIME_DIST,
      // Enough for one render on a loaded machine and not for two, which is what makes
      // this a test of the count rather than of the folder.
      renderBudgetMs: 15_000,
    });
    expect(result.assets).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    const written = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    expect(written.targets[0].content[0].src).toBe(written.targets[0].content[1].src);
  }, 60_000);
});

describe("a target the runtime could not read", () => {
  it("is refused at publish time rather than shipped to a phone", async () => {
    // Publishing is the last cheap place to find this. The page calls `fromTargetFile` in
    // the viewer's browser, so without this check a target the page cannot read publishes
    // successfully and shows nothing on the device: a target from an older format, one
    // written half way, or one edited by hand.
    const { sourceDir, outDir } = await scratch();
    const stale = { ...TARGET, formatVersion: 1 };
    await expect(
      bundle({ manifest: MANIFEST, targets: { front: stale }, sourceDir, outDir, runtimeDir: RUNTIME_DIST }),
    ).rejects.toThrow(/recognises nothing/);
  });

  it("names the target and the reason", async () => {
    const { sourceDir, outDir } = await scratch();
    const stale = { ...TARGET, formatVersion: 1 };
    await expect(
      bundle({ manifest: MANIFEST, targets: { front: stale }, sourceDir, outDir, runtimeDir: RUNTIME_DIST }),
    ).rejects.toThrow(/front.*format 1 is not supported/s);
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

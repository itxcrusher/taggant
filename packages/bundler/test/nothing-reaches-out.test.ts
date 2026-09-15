import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bundle } from "../src/bundle.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../..");
const RUNTIME_DIST = join(here, "../../runtime/dist");

/**
 * "Nothing in it reaches for the network", which the README says and nothing checked.
 *
 * The README also described this test as already existing: "a second test reads every file
 * the bundle ships and refuses an absolute address in any of them". It did not exist. Writing
 * it found the defect it was supposed to be guarding, which is the best argument there is for
 * treating a claim in a document as a test that has not been written yet.
 *
 * The defect: an SVG carrying `<image href="https://somewhere/else.png">` is not script, runs
 * nothing, and passed every check the bundler had. It is fetched anyway, on every scan, by
 * every reader. The tool printed "It needs nothing else" over a folder containing one.
 */
describe("a published bundle", () => {
  const scratches: string[] = [];
  afterAll(async () => {
    for (const dir of scratches.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const TARGET = {
    formatVersion: 2,
    id: "front",
    width: 640,
    height: 452,
    features: [{ x: 50, y: 50, strength: 1, angle: 0, scale: 1, descriptor: [0, 1, 2, 3, 4, 5, 6, 7] }],
    report: { minimumWidthMm: 100, pass: true, scanDistanceMm: 190 },
  };

  const manifestFor = (src: string) => ({
    schemaVersion: "1.0.0",
    id: "probe",
    title: "Probe",
    targets: [
      { id: "front", source: "artwork.png", physicalWidthMm: 148, content: [{ type: "image", src }] },
    ],
  });

  async function workspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "taggant-network-"));
    scratches.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "artwork.png"),
      await readFile(join(REPO, "examples/postcard/artwork.png")),
    );
    await writeFile(
      join(dir, "src", "overlay.svg"),
      await readFile(join(REPO, "examples/postcard/overlay.svg")),
    );
    return dir;
  }

  /** Every file in the folder, at every depth. */
  async function everyFile(root: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) out.push(...(await everyFile(path)));
      else out.push(path);
    }
    return out;
  }

  it("fetches nothing from the network in any file it ships", async () => {
    // Written deliberately differently from the rule it is checking. The first version of
    // this scanned with a copy of the implementation's own regular expression, so every
    // bypass of that expression passed here too: it agreed with the code rather than with
    // the claim, which is the exact shape of the defect this whole month has been about.
    //
    // This looks for a host instead. Anything that names one, in any spelling, has to be
    // accounted for: a namespace, which is an identifier a browser never requests, or the
    // fallback the author wrote into the manifest, which is a destination for a reader and
    // not a resource the page loads.
    const dir = await workspace();
    const out = join(dir, "bundle");
    const manifest = {
      ...manifestFor("overlay.svg"),
      // Included on purpose: a bundle that declares one is the case the claim has to survive.
      fallback: "https://example.org/where-this-goes",
    };
    await bundle({
      manifest,
      targets: { front: TARGET },
      sourceDir: join(dir, "src"),
      outDir: out,
      runtimeDir: RUNTIME_DIST,
    });

    const files = await everyFile(out);
    expect(files.length, "the bundle shipped nothing").toBeGreaterThan(5);
    const unaccounted: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      for (const found of text.matchAll(
        /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+|(?<![a-z:])\/\/[a-z0-9][^\s"'<>)]*/gi,
      )) {
        const address = found[0];
        const at = found.index ?? 0;
        // An XML namespace: the address is the value of an xmlns attribute.
        const before = text.slice(Math.max(0, at - 80), at);
        if (/xmlns(:[a-z0-9-]+)?\s*=\s*["']?$/i.test(before)) continue;
        // The fallback the author declared, which the runtime navigates to and never fetches.
        if (address.startsWith(manifest.fallback)) continue;
        unaccounted.push(`${file.slice(out.length + 1)}: ${address}`);
      }
    }
    expect(unaccounted, `the bundle reaches for the network: ${unaccounted.join(", ")}`).toEqual([]);
  }, 60_000);

  it("is refused outright when an asset would fetch from somewhere else", async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, "src", "beacon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<image href="https://tracker.example.net/beacon.png" width="10" height="10"/>' +
        "</svg>",
    );
    await expect(
      bundle({
        manifest: manifestFor("beacon.svg"),
        targets: { front: TARGET },
        sourceDir: join(dir, "src"),
        outDir: join(dir, "bundle"),
        runtimeDir: RUNTIME_DIST,
      }),
      "an SVG that fetches a remote image was published",
    ).rejects.toThrow(/href="https:\/\/tracker\.example\.net[^"]*", which is not inside the bundle/);
  }, 60_000);

  it("still publishes an SVG whose only absolute address is its own namespace", async () => {
    // The check has to tell a namespace from a fetch, or the example's own overlay stops
    // publishing and the rule is useless.
    const dir = await workspace();
    const result = await bundle({
      manifest: manifestFor("overlay.svg"),
      targets: { front: TARGET },
      sourceDir: join(dir, "src"),
      outDir: join(dir, "bundle"),
      runtimeDir: RUNTIME_DIST,
    });
    expect(result.assets.some((asset) => asset.to.endsWith(".svg"))).toBe(true);
  }, 60_000);

  it("refuses every kind of SVG the README says it refuses, by reading the list off the README", async () => {
    // The README names five things. A list in prose is a promise nobody kept: the fifth was
    // added to that sentence at the same moment the check behind it was, and the other four
    // had been there for weeks with nothing tying them to the code. So the list is read out
    // of the document and each item is actually attempted.
    const readme = await readFile(join(REPO, "README.md"), "utf8");
    const sentence = readme.match(/An SVG carrying ([^.]+) is refused by name\./)?.[1];
    expect(sentence, "the README no longer lists what an SVG may not carry").toBeDefined();

    // What each named item looks like in a file, and the words the bundler answers with.
    const shapes: Array<{ named: RegExp; svg: string; refusedAs: RegExp }> = [
      { named: /script element/, svg: "<script>1</script>", refusedAs: /<script> element/ },
      { named: /event handler/, svg: '<rect onload="1" width="1" height="1"/>', refusedAs: /onload handler/ },
      {
        named: /javascript:/,
        svg: '<a href="javascript:1"><rect width="1" height="1"/></a>',
        refusedAs: /href="javascript:/,
      },
      {
        named: /foreignObject/,
        svg: "<foreignObject><p>x</p></foreignObject>",
        refusedAs: /<foreignObject> element/,
      },
      {
        named: /reference to another host/,
        svg: '<image href="https://tracker.example.net/b.png" width="1" height="1"/>',
        refusedAs: /which is not inside the bundle/,
      },
    ];

    let matched = 0;
    for (const shape of shapes) {
      if (!shape.named.test(sentence ?? "")) continue;
      matched++;
      const dir = await workspace();
      const name = `case-${matched}.svg`;
      await writeFile(
        join(dir, "src", name),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${shape.svg}</svg>`,
      );
      await expect(
        bundle({
          manifest: manifestFor(name),
          targets: { front: TARGET },
          sourceDir: join(dir, "src"),
          outDir: join(dir, "bundle"),
          runtimeDir: RUNTIME_DIST,
        }),
        `the README says an SVG carrying this is refused, and it published: ${shape.svg}`,
      ).rejects.toThrow(shape.refusedAs);
    }
    // Every item the sentence names has to be one of the shapes above, or the list has grown
    // a promise with nothing attempting it.
    const named = (sentence ?? "").split(/,| or /).filter((part) => part.trim().length > 0);
    expect(matched, `the README names ${named.length} things and only ${matched} were attempted`).toBe(
      named.length,
    );
  }, 120_000);

  it("refuses a protocol-relative reference too, which is the same fetch written shorter", async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, "src", "sneaky.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<image href="//tracker.example.net/beacon.png" width="10" height="10"/>' +
        "</svg>",
    );
    await expect(
      bundle({
        manifest: manifestFor("sneaky.svg"),
        targets: { front: TARGET },
        sourceDir: join(dir, "src"),
        outDir: join(dir, "bundle"),
        runtimeDir: RUNTIME_DIST,
      }),
      "a protocol-relative reference was published",
    ).rejects.toThrow(/which is not inside the bundle/);
  }, 60_000);
});

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The README prints terminal output and invites the reader to run it.
 *
 * Every block like that is a test nobody wrote. The compiler's two were pinned after one of
 * them turned out to name a file that is not in the repository and to quote an analysis size
 * the loader cannot produce; these two were not, and they are the same shape. The bundler's
 * block carries a content hash and a byte count, which drift silently the moment an asset or
 * the hashing changes, and the bench's block carries the figure this project uses to decide
 * whether a change to recognition helped.
 *
 * Both tools are run here rather than reasoned about. The bench is deterministic, checked by
 * running it twice and comparing, and takes about half a minute.
 */
describe("what the README says these tools print", () => {
  const scratches: string[] = [];
  afterAll(async () => {
    for (const dir of scratches.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("is what the bundler prints, hash and byte count included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taggant-readme-"));
    scratches.push(dir);
    await run("node", [
      join(REPO, "packages/compiler/dist/cli.js"),
      join(REPO, "examples/postcard/artwork.png"),
      "--id",
      "front",
      "--scan-distance",
      "190",
      "--out",
      join(dir, "front.target.json"),
    ]);
    const { stdout } = await run("node", [
      join(REPO, "packages/bundler/dist/cli.js"),
      join(REPO, "examples/postcard/manifest.json"),
      "--target",
      `front=${join(dir, "front.target.json")}`,
      "--out",
      join(dir, "bundle"),
    ]);

    const readme = await readFile(join(REPO, "README.md"), "utf8");
    // The asset line names a file by the hash of the pixels the SVG rendered to and states
    // their size. Both are exactly the kind of figure that goes stale without anyone
    // noticing, and both hold on every machine only because the example's lettering is
    // outlines rather than text set in whatever font the machine has.
    const asset = stdout.match(/overlay\.svg -> assets\/[0-9a-f]+\.png \(\d+ bytes\)/)?.[0];
    expect(asset, `the bundler no longer prints an asset line: ${stdout}`).toBeDefined();
    expect(readme, `the README does not say: ${asset}`).toContain(asset ?? "");

    const files = stdout.match(/(\d+) files written/)?.[1];
    expect(readme, `the README does not say ${files} files written`).toContain(`${files} files written`);
  }, 120_000);

  it("is what the recognition bench prints, including the figure changes are judged by", async () => {
    // Deterministic: two runs compared byte for byte before this was written. If it ever
    // stops being so, this fails rather than flaking quietly, because the README states
    // exact counts.
    const { stdout } = await run("node", [join(REPO, "packages/vision/bench/recognition.mjs")], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const readme = await readFile(join(REPO, "README.md"), "utf8");

    const claims = [
      stdout.match(/\d+ images x \d+ conditions = \d+ trials/)?.[0],
      stdout.match(/found\s+\d+ of \d+ \([\d.]+%\)/)?.[0],
      stdout.match(/wrong pose taken \d+/)?.[0],
      stdout.match(/corner error\s+median [\d.]+ px, mean [\d.]+ px/)?.[0],
    ];
    for (const claim of claims) {
      expect(claim, `the bench no longer prints one of the lines the README quotes: ${stdout}`).toBeDefined();
      expect(readme, `the README does not say: ${claim}`).toContain(claim ?? "");
    }

    // And the per-condition rows the block shows, which are the ones that say where it is
    // weak. A block that quoted only the total could hide every condition moving at once.
    for (const condition of ["scale 0.45", "rotated 135", "noise 30", "worst case"]) {
      const row = stdout.match(new RegExp(`${condition.replace(".", "\\.")}\\s+[#.]+ \\d+/\\d+`))?.[0];
      expect(row, `the bench no longer reports ${condition}`).toBeDefined();
      const score = row?.match(/\d+\/\d+$/)?.[0];
      expect(readme, `the README does not show ${condition} at ${score}`).toMatch(
        new RegExp(`${condition.replace(".", "\\.")}\\s+[#.]+ ${score}`),
      );
    }
  }, 180_000);

  it("states the corner tolerances the recognition tests are actually written to", async () => {
    // "Recognition is measured against known mappings rather than asserted ... under 4 px
    // square on, under 6 px turned on its side, under 8 px held at an angle."
    //
    // That is a claim about how strict the tests are, so the only thing that can check it is
    // the tests. Loosening a threshold to make a change pass would leave the README claiming
    // a rigour the suite no longer has, and on a project whose argument is that it measures
    // rather than asserts, that is the sentence least able to afford being wrong.
    const readme = await readFile(join(REPO, "README.md"), "utf8");
    const source = await readFile(join(REPO, "packages/vision/test/locate.test.ts"), "utf8");

    // Each case, by the name it is written under, and the tolerance its assertion uses.
    const cases: Array<[string, string]> = [
      ["finds artwork in a plain view of it", "square on"],
      ["finds it turned on its side", "turned on its side"],
      ["finds it held at an angle", "held at an angle"],
    ];
    let checked = 0;
    for (const [testName, phrase] of cases) {
      const body = source.slice(source.indexOf(testName));
      const tolerance = body.match(/cornerError\([^)]*\)\)\.toBeLessThan\((\d+)\)/)?.[1];
      expect(tolerance, `no corner tolerance found for the case "${testName}"`).toBeDefined();
      checked++;
      expect(readme, `the README says something other than under ${tolerance} px ${phrase}`).toContain(
        `under ${tolerance} px ${phrase}`,
      );
    }
    expect(checked, "no recognition cases were found to check").toBe(cases.length);
  }, 60_000);

  it("is what the runtime actually weighs in a published bundle", async () => {
    // "about 45 KB across three files that share one chunk". A reader on a phone having just
    // scanned something printed is the whole reason that sentence is there, so it is worth
    // failing when it stops being true rather than when someone notices.
    const dir = await mkdtemp(join(tmpdir(), "taggant-readme-"));
    scratches.push(dir);
    await run("node", [
      join(REPO, "packages/compiler/dist/cli.js"),
      join(REPO, "examples/postcard/artwork.png"),
      "--id",
      "front",
      "--scan-distance",
      "190",
      "--out",
      join(dir, "front.target.json"),
    ]);
    await run("node", [
      join(REPO, "packages/bundler/dist/cli.js"),
      join(REPO, "examples/postcard/manifest.json"),
      "--target",
      `front=${join(dir, "front.target.json")}`,
      "--out",
      join(dir, "bundle"),
    ]);

    const { readdir, stat } = await import("node:fs/promises");
    const runtimeDir = join(dir, "bundle", "runtime");
    const names = await readdir(runtimeDir);
    let bytes = 0;
    for (const name of names) bytes += (await stat(join(runtimeDir, name))).size;

    const readme = await readFile(join(REPO, "README.md"), "utf8");
    // The count is written out in words, because the sentence is prose and not a table.
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const claim = readme.match(/about (\d+) KB across (\w+) files/);
    const stated = Number(claim?.[1]);
    const statedFiles = words[claim?.[2] ?? ""] ?? Number(claim?.[2]);
    expect(stated, "the README no longer states a runtime size").toBeGreaterThan(0);
    expect(statedFiles, "the README no longer states how many runtime files").toBeGreaterThan(0);
    expect(names.length, `the bundle ships ${names.length} runtime files, not ${statedFiles}`).toBe(
      statedFiles,
    );
    // Within two kilobytes of the stated figure. "About" is not a licence to drift.
    expect(
      Math.abs(bytes / 1024 - stated),
      `the runtime is ${(bytes / 1024).toFixed(1)} KB where the README says about ${stated}`,
    ).toBeLessThan(2);
  }, 120_000);
});

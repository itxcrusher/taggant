import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@taggant/manifest";
import { describe, expect, it } from "vitest";
import { compileTarget } from "../src/compile.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/postcard");

/**
 * The example in the repository is the one the documentation quotes, so it is checked
 * here rather than trusted. An example that has rotted is worse than none: it is the first
 * thing anyone runs, and it fails on their machine rather than in the build.
 */
describe("the postcard example", () => {
  it("has a manifest this repository's own validator accepts", async () => {
    const manifest = JSON.parse(await readFile(join(EXAMPLE, "manifest.json"), "utf8"));
    const result = validateManifest(manifest);
    if (!result.ok) throw new Error(result.errors.map((e) => `${e.path} ${e.message}`).join("; "));
    expect(result.value.targets.length).toBe(1);
  });

  it("has artwork that passes its own print readiness check", async () => {
    const target = await compileTarget(await readFile(join(EXAMPLE, "artwork.png")), {
      id: "front",
      scanDistanceMm: 350,
    });
    expect(target.report.pass).toBe(true);
    expect(target.report.score).toBe(100);
  });

  it("asks for a print no wider than the postcard the manifest declares", async () => {
    const manifest = JSON.parse(await readFile(join(EXAMPLE, "manifest.json"), "utf8"));
    const declared = manifest.targets[0].physicalWidthMm;
    const target = await compileTarget(await readFile(join(EXAMPLE, "artwork.png")), {
      id: "front",
      scanDistanceMm: 350,
    });
    // The point of the example is that these two numbers agree. If the artwork or the
    // thresholds move far enough that they stop agreeing, the example is telling a story
    // the tool no longer supports.
    expect(target.report.minimumWidthMm).not.toBeNull();
    expect(target.report.minimumWidthMm ?? 0).toBeLessThan(declared);
  });

  it("asks for the width the README says it asks for", async () => {
    // The README quotes this figure and invites the reader to check it. It quoted the
    // numbers from an earlier analysis raster for a while: 296 px and 65 mm against a tool
    // that says 320 and 70. A figure in a document that invites checking has to be checked
    // by something other than whoever wrote it down.
    const readme = await readFile(join(EXAMPLE, "../../README.md"), "utf8");
    const target = await compileTarget(await readFile(join(EXAMPLE, "artwork.png")), {
      id: "front",
      scanDistanceMm: 350,
    });
    const across = Math.round(target.report.smallestUsableScale * target.report.analysisWidth);
    expect(readme).toContain(`needs ${across} px across and so ${target.report.minimumWidthMm} mm at 350 mm`);
  });

  it("quotes the whole compile in the example README, not only the width", async () => {
    // The previous round pinned the width line and the repetition line went stale anyway,
    // in two files, and was caught by reading rather than by anything running. The example
    // README prints the compiler's output verbatim, so every line of it is a claim.
    const readme = await readFile(join(EXAMPLE, "README.md"), "utf8");
    const target = await compileTarget(await readFile(join(EXAMPLE, "artwork.png")), {
      id: "front",
      scanDistanceMm: 350,
    });
    const report = target.report;
    const across = Math.round(report.smallestUsableScale * report.analysisWidth);
    const repetition = Math.round((report.repetition ?? 0) * 100);
    for (const line of [
      `size                  ${target.width} x ${target.height} px`,
      `tracking quality      ${report.score} / 100`,
      `features              ${report.featureCount}, reaching ${report.areasWithFeatures} of ${report.areas} areas`,
      `minimum print width   ${report.minimumWidthMm} mm to be read from 350 mm away, being ${across} px across the artwork`,
      `repeated detail       ${repetition}% of features have a look-alike`,
    ]) {
      expect(readme, `the README does not say: ${line}`).toContain(line);
    }
  });

  it("names files that exist", async () => {
    const manifest = JSON.parse(await readFile(join(EXAMPLE, "manifest.json"), "utf8"));
    for (const target of manifest.targets) {
      await expect(readFile(join(EXAMPLE, target.source))).resolves.toBeDefined();
      for (const item of target.content) {
        await expect(readFile(join(EXAMPLE, item.src))).resolves.toBeDefined();
      }
    }
  });
});

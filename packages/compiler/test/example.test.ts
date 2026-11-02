import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@taggant/manifest";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { formatReportLines } from "../src/cli.js";
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
      scanDistanceMm: 190,
    });
    expect(target.report.pass).toBe(true);
    expect(target.report.score).toBe(100);
  });

  it("asks for a print no wider than the postcard the manifest declares", async () => {
    const manifest = JSON.parse(await readFile(join(EXAMPLE, "manifest.json"), "utf8"));
    const declared = manifest.targets[0].physicalWidthMm;
    const target = await compileTarget(await readFile(join(EXAMPLE, "artwork.png")), {
      id: "front",
      scanDistanceMm: 190,
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
      scanDistanceMm: 190,
    });
    const across = target.report.recognition?.pixelsAcross;
    expect(readme).toContain(
      `is found at ${across} px across and so needs ${target.report.minimumWidthMm} mm at 190 mm`,
    );
  });

  it("quotes the whole compile in both READMEs, not only the width", async () => {
    // With only the width line pinned, the repetition line went stale in two files and was
    // caught by reading rather than by anything running. Both READMEs print the compiler's
    // output verbatim, so every line of it is a claim, in each of them.
    const target = await compileTarget(await readFile(join(EXAMPLE, "artwork.png")), {
      id: "front",
      scanDistanceMm: 190,
    });
    // Every line the command line prints, taken from its own formatter, so a line added to the
    // output is a line the READMEs have to carry too.
    const lines = formatReportLines("artwork.png", target).filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(6);
    for (const file of [join(EXAMPLE, "README.md"), join(EXAMPLE, "../../README.md")]) {
      const readme = await readFile(file, "utf8");
      for (const line of lines) {
        expect(readme, `${file} does not say: ${line}`).toContain(line);
      }
    }
  });

  it("quotes the compiler correctly on the project page, which nothing else checks", async () => {
    // These are printed under the lamp on `site/index.html`, and the page invites the
    // reader to check them against the tool. Six figures with nothing running over them:
    // the repetition one went stale there once already and was caught by grep.
    const page = await readFile(join(EXAMPLE, "../../site/index.html"), "utf8");
    const target = await compileTarget(await readFile(join(EXAMPLE, "artwork.png")), {
      id: "front",
      scanDistanceMm: 190,
    });
    const report = target.report;
    const seen = report.recognition;
    for (const claim of [
      `COMPILED ${target.width} x ${target.height} px`,
      `tracking quality ${report.score} / 100`,
      `${report.featureCount} features, ${report.areasWithFeatures} of ${report.areas} areas`,
      `min width ${report.minimumWidthMm} mm to read at 190 mm`,
      `recognised: ${seen?.widthsAgreed} of ${seen?.widths} widths, every turn ${seen?.needed}+`,
      report.pass ? "VERDICT READY FOR PRESS" : "VERDICT NOT READY",
    ]) {
      expect(page, `the project page does not say: ${claim}`).toContain(claim);
    }
    // The sentence about the page, in the README, is a claim too, and the check above does
    // not reach it: it compares the page against the compiler, so the two agreed with each
    // other while the README went on naming a reading distance neither of them used.
    const readme = await readFile(join(EXAMPLE, "../../README.md"), "utf8");
    expect(readme, "the README names a different reading distance than the page it describes").toContain(
      `for \`examples/postcard/artwork.png\` at a ${report.scanDistanceMm} mm reading distance`,
    );

    // The page draws one mark per feature. Drawn and stated have to agree, because a
    // reader counts the claim and sees the drawing.
    const marks = page.match(/for \((?:let|var) j = 0; j < (\d+); j\+\+\)/)?.[1];
    expect(marks, "the loop drawing the feature marks was not found on the page").toBeDefined();
    expect(Number(marks)).toBe(report.featureCount);
  });

  it("is compiled at a distance it can be read from everywhere that compiles it", async () => {
    // The distance the example is compiled at lives in the workflows, in the infra recipe
    // and in the container smoke script, and nothing bound any of them to the width the
    // manifest declares. Both workflows compiled it at 350 mm, where this postcard needs
    // 270 and the manifest says 148, so the bundler refused and the stack job went red on
    // a push whose whole local gate was green. Fixing the workflows left the smoke script
    // at 350 with a 120 mm panel, and the next push went red in the same way. The suite
    // could not see either, because the suite does not run the workflows or the stack.
    //
    // So the files are read here. What is checked is the one thing that makes the pair
    // legal: the piece has to be at least as wide as the artwork needs at that distance,
    // which is exactly the comparison the bundler refuses on.
    const root = join(EXAMPLE, "../..");
    const manifest = JSON.parse(await readFile(join(EXAMPLE, "manifest.json"), "utf8"));
    const artwork = await readFile(join(EXAMPLE, "artwork.png"));

    // Kept per distance. Four places name a distance and only two distinct values among
    // them, and compiling this artwork is about a second each, which put the test over the
    // default budget under load.
    const seen = new Map<number, number>();
    const needsAt = async (distance: number) => {
      const already = seen.get(distance);
      if (already !== undefined) return already;
      const report = (await compileTarget(artwork, { id: "front", scanDistanceMm: distance })).report;
      expect(report.pass, `the example does not pass at ${distance} mm`).toBe(true);
      const needs = report.minimumWidthMm ?? Number.POSITIVE_INFINITY;
      seen.set(distance, needs);
      return needs;
    };

    let checked = 0;
    // Everything that runs the command line against this artwork and then bundles it. The
    // piece is whatever the example manifest declares.
    for (const file of [".github/workflows/ci.yml", ".github/workflows/pages.yml", "infra/README.md"]) {
      const text = await readFile(join(root, file), "utf8");
      for (const match of text.matchAll(/--scan-distance\s+(\d+)/g)) {
        checked++;
        const distance = Number(match[1]);
        const needs = await needsAt(distance);
        expect(
          needs,
          `${file} compiles the example at ${distance} mm, where it needs ${needs} mm and the manifest declares ${manifest.targets[0].physicalWidthMm}. The bundler refuses that.`,
        ).toBeLessThanOrEqual(manifest.targets[0].physicalWidthMm);
      }
    }

    // And the container smoke script, which uploads the same artwork under a width of its
    // own and then publishes it through the console.
    const smoke = await readFile(join(root, "infra/authoring-smoke.mjs"), "utf8");
    const declared = Number(smoke.match(/"physicalWidthMm",\s*"(\d+)"/)?.[1]);
    const distance = Number(smoke.match(/scanDistanceMm:\s*"(\d+)"/)?.[1]);
    expect(declared, "the smoke script no longer declares a printed width").toBeGreaterThan(0);
    expect(distance, "the smoke script no longer names a scan distance").toBeGreaterThan(0);
    checked++;
    const needs = await needsAt(distance);
    expect(
      needs,
      `infra/authoring-smoke.mjs uploads a ${declared} mm piece and compiles at ${distance} mm, where it needs ${needs} mm. The publish it does three checks later fails.`,
    ).toBeLessThanOrEqual(declared);

    // A regex that matched nothing would pass every assertion above without running one.
    expect(checked, "nothing was found compiling the example").toBeGreaterThan(3);
  }, 30_000);

  it("measures the postcard printed twice the way its README says", async () => {
    // A figure in a README is a test that has not been written: this one is quoted in prose,
    // where nothing comparing output blocks reaches it.
    const readme = await readFile(join(EXAMPLE, "README.md"), "utf8");
    const one = await sharp(join(EXAMPLE, "artwork.png"))
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = one.info;
    const stacked = Buffer.alloc(width * height * 2);
    one.data.copy(stacked, 0);
    one.data.copy(stacked, width * height);
    const twice = await sharp(stacked, { raw: { width, height: height * 2, channels: 1 } })
      .png()
      .toBuffer();
    const report = (await compileTarget(twice, { id: "twice", scanDistanceMm: 190 })).report;
    expect(report.pass).toBe(false);
    expect(readme).toContain(
      `it is ${report.repetition?.places} of ${report.repetition?.of}, more than a third`,
    );
    expect((report.repetition?.places ?? 0) / (report.repetition?.of ?? 1)).toBeGreaterThan(1 / 3);
    expect(report.reasons.join(" ")).toContain("shifting it 71 per cent of its width down");
  });

  it("prints, for the artwork it refuses, exactly what the README says it prints", async () => {
    // The README shows a failing run beside the passing one, and only the passing one was
    // ever checked. The failing block named a file that is not in the repository, claimed
    // an analysis size the loader cannot produce (it fits the longest edge to 640, and the
    // block said 800 x 600), and omitted the repeated-detail line the formatter always
    // emits. None of that could be caught by comparing documents, because there was no
    // second document: the figures were written by hand and never run.
    const readme = await readFile(join(EXAMPLE, "../../README.md"), "utf8");
    const target = await compileTarget(await readFile(join(EXAMPLE, "../wordmark.png")), {
      id: "wordmark",
      scanDistanceMm: 190,
    });
    const report = target.report;
    expect(report.pass, "the artwork the README shows being refused now passes").toBe(false);
    const lines = formatReportLines("wordmark.png", target).filter((line) => line.trim() !== "");
    expect(lines).toContain("  verdict               not ready");
    for (const line of lines) {
      expect(readme, `the README does not say: ${line}`).toContain(line);
    }
  });

  it("names files that exist", async () => {
    const manifest = JSON.parse(await readFile(join(EXAMPLE, "manifest.json"), "utf8"));
    let named = 0;
    for (const target of manifest.targets) {
      named++;
      await expect(readFile(join(EXAMPLE, target.source))).resolves.toBeDefined();
      for (const item of target.content) {
        named++;
        await expect(readFile(join(EXAMPLE, item.src))).resolves.toBeDefined();
      }
    }
    // A manifest with no targets, or a target with no content, names no files and would
    // pass this without opening one.
    expect(named, "the manifest named no files, so none were opened").toBeGreaterThan(1);
  });
});

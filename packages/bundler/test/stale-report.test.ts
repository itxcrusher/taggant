import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, describesTarget, isCurrentReport, targetDigest } from "@taggant/compiler";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { bundle } from "../src/bundle.js";
import {
  currentFeatures,
  currentReport,
  refusalFor,
  reportAskingFor,
  reportDifferingIn,
} from "./current-report.js";

const RUNTIME_DIST = join(dirname(fileURLToPath(import.meta.url)), "../../runtime/dist");

/**
 * The publish gate against a target compiled by an older build.
 *
 * The gate compares the width a piece is declared to print at against the width the
 * compiler said it needs, and it is the only place in the system that sees both numbers.
 * It was reading that second number straight out of whatever target file it was handed. A
 * target written before the minimum print width was corrected holds a width about four
 * times too small, so the comparison passed pieces that cannot be read while looking, from
 * the outside, exactly like a gate that was doing its job.
 */
describe("a compiled target from an older build", () => {
  const scratches: string[] = [];

  /** A source folder holding the one asset the manifest names, and somewhere to write to. */
  async function scratch(): Promise<{ sourceDir: string; outDir: string; runtimeDir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "taggant-stale-"));
    scratches.push(dir);
    const sourceDir = join(dir, "src");
    await mkdir(sourceDir, { recursive: true });
    // A real PNG: an asset is identified by its bytes, and a stand-in is refused by name.
    await writeFile(
      join(sourceDir, "art.png"),
      await sharp({ create: { width: 4, height: 4, channels: 3, background: "#c33" } })
        .png()
        .toBuffer(),
    );
    return { sourceDir, outDir: join(dir, "out"), runtimeDir: RUNTIME_DIST };
  }

  afterEach(async () => {
    for (const dir of scratches.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const manifest = {
    schemaVersion: "1.0.0",
    id: "pack",
    title: "Pack",
    targets: [
      {
        id: "front",
        source: "art.png",
        physicalWidthMm: 148,
        content: [{ type: "image" as const, src: "art.png" }],
      },
    ],
  };

  const features = {
    formatVersion: 2,
    id: "front",
    width: 640,
    height: 452,
    features: currentFeatures(),
  };

  it("is refused rather than published on a width that cannot be trusted", async () => {
    // The shape the previous build wrote: a report, and no distance anywhere in it.
    const stale = { ...features, report: { minimumWidthMm: 147, pass: true } };
    await expect(bundle({ manifest, targets: { front: stale }, ...(await scratch()) })).rejects.toThrow(
      /older build/,
    );
    // One this model wrote, its distance removed since, is refused for what it lacks, and not
    // blamed on a build that never wrote it.
    const { scanDistanceMm: _gone, ...lost } = await currentReport();
    await expect(
      bundle({ manifest, targets: { front: { ...features, report: lost } }, ...(await scratch()) }),
    ).rejects.toThrow(/no scan distance a person could hold/);
  });

  it("publishes the same numbers once the report says what distance they are for", async () => {
    // The control, and the reason the test above proves anything. 148 mm declared against
    // 147 mm needed clears the comparison by a millimetre either way, so what changed the
    // answer is the missing distance and not the widths. Under the corrected model that
    // artwork needs about 270 mm, which is the size of the hole this closes.
    const current = { ...features, report: await currentReport() };
    expect(current.report.minimumWidthMm).toBe(147);
    const result = await bundle({ manifest, targets: { front: current }, ...(await scratch()) });
    expect(result.targets).toContain("front");
  });

  it("names the distance when it refuses a piece printed too small", async () => {
    // A refusal that says a piece needs more width without saying at what distance leaves
    // the operator with two ways to act on it and no way to tell which is meant.
    const report = await reportAskingFor(300);
    const current = { ...features, report };
    await expect(bundle({ manifest, targets: { front: current }, ...(await scratch()) })).rejects.toThrow(
      `at least 300 mm to be read at ${report.scanDistanceMm} mm`,
    );
  });

  it("is refused when its report was written before the design was checked for repeating itself", async () => {
    // The build before this one settled a design printed twice by whether one look in twenty
    // landed on the wrong copy, which turned on the export width, and its report held a number
    // where this build writes the repetition measured.
    const good = await currentReport();
    const before = { ...features, report: { ...good, repetition: 0.36 } };
    await expect(bundle({ manifest, targets: { front: before }, ...(await scratch()) })).rejects.toThrow(
      /before readiness checked whether the design repeats itself/,
    );
  });

  it("says a target that is not one is not one, rather than failing on it", async () => {
    // `null` reached the report checks and threw a TypeError naming the `in` operator, where the
    // build before gave the runtime's own sentence.
    for (const target of [null, "text", 7, true]) {
      await expect(
        bundle({ manifest, targets: { front: target }, ...(await scratch()) }),
        String(target),
      ).rejects.toThrow(/cannot be read by the runtime/);
    }
  });

  it("is refused when its report never asked the recogniser", async () => {
    // The build before this one inferred readiness from how often features had look-alikes, a
    // figure that fell as a design repeated, so it called a sheet of sixteen identical
    // postcards ready for press at a width where it is not found. Its pass carries a distance
    // and a width like any other, and only the missing recognition gives it away.
    const unchecked = { ...features, report: { minimumWidthMm: 147, pass: true, scanDistanceMm: 190 } };
    await expect(bundle({ manifest, targets: { front: unchecked }, ...(await scratch()) })).rejects.toThrow(
      /before readiness was checked against the recogniser/,
    );
  });

  it("refuses a passing report that carries no width", async () => {
    // The shape a NaN width became once written to JSON: pass true, width null. Every gate
    // that compares numbers read null as nothing to compare and let it through.
    const widthless = { ...features, report: await currentReport({ minimumWidthMm: null }) };
    await expect(bundle({ manifest, targets: { front: widthless }, ...(await scratch()) })).rejects.toThrow(
      /carries no print width/,
    );
  });

  it("says a report that is not one is not one, rather than failing on it", async () => {
    // `report: null` reached the checks as a TypeError about reading a property of null.
    const broken = { ...features, report: null };
    await expect(bundle({ manifest, targets: { front: broken }, ...(await scratch()) })).rejects.toThrow(
      /a print readiness report that is not one at all/,
    );
  });

  it("refuses every stored report the console would rebuild, and publishes the one it would not", async () => {
    // The gate read the fields its own way and the console asked `isCurrentReport`, and the two
    // disagreed on ten of seventeen shapes: a pass with a recognition of null, or not found, or
    // 13 points where 20 were needed, or with a verdict that was a string, all published.
    const good = await currentReport();
    const { widths, widthsAgreed, views, ...oneWidth } = good.recognition as unknown as Record<
      string,
      unknown
    >;
    const shapes: Array<[string, unknown]> = [
      ["recognition null with a pass", { ...good, recognition: null }],
      ["recognition not found with a pass", { ...good, recognition: { ...good.recognition, found: false } }],
      ["13 points where 20 are needed", { ...good, recognition: { ...good.recognition, inliers: 13 } }],
      ["a recognition that is a string", { ...good, recognition: "found" }],
      ["a verdict that is a string", { ...good, pass: "true" }],
      ["no verdict", { ...good, pass: undefined }],
      ["no score", { ...good, score: undefined }],
      ["a distance of 0", { ...good, scanDistanceMm: 0 }],
      ["a distance of -5", { ...good, scanDistanceMm: -5 }],
      [
        "a recognition decided on one width, as the build before wrote it",
        { ...good, recognition: oneWidth },
      ],
      [
        "a pass with a look in the wrong place",
        { ...good, recognition: { ...good.recognition, misplaced: 2 } },
      ],
      // Shapes no build writes, each accepted before these checks: each read as ready for press,
      // published, and showed on the console's page as ready.
      [
        "decided on one width of one",
        { ...good, recognition: { ...good.recognition, widths: 1, widthsAgreed: 1, views: 4 } },
      ],
      [
        "decided on two widths of two",
        { ...good, recognition: { ...good.recognition, widths: 2, widthsAgreed: 2, views: 8 } },
      ],
      [
        "three of five widths agreeing from no looks",
        { ...good, recognition: { ...good.recognition, views: 0 } },
      ],
      [
        "no points needed and none found",
        { ...good, recognition: { ...good.recognition, needed: 0, inliers: 0 } },
      ],
      ["a pass scoring 10", { ...good, score: 10 }],
      ["a score of 1000", { ...good, score: 1000 }],
      ["a pass with three features", { ...good, featureCount: 3 }],
      ["a smallest size that is a word", { ...good, smallestUsableScale: "x" }],
      ["no analysed width", { ...good, analysisWidth: undefined }],
      ["minus five pixels across", { ...good, recognition: { ...good.recognition, pixelsAcross: -5 } }],
      ["a width edited to 1 mm", { ...good, minimumWidthMm: 1 }],
      ["a width edited up by a millimetre", { ...good, minimumWidthMm: (good.minimumWidthMm ?? 0) + 1 }],
      ["no reasons", { ...good, reasons: undefined }],
      ["reasons that are a word", { ...good, reasons: "abc" }],
      ["a pass with a reason against it", { ...good, reasons: ["too few features to track reliably"] }],
      ["no repetition measured", { ...good, repetition: null }],
      [
        "a pass for a design that repeats itself",
        {
          ...good,
          repetition: {
            places: 120,
            of: 400,
            move: { across: 0.5, down: 0, turnDegrees: 0, scale: 1 },
            ends: { from: { x: 160, y: 226 }, to: { x: 480, y: 226 } },
            aimed: { sizes: 4, views: 32, misplaced: 0 },
          },
        },
      ],
      [
        "more places repeating than there are",
        { ...good, repetition: { places: 5, of: 3, move: null, ends: null, aimed: null } },
      ],
    ];
    for (const [label, report] of shapes) {
      await expect(
        bundle({ manifest, targets: { front: { ...features, report } }, ...(await scratch()) }),
        label,
      ).rejects.toThrow(/Compile it again|did not pass/);
    }
    expect([widths, widthsAgreed, views]).toEqual([5, 5, 5]);
    const result = await bundle({
      manifest,
      targets: { front: { ...features, report: good } },
      ...(await scratch()),
    });
    expect(result.targets).toContain("front");
  });

  it("refuses a target with no features in it at all", async () => {
    // The parser accepts an empty list, because zero is a legal length, so a target
    // truncated in a copy publishes a bundle that can never recognise anything.
    const empty = { ...features, features: [] };
    await expect(bundle({ manifest, targets: { front: empty }, ...(await scratch()) })).rejects.toThrow(
      /no features in it\b.*Compile it again\.$/,
    );

    // And one whose own compile found nothing in the artwork, which compiling again cannot change:
    // it was sent to compile again, while the console's card gave the compile's own reason.
    const blank = { ...features, features: [] };
    const nothing = JSON.parse(
      JSON.stringify(
        await buildReport({
          image: { width: 640, height: 452 },
          levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: [] })),
          features: [],
          target: blank,
          scanDistanceMm: 190,
          recognises: () => [{ found: false, inliers: 0, misplaced: false }],
        }),
      ),
    );
    expect(isCurrentReport(nothing) && describesTarget({ ...blank, report: nothing })).toBe(true);
    await expect(
      bundle({ manifest, targets: { front: { ...blank, report: nothing } }, ...(await scratch()) }),
    ).rejects.toThrow(
      // The file named, and what helps said without a condition the console may already have met.
      /found none in its artwork, art\.png as the manifest names it, .*will not change that; artwork with more detail will, once the target is compiled from it\.$/,
    );

    // Each half of that decides it. Features emptied beside the report of the features they were,
    // one this build would write, are a file a compile restores; and the report of a compile that
    // found nothing, edited since, is not one this build stands behind. With either half of the
    // condition gone, one of the two is told that compiling again would not help.
    const emptied = { ...features, features: [], report: await currentReport() };
    expect(isCurrentReport(emptied.report), "emptied").toBe(true);
    expect(describesTarget(emptied), "emptied").toBe(false);
    const edited = { ...blank, report: { ...nothing, score: nothing.score + 1 } };
    expect(isCurrentReport(edited.report), "edited").toBe(false);
    expect(describesTarget(edited), "edited").toBe(true);
    for (const [label, front] of [
      ["emptied", emptied],
      ["edited", edited],
    ] as const) {
      await expect(bundle({ manifest, targets: { front }, ...(await scratch()) }), label).rejects.toThrow(
        /no features in it\b.*Compile it again\.$/,
      );
    }
  });

  it("refuses a target that carries no report, which was the way past every check", async () => {
    // A target with no report was let through as never claimed to have been checked, so removing
    // one key from a target file published a sheet the compiler had refused, while the console's
    // own page said the target was not compiled yet.
    const refused = { ...features, report: { ...(await currentReport()), pass: false } };
    await expect(bundle({ manifest, targets: { front: refused }, ...(await scratch()) })).rejects.toThrow(
      /Compile it again|did not pass/,
    );
    await expect(bundle({ manifest, targets: { front: features }, ...(await scratch()) })).rejects.toThrow(
      /carries no print readiness report/,
    );
  });

  it("refuses a report that does not describe its own target", async () => {
    // Edited together, an analysed width and the figures worked out from it made a report the
    // stored check stood behind, and a piece that needs 147 mm published declared 10 mm wide.
    // The target says what it was built from: its analysed width, and the sizes its features
    // were found at, one of which is the size the report confirms.
    const report = await currentReport();
    const otherWidth = { ...features, width: 700, report };
    await expect(bundle({ manifest, targets: { front: otherWidth }, ...(await scratch()) })).rejects.toThrow(
      /does not describe its own target/,
    );
    const otherSizes = {
      ...features,
      features: features.features.filter((feature) => feature.scale === 1),
      report,
    };
    await expect(bundle({ manifest, targets: { front: otherSizes }, ...(await scratch()) })).rejects.toThrow(
      /does not describe its own target/,
    );
    // And the report of another target of the same width and sizes, which every landscape artwork
    // shares, with a different count of features at full size.
    const another = { ...features, features: features.features.slice(1), report };
    expect(another.features.filter((feature) => feature.scale === 1).length).toBe(report.featureCount - 1);
    await expect(bundle({ manifest, targets: { front: another }, ...(await scratch()) })).rejects.toThrow(
      /does not describe its own target/,
    );
    // Or the same count, which many landscape artworks share too: only the fingerprint tells them
    // apart, here one bit of one descriptor.
    const [first, ...rest] = features.features as Array<{ descriptor: number[] }>;
    const twin = {
      ...features,
      features: [
        {
          ...first,
          descriptor: [((first?.descriptor[0] ?? 0) ^ 1) >>> 0, ...(first?.descriptor.slice(1) ?? [])],
        },
        ...rest,
      ],
      report,
    };
    expect(twin.features.filter((feature) => (feature as { scale?: number }).scale === 1).length).toBe(
      report.featureCount,
    );
    await expect(bundle({ manifest, targets: { front: twin }, ...(await scratch()) })).rejects.toThrow(
      /is not the target the report's fingerprint names/,
    );
    const own = { ...features, report };
    await expect(bundle({ manifest, targets: { front: own }, ...(await scratch()) })).resolves.toBeDefined();
  });

  it("asks whether a report is the target's own before reading its verdict or its width", async () => {
    // Asked after them, a refused design carrying another's passing report was told that design's
    // width, declared too narrow for it, and a ready design carrying another's refusal was told it
    // had not passed: each a message about another artwork, which no compile of this one changes.
    const [first, ...rest] = features.features as Array<{ descriptor: number[] }>;
    const twin = {
      ...features,
      features: [
        {
          ...first,
          descriptor: [((first?.descriptor[0] ?? 0) ^ 1) >>> 0, ...(first?.descriptor.slice(1) ?? [])],
        },
        ...rest,
      ],
    };
    const narrow = {
      ...manifest,
      targets: manifest.targets.map((each) => ({ ...each, physicalWidthMm: 10 })),
    };
    const refusedFor = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const passing = await currentReport();
    const tooNarrow = refusedFor(
      await bundle({
        manifest: narrow,
        targets: { front: { ...twin, report: passing } },
        ...(await scratch()),
      }).catch((error: unknown) => error),
    );
    expect(tooNarrow).toMatch(/does not describe its own target/);
    expect(tooNarrow).not.toMatch(/needs at least/);
    const refusal = await refusalFor(twin);
    expect(isCurrentReport(refusal)).toBe(true);
    expect(refusal.pass).toBe(false);
    const notPassed = refusedFor(
      await bundle({
        manifest,
        targets: { front: { ...features, report: refusal } },
        ...(await scratch()),
      }).catch((error: unknown) => error),
    );
    expect(notPassed).toMatch(/does not describe its own target/);
    expect(notPassed).not.toMatch(/did not pass/);
    // And a refusal confirmed no size, so none is named.
    expect(notPassed).not.toMatch(/confirmed at/);
  });

  it("refuses a report whose own figures do not describe the target, though it names the target", async () => {
    // Edited together, a report can carry the target's own fingerprint and still say the artwork
    // was analysed at another width, held fewer features, or was confirmed at a size the target
    // has no features at. Each is consistent with itself, so only the target says otherwise. The
    // piece is declared wide enough for every one of them, so the width is not what refuses it.
    const wide = {
      ...manifest,
      targets: manifest.targets.map((each) => ({ ...each, physicalWidthMm: 400 })),
    };
    for (const change of [{ analysisWidth: 700 }, { featureCount: 100 }, { confirmedFrom: 380 }]) {
      const report = await reportDifferingIn(change);
      const name = JSON.stringify(change);
      expect(isCurrentReport(report), name).toBe(true);
      expect(report.targetDigest, name).toBe(targetDigest(features));
      await expect(
        bundle({ manifest: wide, targets: { front: { ...features, report } }, ...(await scratch()) }),
        name,
      ).rejects.toThrow(/does not describe its own target/);
    }
    // And the same piece with the target's own report publishes, so it is the figures that refuse.
    await expect(
      bundle({
        manifest: wide,
        targets: { front: { ...features, report: await currentReport() } },
        ...(await scratch()),
      }),
    ).resolves.toBeDefined();
  });
});

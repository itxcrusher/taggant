import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { bundle } from "../src/bundle.js";
import { currentReport } from "./current-report.js";

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

  const FEATURE = { x: 50, y: 50, strength: 1, angle: 0, scale: 1, descriptor: [0, 1, 2, 3, 4, 5, 6, 7] };
  const features = { formatVersion: 2, id: "front", width: 640, height: 452, features: [FEATURE] };

  it("is refused rather than published on a width that cannot be trusted", async () => {
    // The shape the previous build wrote: a report, and no distance anywhere in it.
    const stale = { ...features, report: { minimumWidthMm: 147, pass: true } };
    await expect(bundle({ manifest, targets: { front: stale }, ...(await scratch()) })).rejects.toThrow(
      /older build/,
    );
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
    const current = { ...features, report: await currentReport({ minimumWidthMm: 300 }) };
    await expect(bundle({ manifest, targets: { front: current }, ...(await scratch()) })).rejects.toThrow(
      /at least 300 mm to be read at 190 mm/,
    );
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
      /no features in it/,
    );
  });

  it("still says nothing about a target that never carried a report", async () => {
    // The gate has an opinion about widths, not about targets. Something built by the
    // vision package directly has no report and never claimed to have been checked;
    // refusing it would break every caller that compiles without the print advice.
    const result = await bundle({ manifest, targets: { front: features }, ...(await scratch()) });
    expect(result.targets).toContain("front");
  });
});

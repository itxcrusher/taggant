import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, formatReportLines, main, parseArguments } from "../src/cli.js";

const POSTCARD = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/postcard/artwork.png");

describe("formatReportLines", () => {
  it("prints the numbers a printer needs, in millimetres", () => {
    const lines = formatReportLines("front.tif", {
      formatVersion: 2,
      id: "front-panel",
      width: 1200,
      height: 800,
      features: [],
      report: {
        score: 82,
        pass: true,
        featureCount: 240,
        areasWithFeatures: 14,
        areas: 16,
        repetition: 0.1,
        analysisWidth: 1200,
        smallestUsableScale: 0.5,
        minimumWidthMm: 62,
        scanDistanceMm: 150,
        recognition: { pixelsAcross: 320, found: true, inliers: 58, needed: 30 },
        reasons: [],
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("front.tif");
    expect(text).toContain("82 / 100");
    expect(text).toContain("62 mm");
    // Beside the verdict, what the verdict was made of.
    expect(text).toContain("at that width, 58 points agree in the worst of four turns");
  });

  it("lists every reason when the artwork fails", () => {
    const lines = formatReportLines("front.tif", {
      formatVersion: 2,
      id: "front-panel",
      width: 1200,
      height: 800,
      features: [],
      report: {
        score: 20,
        pass: false,
        featureCount: 12,
        areasWithFeatures: 4,
        areas: 16,
        repetition: 0.1,
        analysisWidth: 1200,
        smallestUsableScale: 0.5,
        minimumWidthMm: 62,
        scanDistanceMm: 150,
        recognition: null,
        reasons: ["too few features to track reliably", "features are concentrated in part of the artwork"],
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("too few features");
    expect(text).toContain("concentrated");
    expect(text).toContain("not ready");
    expect(text).toContain("not asked, because the artwork did not get that far");
  });
});

describe("main", () => {
  it("reports a bad scan distance and exits non-zero instead of printing nonsense", async () => {
    expect(await main(["whatever.png", "--scan-distance", "abc"])).toBe(EXIT.usage);
  });

  it("reports a missing file cleanly rather than throwing a stack trace", async () => {
    expect(await main(["definitely-not-here.png"])).toBe(EXIT.cannotRead);
  });

  it("prints usage and exits non-zero when given no arguments", async () => {
    expect(await main([])).toBe(EXIT.usage);
  });

  it("refuses to write the target over the artwork it was compiled from", async () => {
    // It wrote 158 031 bytes of JSON over a 6 092 byte PNG, printed "written" and exited 0.
    const dir = await mkdtemp(join(tmpdir(), "compile-out-"));
    const art = join(dir, "front.png");
    await copyFile(POSTCARD, art);
    const before = await readFile(art);
    // Spelled differently, where the filesystem folds case, is still the same file.
    const shouting = process.platform === "linux" ? art : join(dir, "FRONT.PNG");
    for (const out of [art, shouting]) {
      expect(await main([art, "--scan-distance", "190", "--out", out]), out).toBe(EXIT.usage);
    }
    expect(Buffer.compare(await readFile(art), before)).toBe(0);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("leaves nothing beside the target once it is written", async () => {
    // Written beside its destination and renamed into place, so an interrupted write cannot
    // leave half a target under the right name; and the staging file does not outlive it.
    const dir = await mkdtemp(join(tmpdir(), "compile-out-"));
    const out = join(dir, "front.target.json");
    expect(await main([POSTCARD, "--scan-distance", "190", "--out", out])).toBe(EXIT.ok);
    expect(JSON.parse(await readFile(out, "utf8")).formatVersion).toBe(2);
    expect(await readdir(dir)).toEqual(["front.target.json"]);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("prints usage for --help wherever it is on the line", async () => {
    expect(await main(["art.png", "--help"])).toBe(EXIT.ok);
  });
});

describe("parseArguments", () => {
  function error(args: string[]): string {
    const parsed = parseArguments(args);
    if (!("error" in parsed)) throw new Error(`expected ${args.join(" ")} to be refused`);
    return parsed.error;
  }

  it("refuses a flag with no value instead of quietly using the default", () => {
    expect(error(["art.png", "--scan-distance"])).toMatch(/needs a value/);
    expect(error(["art.png", "--out"])).toMatch(/needs a value/);
  });

  it("refuses a flag whose value is another flag", () => {
    expect(error(["art.png", "--id", "--scan-distance", "900"])).toMatch(/another option/);
  });

  it("refuses an option it does not know, because a typo is not a default", () => {
    expect(error(["art.png", "--scan-distanc", "900"])).toMatch(/unknown option/);
    expect(error(["art.png", "--wat", "1"])).toMatch(/unknown option/);
  });

  it("takes a single dash as an option somebody meant, not as the artwork", () => {
    // `-h` became the artwork, its name the id, and the answer was a rule about ids.
    expect(error(["-h"])).toMatch(/unknown option -h/);
    expect(error(["art.png", "-o", "x.json"])).toMatch(/unknown option -o/);
  });

  it("reads a flag placed before the file", () => {
    const parsed = parseArguments(["--scan-distance", "900", "art.png"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.arguments.source).toBe("art.png");
    expect(parsed.arguments.scanDistanceMm).toBe(900);
  });

  it("takes the last of a repeated flag, as every other command line does", () => {
    const parsed = parseArguments(["art.png", "--scan-distance", "400", "--scan-distance", "900"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.arguments.scanDistanceMm).toBe(900);
  });

  it("refuses a scan distance that is not plain decimal millimetres", () => {
    expect(error(["art.png", "--scan-distance", "0x190"])).toMatch(/number of millimetres/);
    expect(error(["art.png", "--scan-distance", "abc"])).toMatch(/number of millimetres/);
    expect(error(["art.png", "--scan-distance", "1e300"])).toMatch(/number of millimetres/);
  });

  it("refuses a scan distance nobody could stand at", () => {
    expect(error(["art.png", "--scan-distance", "1"])).toMatch(/between 50 and 10000/);
    expect(error(["art.png", "--scan-distance", "50000"])).toMatch(/between 50 and 10000/);
  });

  it("refuses an id the manifest schema would reject, so the two cannot disagree", () => {
    expect(error(["art.png", "--id", "Front Panel"])).toMatch(/lower case letters/);
    expect(error(["art.png", "--id", "ab"])).toMatch(/lower case letters/);
  });

  it("takes the id from the filename when none is given", () => {
    const parsed = parseArguments(["Front-Panel.TIF"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.arguments.id).toBe("front-panel");
  });
});

describe("exit codes", () => {
  it("separates a typing mistake from artwork that cannot be read", async () => {
    expect(await main(["art.png", "--wat"])).toBe(EXIT.usage);
    expect(await main(["definitely-not-here.png"])).toBe(EXIT.cannotRead);
  });
});

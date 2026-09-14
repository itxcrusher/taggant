import { describe, expect, it } from "vitest";
import { EXIT, formatReportLines, main, parseArguments } from "../src/cli.js";

describe("formatReportLines", () => {
  it("prints the numbers a printer needs, in millimetres", () => {
    const lines = formatReportLines(
      "front.tif",
      {
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
          reasons: [],
        },
      },
      400,
    );
    const text = lines.join("\n");
    expect(text).toContain("front.tif");
    expect(text).toContain("82 / 100");
    expect(text).toContain("62 mm");
  });

  it("lists every reason when the artwork fails", () => {
    const lines = formatReportLines(
      "front.tif",
      {
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
          reasons: ["too few features to track reliably", "features are concentrated in part of the artwork"],
        },
      },
      400,
    );
    const text = lines.join("\n");
    expect(text).toContain("too few features");
    expect(text).toContain("concentrated");
    expect(text).toContain("not ready");
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

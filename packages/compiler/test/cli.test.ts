import { describe, expect, it } from "vitest";
import { formatReportLines, main } from "../src/cli.js";

describe("formatReportLines", () => {
  it("prints the numbers a printer needs, in millimetres", () => {
    const lines = formatReportLines("front.tif", {
      formatVersion: 2,
      id: "front-panel",
      width: 1200,
      height: 800,
      features: [],
      report: { score: 82, pass: true, featureCount: 240, coverage: 0.75, minimumWidthMm: 62, reasons: [] },
    });
    const text = lines.join("\n");
    expect(text).toContain("front.tif");
    expect(text).toContain("82 / 100");
    expect(text).toContain("62 mm");
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
        coverage: 0.25,
        minimumWidthMm: 62,
        reasons: ["too few features to track reliably", "features are concentrated in part of the artwork"],
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("too few features");
    expect(text).toContain("concentrated");
    expect(text).toContain("not ready");
  });
});

describe("main", () => {
  it("reports a bad scan distance and exits non-zero instead of printing nonsense", async () => {
    const code = await main(["whatever.png", "--scan-distance", "abc"]);
    expect(code).toBe(1);
  });

  it("reports a missing file cleanly rather than throwing a stack trace", async () => {
    const code = await main(["definitely-not-here.png"]);
    expect(code).toBe(1);
  });

  it("exits 1 and prints usage when given no arguments", async () => {
    expect(await main([])).toBe(1);
  });
});

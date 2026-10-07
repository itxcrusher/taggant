import { describe, expect, it } from "vitest";
import { describeProblem, esc, experiencePage, verdict } from "../src/views.js";

/**
 * The wording a person is shown when they cannot publish, and the escaping everything
 * written by somebody passes through.
 */

const MANIFEST = {
  schemaVersion: "1.0.0",
  id: "botanica-500",
  targets: [
    { id: "front-panel", source: "artwork/front.png", physicalWidthMm: 62, content: [] },
    { id: "back", source: "artwork/back.png", physicalWidthMm: 62, content: [] },
  ],
};

describe("what a person is told is missing", () => {
  it("names the target rather than pointing at an index", () => {
    expect(
      describeProblem({ path: "/targets/1/content", message: "must NOT have fewer than 1 items" }, MANIFEST),
    ).toBe("back has nothing to show. Add content to it.");
  });

  it("says what an empty experience needs, not what the schema counted", () => {
    expect(describeProblem({ path: "/targets", message: "must NOT have fewer than 1 items" }, MANIFEST)).toBe(
      "There is no target yet, so there is nothing for a camera to recognise. Add the artwork that will be printed.",
    );
  });

  it("keeps anything it does not recognise, rather than swallowing it", () => {
    const said = describeProblem({ path: "/fallback", message: 'must match format "uri"' }, MANIFEST);
    expect(said).toContain("/fallback");
    expect(said).toContain("uri");
  });

  it("still says something useful when the pointer names a target that is not there", () => {
    const said = describeProblem(
      { path: "/targets/9/content", message: "must NOT have fewer than 1 items" },
      MANIFEST,
    );
    expect(said).toContain("/targets/9/content");
  });
});

describe("escaping", () => {
  it("escapes every character that could end an attribute or open a tag", () => {
    expect(esc(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  });
});

describe("what a stored report is said to be", () => {
  const page = (staleReport: "unreadable" | "broken" | "width" | "verdict") =>
    experiencePage({
      id: "botanica-500",
      manifest: MANIFEST as never,
      problems: [],
      targets: [
        { id: "front-panel", source: "artwork/front.png", physicalWidthMm: 62, contentCount: 0, staleReport },
      ],
    });

  it("blames the width only for a report whose width was the problem", () => {
    // Every stale report was called too small to trust, including one whose width was right
    // and whose verdict came from a check since replaced.
    expect(page("width")).toContain("too small to trust");
    expect(page("verdict")).not.toContain("too small to trust");
    // And without claiming the width was sound, which a report with a corrupt width and a valid
    // distance also lands here with.
    expect(page("verdict")).toContain("this build does not stand behind its verdict");
    // A report that is not an object at all is said to be that, not "not compiled yet", which
    // `null`, `0`, `false` and `""` read as, nor a width too small to trust, which a string did.
    expect(page("broken")).toContain("not one at all");
    expect(page("broken")).not.toContain("Not compiled yet");
    expect(page("broken")).not.toContain("too small to trust");
    // A target file that is not a target at all is said to be that, not a broken report.
    expect(page("unreadable")).toContain("cannot be read as a target");
    expect(page("unreadable")).not.toContain("not one at all");
  });

  it("offers a distance its field will send, whatever distance the report was compiled at", () => {
    // The card offers to compile again at the report's own distance, and that can be 195 or 735. A
    // field in steps of ten held either as a value the browser would not send, and the button did
    // nothing at all.
    for (const offered of [195, 735, 192.5, 10_000]) {
      const html = experiencePage({
        id: "botanica-500",
        manifest: MANIFEST as never,
        problems: [],
        targets: [
          {
            id: "front-panel",
            source: "artwork/front.png",
            physicalWidthMm: 62,
            contentCount: 0,
            staleReport: "another",
            scanDistanceMm: offered,
          },
        ],
      });
      const field = html.match(/<input[^>]*name="scanDistanceMm"[^>]*>/)?.[0] ?? "";
      const attribute = (name: string) => field.match(new RegExp(` ${name}="([^"]*)"`))?.[1];
      expect(attribute("value"), String(offered)).toBe(String(offered));
      // What a browser asks of a number field before it sends the form: a value within its range,
      // and a whole number of steps from its minimum unless its step is "any".
      const value = Number(attribute("value"));
      expect(value).toBeGreaterThanOrEqual(Number(attribute("min")));
      expect(value).toBeLessThanOrEqual(Number(attribute("max")));
      const step = attribute("step");
      const steps = step === "any" ? 0 : (value - Number(attribute("min"))) / Number(step);
      expect(Number.isInteger(steps), `${offered} is not a whole number of steps of ${step}`).toBe(true);
      // And a value is asked for before the form is sent: emptied, the field was sent as nothing,
      // and the server compiled at its default distance without a word.
      expect(field, `${offered}: the field can be sent empty`).toMatch(/\srequired[\s>]/);
    }
  });

  it("offers no printable size for artwork that is not ready at any size", () => {
    // A refusal still carries what the corners said, and the record read "50% of that" beside a
    // recogniser that found nothing anywhere.
    const refused = verdict({
      score: 0,
      pass: false,
      featureCount: 300,
      areasWithFeatures: 16,
      areas: 16,
      repetition: null,
      analysisWidth: 640,
      smallestUsableScale: 0.5,
      minimumWidthMm: null,
      targetDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      scanDistanceMm: 190,
      recognition: {
        pixelsAcross: 320,
        widths: 5,
        widthsAgreed: 0,
        views: 12,
        misplaced: 0,
        found: false,
        inliers: 0,
        needed: 20,
      },
      reasons: ["the recogniser did not find it"],
    });
    expect(refused).toContain("none, for the reasons above");
    // The recognition row describes the size that came closest, and a reason can name a look in
    // the wrong place at another size, so "none in the wrong place" says which size it means.
    expect(refused).toContain("none in the wrong place at that size");
    expect(refused).not.toContain("50% of that");
    // Nor that the artwork must change, which is not true of a refusal for distance.
    expect(refused).not.toContain("The artwork has to change");
    expect(refused).toContain("Not printable until it passes");
  });

  it("describes the size the recogniser confirmed when looks pointed at a copy refuse it", () => {
    // Those looks come after a size is confirmed, and the row called five widths of five agreeing
    // "the size that came closest".
    const refused = verdict({
      score: 59,
      pass: false,
      featureCount: 198,
      areasWithFeatures: 16,
      areas: 16,
      repetition: {
        places: 55,
        of: 454,
        move: { across: -0.72, down: 0, turnDegrees: 0, scale: 1.67 },
        ends: { from: { x: 512, y: 136 }, to: { x: 147, y: 139 } },
        beyond: null,
        aimed: { moves: 1, sizes: 1, views: 8, misplaced: 4 },
      },
      analysisWidth: 640,
      smallestUsableScale: 0.5,
      minimumWidthMm: null,
      targetDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      scanDistanceMm: 190,
      recognition: {
        pixelsAcross: 320,
        widths: 5,
        widthsAgreed: 5,
        views: 20,
        misplaced: 0,
        found: true,
        inliers: 41,
        needed: 20,
      },
      reasons: ["pointed at the part of the artwork 80 per cent across and 49 per cent down"],
    });
    expect(refused).not.toContain("came closest");
    expect(refused).toContain(
      "every turn found it with 20 or more points agreeing at 5 of 5 widths at the smallest size it was confirmed at, no look centred on it in the wrong place",
    );
    expect(refused).toContain("none, for the reasons above");
  });
});

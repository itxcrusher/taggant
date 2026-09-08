import { describe, expect, it } from "vitest";
import { describeProblem, esc } from "../src/views.js";

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

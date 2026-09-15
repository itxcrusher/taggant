import { describe, expect, it } from "vitest";
import schema from "../schema/manifest-1.0.0.json" with { type: "json" };

describe("manifest schema", () => {
  it("declares its identity and version", () => {
    expect(schema.$id).toBe("https://taggant.dev/schema/manifest-1.0.0.json");
    expect(schema.properties.schemaVersion.const).toBe("1.0.0");
  });

  it("requires at least one target", () => {
    expect(schema.properties.targets.minItems).toBe(1);
    // And a ceiling, because every target is compiled, published and held in the browser at
    // once, and every SVG in a target's content costs a render process at publish time. An
    // unbounded list is an unbounded publish; the render budget is the second lock on that
    // and this is the first.
    expect(schema.properties.targets.maxItems).toBe(64);
    expect(schema.$defs.target.properties.content.maxItems).toBe(32);
  });

  it("states those ceilings in the document people read, at the same numbers", async () => {
    // A bound in a schema that the format document does not carry is a bound an author
    // meets as a validation error instead of reading beforehand. Both numbers, from the
    // schema, looked for in the prose.
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme, "the format document does not say how many targets are allowed").toContain(
      `at most ${schema.properties.targets.maxItems}`,
    );
    expect(readme, "the format document does not say how many pieces of content are allowed").toContain(
      `at most ${schema.$defs.target.properties.content.maxItems}`,
    );
  });

  it("forbids unknown top-level properties", () => {
    expect(schema.additionalProperties).toBe(false);
  });
});

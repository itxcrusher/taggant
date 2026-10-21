import { describe, expect, it } from "vitest";
import schema from "../schema/manifest-1.0.0.json" with { type: "json" };

describe("manifest schema", () => {
  it("declares its identity and version", () => {
    expect(schema.$id).toBe("https://taggant.dev/schema/manifest-1.0.0.json");
    expect(schema.properties.schemaVersion.const).toBe("1.0.0");
  });

  it("requires at least one target, and no more than the runtime and a publish can carry", () => {
    expect(schema.properties.targets.minItems).toBe(1);
    // And a ceiling, because every target is compiled, published and held in the browser at
    // once, and every SVG in a target's content costs a render process at publish time. An
    // unbounded list is an unbounded publish; the render budget is the second lock on that
    // and this is the first.
    expect(schema.properties.targets.maxItems).toBe(64);
    expect(schema.$defs.target.properties.content.maxItems).toBe(32);
  });

  it("states those ceilings in the document people read, against the right fields", async () => {
    // A bound in a schema that the format document does not carry is a bound an author
    // meets as a validation error instead of reading beforehand. Each number is looked for
    // in the table row that names its own field, because the first version of this looked
    // for both numbers anywhere in the file: with the two swapped, the
    // document told an author the reverse of the truth, and this passed.
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const row = (field: string): string => {
      const found = readme.split("\n").find((line) => line.startsWith(`| \`${field}\` | required |`));
      expect(found, `the format document has no row for ${field}`).toBeDefined();
      return found ?? "";
    };
    // The number and not a longer one starting with it: "at most 640" contains "at most 64", and
    // every rule for what may follow the figure let some other way of writing a larger number
    // through, "64,000", "64 000" with any space or an apostrophe between the thousands, digits of
    // another script, "64 k" or "64 thousand". Each row says it one way, the figure and then the
    // colon that ends the clause, so that is what is looked for.
    const exactly = (count: number) => new RegExp(`at most ${count}:`);
    expect(row("targets"), "the targets row does not say how many are allowed").toMatch(
      exactly(schema.properties.targets.maxItems),
    );
    expect(row("content"), "the content row does not say how many pieces are allowed").toMatch(
      exactly(schema.$defs.target.properties.content.maxItems),
    );
  });

  it("forbids unknown top-level properties", () => {
    expect(schema.additionalProperties).toBe(false);
  });
});

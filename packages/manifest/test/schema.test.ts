import { describe, expect, it } from "vitest";
import schema from "../schema/manifest-1.0.0.json" with { type: "json" };

describe("manifest schema", () => {
  it("declares its identity and version", () => {
    expect(schema.$id).toBe("https://taggant.dev/schema/manifest-1.0.0.json");
    expect(schema.properties.schemaVersion.const).toBe("1.0.0");
  });

  it("requires at least one target", () => {
    expect(schema.properties.targets.minItems).toBe(1);
  });

  it("forbids unknown top-level properties", () => {
    expect(schema.additionalProperties).toBe(false);
  });
});

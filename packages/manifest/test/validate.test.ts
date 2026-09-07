import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/validate.js";
import noTargets from "./fixtures/invalid-no-targets.json" with { type: "json" };
import unknownKey from "./fixtures/invalid-unknown-key.json" with { type: "json" };
import valid from "./fixtures/valid-minimal.json" with { type: "json" };

describe("validateManifest", () => {
  it("accepts a minimal manifest", () => {
    const result = validateManifest(valid);
    expect(result.ok).toBe(true);
  });

  it("rejects a manifest with no targets and says which path failed", () => {
    const result = validateManifest(noTargets);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]?.path).toBe("/targets");
  });

  it("rejects an unknown property, because the format is closed", () => {
    const result = validateManifest(unknownKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.message.includes("hosting"))).toBe(true);
  });

  it("applies defaults so a consumer never has to guess", () => {
    const result = validateManifest(structuredClone(valid));
    if (!result.ok) throw new Error("expected success");
    expect(result.value.targets[0]?.content[0]?.autoplay).toBe(true);
  });

  it("does not mutate the caller's object", () => {
    const input = structuredClone(valid) as Record<string, unknown>;
    validateManifest(input);
    const targets = input.targets as Array<{ content: Array<Record<string, unknown>> }>;
    expect(targets[0]?.content[0]?.autoplay).toBeUndefined();
  });
});

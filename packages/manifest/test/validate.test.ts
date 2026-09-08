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

describe("validateManifest on values it cannot clone", () => {
  it("returns a failure instead of throwing when the input holds a function", () => {
    const result = validateManifest({ schemaVersion: "1.0.0", id: "abc", run: () => 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]?.message).toMatch(/could not be read/i);
  });

  it("returns a failure for a bare function", () => {
    expect(validateManifest(() => 1).ok).toBe(false);
  });
});

describe("validateManifest as the gate before publication", () => {
  function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "1.0.0",
      id: "postcard",
      targets: [
        {
          id: "front",
          source: "front.png",
          physicalWidthMm: 148,
          content: [{ type: "video", src: "clip.mp4" }],
        },
      ],
      ...overrides,
    };
  }

  it("refuses a fallback that would run script in the viewer's browser", () => {
    for (const fallback of [
      "javascript:alert(document.cookie)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
    ]) {
      expect(validateManifest(manifest({ fallback })).ok).toBe(false);
    }
  });

  it("accepts an ordinary web address as a fallback", () => {
    expect(validateManifest(manifest({ fallback: "https://example.com/postcard" })).ok).toBe(true);
  });

  it("refuses content paths that leave the bundle", () => {
    for (const src of [
      "../../../etc/passwd",
      "/etc/passwd",
      "http://elsewhere.example/x.mp4",
      "a/../b.mp4",
    ]) {
      const value = manifest();
      const targets = value.targets as Array<{ content: Array<{ src: string }> }>;
      const first = targets[0]?.content[0];
      if (first) first.src = src;
      expect(validateManifest(value).ok).toBe(false);
    }
  });

  it("refuses two targets with the same id, which anything keying by id would lose", () => {
    const value = manifest();
    const targets = value.targets as Array<Record<string, unknown>>;
    const first = targets[0];
    if (first) targets.push({ ...first });
    const result = validateManifest(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]?.message).toMatch(/already used/);
  });

  it("fills in placement, so a consumer reading placement.scale does not crash", () => {
    const result = validateManifest(manifest());
    if (!result.ok) throw new Error("expected success");
    expect(result.value.targets[0]?.content[0]?.placement?.scale).toBe(1);
  });

  it("lets an error from the caller's own code through instead of blaming the manifest", () => {
    const hostile = manifest();
    Object.defineProperty(hostile, "title", {
      enumerable: true,
      get() {
        throw new Error("boom from the getter");
      },
    });
    expect(() => validateManifest(hostile)).toThrow(/boom from the getter/);
  });
});

describe("the paths a manifest may name", () => {
  function withSrc(src: string): unknown {
    return {
      schemaVersion: "1.0.0",
      id: "probe",
      targets: [{ id: "front", source: "a.png", physicalWidthMm: 100, content: [{ type: "image", src }] }],
    };
  }

  it("accepts ordinary relative paths", () => {
    for (const src of ["overlay.svg", "media/clip.mp4", "a-b_c.9/x.png"]) {
      expect(validateManifest(withSrc(src)).ok).toBe(true);
    }
  });

  it("refuses every way of leaving the bundle a browser would resolve", () => {
    for (const src of [
      "../o.svg",
      "a/../../o.svg",
      "/etc/passwd",
      "//evil.example/x.mp4",
      "http://evil.example/x.mp4",
      String.raw`..\..\windows\win.ini`,
      "%2e%2e/%2e%2e/secret.json",
      String.raw`\\evil.example\share\x.mp4`,
    ]) {
      expect(validateManifest(withSrc(src)).ok, src).toBe(false);
    }
  });
});

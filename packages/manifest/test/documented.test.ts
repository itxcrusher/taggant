import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { manifestSchema } from "../src/index.js";
import { validateManifest } from "../src/validate.js";

/**
 * What `README.md` in this package says the format does.
 *
 * The project claims in two public places that this format is documented, and until the
 * document existed that was not true. A document is a set of claims like any other, so
 * these are the ones it makes that nothing else here was already pinning.
 */

/**
 * Every field a schema defines, at every place JSON Schema can put one, and which of them
 * have no description.
 */
function describedFields(root: unknown): { total: number; missing: string[] } {
  let total = 0;
  const missing: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    const schema = node as Record<string, unknown>;
    const properties = schema.properties;
    if (properties && typeof properties === "object") {
      for (const [key, value] of Object.entries(properties as Record<string, Record<string, unknown>>)) {
        total++;
        if (!value.description) missing.push(`${path}/${key}`);
        walk(value, `${path}/${key}`);
      }
    }
    // A single schema, walked as itself.
    for (const one of ["items", "additionalProperties"]) walk(schema[one], path);
    // A list of schemas.
    for (const several of ["oneOf", "anyOf", "allOf"]) {
      const list = schema[several];
      if (Array.isArray(list)) for (const value of list) walk(value, path);
    }
    // A map of named schemas.
    for (const group of ["$defs", "patternProperties"]) {
      const sub = schema[group];
      if (sub && typeof sub === "object") {
        for (const [key, value] of Object.entries(sub as Record<string, unknown>))
          walk(value, `${path}/${key}`);
      }
    }
  };
  walk(root, "");
  return { total, missing };
}

const MINIMAL = {
  schemaVersion: "1.0.0",
  id: "botanica-500",
  targets: [
    {
      id: "front-panel",
      source: "artwork/front.png",
      physicalWidthMm: 62,
      content: [{ type: "video", src: "media/pour.mp4" }],
    },
  ],
};

describe("the format is closed at every level, not only the top", () => {
  const spoil: Record<string, (manifest: typeof MINIMAL) => void> = {
    document: (manifest) => {
      (manifest as Record<string, unknown>).extra = 1;
    },
    target: (manifest) => {
      (manifest.targets[0] as unknown as Record<string, unknown>).extra = 1;
    },
    content: (manifest) => {
      (manifest.targets[0]?.content[0] as unknown as Record<string, unknown>).extra = 1;
    },
    placement: (manifest) => {
      (manifest.targets[0]?.content[0] as unknown as Record<string, unknown>).placement = { extra: 1 };
    },
  };

  for (const [level, breakIt] of Object.entries(spoil)) {
    it(`refuses an unknown field on a ${level}`, () => {
      const copy = structuredClone(MINIMAL);
      breakIt(copy);
      // A misspelled field is a mistake worth hearing about, not a value quietly dropped.
      expect(validateManifest(copy).ok).toBe(false);
    });
  }
});

describe("what a manifest must carry", () => {
  it("accepts the shortest manifest the document prints", () => {
    expect(validateManifest(structuredClone(MINIMAL)).ok).toBe(true);
  });

  it("refuses a target that shows nothing", () => {
    const copy = structuredClone(MINIMAL);
    copy.targets[0] = { ...copy.targets[0], content: [] } as (typeof copy.targets)[0];
    expect(validateManifest(copy).ok).toBe(false);
  });

  it("refuses a version it does not know, rather than guessing at what changed", () => {
    const copy = structuredClone(MINIMAL);
    copy.schemaVersion = "1.1.0";
    expect(validateManifest(copy).ok).toBe(false);
  });
});

describe("the schema documents itself", () => {
  it("describes every field it defines", () => {
    // The types are generated from this file, so a field with no description here is a
    // field with no documentation in anyone's editor either. Three of twenty two carried
    // one when the claim that the format is documented was already being made publicly.
    const { total, missing } = describedFields(manifestSchema);
    expect(missing, `${total} fields, these have no description`).toEqual([]);
    expect(total).toBeGreaterThan(20);
  });

  it("counts a field wherever the schema can put one, which the old walker did not", () => {
    // `items` was iterated like `$defs`, as a map of named schemas, when it is a schema
    // itself: an inline `items: { properties }` contributed nothing and its fields were
    // never checked. It held only because both `items` in the real schema are `$ref`s that
    // `$defs` reaches separately. `oneOf`, `anyOf`, `allOf`, `additionalProperties` and
    // `patternProperties` were invisible the same way. So the walker is a function now,
    // and it is run over a schema built to have a field in each of those places.
    const fixture = {
      properties: {
        list: { description: "d", items: { properties: { inline: {} } } },
        either: { description: "d", oneOf: [{ properties: { first: {} } }, { properties: { second: {} } }] },
        every: { description: "d", allOf: [{ properties: { third: {} } }] },
        map: { description: "d", additionalProperties: { properties: { fourth: {} } } },
        keyed: { description: "d", patternProperties: { "^x": { properties: { fifth: {} } } } },
      },
    };
    const { total, missing } = describedFields(fixture);
    expect(total).toBe(11);
    expect(missing).toEqual([
      "/list/inline",
      "/either/first",
      "/either/second",
      "/every/third",
      "/map/fourth",
      "/keyed/^x/fifth",
    ]);
  });

  it("says something different about an experience id and a target id", () => {
    // They have the same shape and mean different things, and a description copied from
    // one to the other is worse than none: it reads as deliberate.
    const schema = manifestSchema as unknown as {
      properties: { id: { description: string } };
      $defs: { target: { properties: { id: { description: string } } } };
    };
    expect(schema.$defs.target.properties.id.description).not.toBe(schema.properties.id.description);
  });
});

describe("the worked example the document quotes", () => {
  /** Every fenced JSON block in the document, in the order it appears. */
  const blocks = (): unknown[] => {
    const doc = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const found: unknown[] = [];
    // No newline escape in the pattern, because a fence is opened by the word and closed
    // by the backticks and anything between them is the block.
    for (const match of doc.matchAll(/```json([\s\S]*?)```/g)) {
      found.push(JSON.parse((match[1] ?? "null").trim()));
    }
    return found;
  };

  /** Every fenced JSON block, as the text between the fences rather than as a value. */
  const blockText = (): string[] => {
    const doc = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    return [...doc.matchAll(/```json([\s\S]*?)```/g)].map((match) => (match[1] ?? "").trim());
  };

  it("is the file the example actually runs from, character for character", () => {
    // This checked the file and never opened the document, under a name that says it
    // compares them. It could not have caught what it was written to catch: the document
    // showed the postcard carrying `"fallback": "https://example.com/postcard"`, which the
    // example had removed, because refusing the camera then navigated a reader off to a
    // reserved placeholder domain with no explanation. Two documents, one of them stale,
    // and a test named after comparing them that compared nothing.
    const path = fileURLToPath(new URL("../../../examples/postcard/manifest.json", import.meta.url));
    const postcard = JSON.parse(readFileSync(path, "utf8"));
    // Every block claiming to be the postcard, not the first. `.find()` took the first, so
    // a second, stale copy further down the document passed untouched, which is exactly the
    // defect this was written for.
    const quoted = blocks().filter((block) => (block as { id?: string })?.id === "postcard");
    expect(quoted.length, "the document no longer quotes the postcard manifest").toBeGreaterThan(0);
    for (const block of quoted) {
      expect(block, "the document shows a postcard manifest that is not the one on disk").toEqual(postcard);
    }

    // And character for character, which is what the name says. `toEqual` compares values,
    // so a block differing only in key order or spacing satisfied it while reading
    // differently to anyone copying it out.
    const onDisk = readFileSync(path, "utf8").trim();
    const shown = blockText().filter((text) => text.includes('"id": "postcard"'));
    expect(shown.length, "no block in the document is written as the postcard manifest").toBeGreaterThan(0);
    for (const text of shown) {
      expect(text, "the document's postcard block is not the file, character for character").toBe(onDisk);
    }
  });

  it("prints nothing a reader could copy that this package would then refuse", () => {
    // Both blocks are offered as manifests to write files like. A document that prints an
    // invalid one teaches the reader something the validator will reject.
    const manifests = blocks().filter((block) => (block as { schemaVersion?: string })?.schemaVersion);
    expect(manifests.length, "the document prints no manifests at all").toBeGreaterThan(1);
    for (const manifest of manifests) {
      const result = validateManifest(structuredClone(manifest));
      const why = result.ok ? "" : result.errors.map((e) => `${e.path} ${e.message}`).join("; ");
      expect(result.ok, `the document prints a manifest this package refuses: ${why}`).toBe(true);
    }
  });
});

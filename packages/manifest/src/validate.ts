import type { ErrorObject } from "ajv";
import addFormats from "ajv-formats";
// The schema is JSON Schema 2020-12, which the default Ajv export does not understand.
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../schema/manifest-1.0.0.json" with { type: "json" };
import type { TaggantExperienceManifest } from "./types.gen.js";

export interface ManifestError {
  /** JSON pointer to the offending value, or "/" for the document itself. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: TaggantExperienceManifest }
  | { ok: false; errors: ManifestError[] };

const ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: false });
addFormats(ajv);
const compiled = ajv.compile(schema);

function describe(error: ErrorObject): ManifestError {
  const extra =
    error.keyword === "additionalProperties"
      ? ` (${String((error.params as { additionalProperty?: string }).additionalProperty)})`
      : "";
  return { path: error.instancePath || "/", message: `${error.message ?? "is invalid"}${extra}` };
}

/**
 * Ids have to be unique for anything to key by them, and JSON Schema cannot say so:
 * uniqueItems compares whole objects, not one property of them.
 */
function duplicateIds(value: unknown): ManifestError[] {
  const errors: ManifestError[] = [];
  const manifest = value as { targets?: Array<{ id?: unknown; content?: unknown[] }> };
  const targets = manifest.targets;
  if (!Array.isArray(targets)) return errors;

  const seenTargets = new Set<unknown>();
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (seenTargets.has(target?.id)) {
      errors.push({
        path: `/targets/${i}/id`,
        message: `is already used by another target (${String(target?.id)})`,
      });
    }
    seenTargets.add(target?.id);
  }
  return errors;
}

/**
 * Validate an unknown value against the manifest schema.
 *
 * Defaults are applied to the returned value, so every consumer sees the same complete
 * shape. The caller's object is never touched: validation works on a copy.
 */
export function validateManifest(input: unknown): ValidationResult {
  // Checked before cloning, because a value that is not an object is a schema failure and
  // has a better message than anything the clone could produce.
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: [{ path: "/", message: "must be object" }] };
  }

  let candidate: unknown;
  try {
    candidate = structuredClone(input);
  } catch (error) {
    // A DataCloneError means the value holds something a manifest cannot: a function, a
    // symbol, a handle. Anything else came out of the caller's own code, usually a getter
    // that threw, and reporting that as unreadable data hides the error they need to see.
    if (error instanceof Error && error.name === "DataCloneError") {
      return { ok: false, errors: [{ path: "/", message: "could not be read as data" }] };
    }
    throw error;
  }

  if (!compiled(candidate)) {
    return { ok: false, errors: (compiled.errors ?? []).map(describe) };
  }
  const duplicates = duplicateIds(candidate);
  if (duplicates.length > 0) return { ok: false, errors: duplicates };
  return { ok: true, value: candidate as unknown as TaggantExperienceManifest };
}

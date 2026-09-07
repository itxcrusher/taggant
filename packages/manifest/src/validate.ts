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
 * Validate an unknown value against the manifest schema.
 *
 * Defaults are applied to the returned value, so every consumer sees the same complete
 * shape. The caller's object is never touched: validation works on a copy.
 */
export function validateManifest(input: unknown): ValidationResult {
  let candidate: unknown;
  try {
    candidate = structuredClone(input);
  } catch {
    // structuredClone rejects functions and other non-transferable values. A manifest is
    // data, so this is a failed validation rather than a crash the caller has to catch.
    return { ok: false, errors: [{ path: "/", message: "could not be read as data" }] };
  }
  if (compiled(candidate)) {
    return { ok: true, value: candidate as unknown as TaggantExperienceManifest };
  }
  return { ok: false, errors: (compiled.errors ?? []).map(describe) };
}

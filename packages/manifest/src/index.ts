import schemaJson from "../schema/manifest-1.0.0.json" with { type: "json" };

export { validateManifest } from "./validate.js";
export type { ManifestError, ValidationResult } from "./validate.js";
export type { TaggantExperienceManifest } from "./types.gen.js";

/** The schema itself, so a consumer can validate without depending on this validator. */
export const manifestSchema = schemaJson;

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  /**
   * The schema library is bundled rather than left as an import.
   *
   * This package's whole point is that the format can be read by anything, and a build
   * that names `ajv` in a bare import is a build no browser can load. That is not
   * theoretical: it broke the example page, and it would have shipped inside any bundle
   * that carried the validator.
   */
  noExternal: ["ajv", "ajv-formats"],
});

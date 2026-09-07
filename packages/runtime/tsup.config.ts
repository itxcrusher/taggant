import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // The vision core is bundled in rather than left as a bare import. This is browser code,
  // and a bare specifier does not resolve in a browser; it is also the design commitment,
  // which is that a published experience carries its own runtime and needs nothing else up.
  noExternal: ["@taggant/vision"],
});

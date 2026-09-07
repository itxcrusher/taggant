import { defineConfig } from "tsup";

export default defineConfig({
  // The worker is its own entry, so the runtime can point a Worker at a real URL.
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // No shared chunk between the two entries. A worker is loaded by URL on its own, so it
  // has to stand alone, and a runtime that needs a second file to start is not the
  // self-contained thing this project says it ships.
  splitting: false,
  // The vision core is bundled in rather than left as a bare import. This is browser code,
  // and a bare specifier does not resolve in a browser; it is also the design commitment,
  // which is that a published experience carries its own runtime and needs nothing else up.
  noExternal: ["@taggant/vision"],
});

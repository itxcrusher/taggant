import { defineConfig } from "tsup";

export default defineConfig({
  // The worker is its own entry, so the runtime can point a Worker at a real URL.
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // A shared chunk between the two entries. The reason given for not having one was that a
  // worker is loaded by URL on its own and has to stand alone, which is not true of this
  // worker: `recogniser.ts` starts it with `{ type: "module" }`, and a module worker
  // resolves its imports relative to its own URL like any other module. Self-contained
  // means the bundle needs nothing from outside the folder, not that it is one file; it
  // already ships several. Without this the vision core was emitted twice, about 27 KB
  // each, in a bundle a phone fetches after scanning something printed.
  splitting: true,
  // The vision core is bundled in rather than left as a bare import. This is browser code,
  // and a bare specifier does not resolve in a browser; it is also the design commitment,
  // which is that a published experience carries its own runtime and needs nothing else up.
  noExternal: ["@taggant/vision"],
});

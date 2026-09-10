import { fileURLToPath } from "node:url";

/**
 * Workspace packages resolve to their source, not their build output.
 *
 * `dist` is generated and ignored, so a package's tests do not need a build of its
 * neighbours to run, and a change in one package is visible to another package's tests
 * without a rebuild in between.
 *
 * Two files opt out of this deliberately, and they are the reason the gate builds before
 * it tests: the runtime's browser tests load what a browser loads, so they read
 * `packages/vision/dist` by path. The descriptor comparison reads it on both sides, since
 * comparing source in Node against the build in a page makes an unrebuilt package look
 * like an engine disagreement.
 */
export const workspaceAliases: Record<string, string> = {
  "@taggant/manifest": fileURLToPath(new URL("./packages/manifest/src/index.ts", import.meta.url)),
  "@taggant/vision": fileURLToPath(new URL("./packages/vision/src/index.ts", import.meta.url)),
  "@taggant/runtime": fileURLToPath(new URL("./packages/runtime/src/index.ts", import.meta.url)),
  "@taggant/bundler": fileURLToPath(new URL("./packages/bundler/src/index.ts", import.meta.url)),
  "@taggant/compiler": fileURLToPath(new URL("./packages/compiler/src/index.ts", import.meta.url)),
  "@taggant/resolver": fileURLToPath(new URL("./services/resolver/src/index.ts", import.meta.url)),
  "@taggant/console": fileURLToPath(new URL("./apps/console/src/index.ts", import.meta.url)),
};

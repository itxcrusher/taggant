import { fileURLToPath } from "node:url";

/**
 * Workspace packages resolve to their source, not their build output.
 *
 * `dist` is generated and ignored, so on a clean checkout it does not exist when the
 * tests run. Resolving to source also means a change in one package is visible to
 * another package's tests without a rebuild in between.
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

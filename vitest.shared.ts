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
};

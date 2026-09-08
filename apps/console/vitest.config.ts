import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  // Compiling real artwork with sharp is seconds of work, and the publish test does it
  // more than once.
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});

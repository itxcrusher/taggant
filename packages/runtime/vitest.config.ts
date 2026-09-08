import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  // These launch Chromium and drive it against a synthetic camera. The default ten second
  // hook timeout is enough alone and is not enough when another package is launching its
  // own browser at the same time: closing one timed out in a full run and passed on its
  // own, which is the shape of a flake that gets rerun rather than read.
  test: { testTimeout: 120_000, hookTimeout: 120_000 },
});

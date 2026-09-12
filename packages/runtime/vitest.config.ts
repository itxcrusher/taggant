import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  // These launch Chromium and drive it against a synthetic camera. The default ten second
  // hook timeout is enough alone and is not enough when another package is launching its
  // own browser at the same time: closing one timed out in a full run and passed on its
  // own, which is the shape of a flake that gets rerun rather than read.
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One file at a time, and it is worth being honest about what that does and does not
    // buy. It does keep the file that starts three browser engines from running beside the
    // file that measures frame pacing, which was measured: the engines are not alive while
    // the pacing sample is taken. What it does not fix is the larger contention, which is
    // that a machine runs other things. The gate itself now runs the packages one at a
    // time, so the largest source of that is gone, but the pacing test still asserts
    // nothing load sensitive: no arrangement of files makes a timing assertion honest on a
    // machine doing something else. Wall clock figures are deliberately not quoted here,
    // because the last ones went stale within two commits.
    fileParallelism: false,
  },
});

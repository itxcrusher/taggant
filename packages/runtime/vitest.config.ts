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
    // the pacing sample is taken. It is also slightly faster here, around 48 seconds
    // against 60 for this package. What it does not fix is the larger contention, which is
    // that the gate runs `pnpm -r test` and pnpm runs packages concurrently, so the
    // compiler package is working through the runtime package's first minute; the runtime
    // package takes about 48 seconds alone and about 174 inside the recursive run. That is
    // why the pacing test no longer asserts anything load sensitive.
    fileParallelism: false,
  },
});

import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  // This package launches Chromium to serve a published bundle and drive it. The default
  // ten second hook timeout is enough on its own and is not enough when another package is
  // launching its own browser at the same time: closing it timed out twice in sixteen full
  // runs and once in nineteen isolated ones. The runtime package already carries this for
  // the same reason; this one was the only browser-launching package without it.
  test: { testTimeout: 120_000, hookTimeout: 120_000 },
});

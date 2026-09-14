import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  // This package decodes and rescales real artwork, and several tests compile the example
  // outright, which is about a second each before anything is asserted. Under the whole
  // workspace running at once that went past the five second default, in two files, as a
  // timeout rather than a failure. The work is real, so the budget is the thing that was
  // wrong.
  test: { testTimeout: 30_000 },
});

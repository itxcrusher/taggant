import { describe, expect, it, vi } from "vitest";
import { prepareAsset } from "../src/assets.js";

/**
 * A render process that dies rather than overruns. A document that crashes the library
 * takes the process down with it, by an illegal instruction or a signal, and which
 * documents do that changes from one build of the library to the next, so no document here
 * is relied on to do it. The process is killed as soon as it starts instead, and the
 * publisher has to refuse the asset by name and still be here to say so.
 */
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => {
      const child = actual.spawn(command, args, options);
      child.kill("SIGKILL");
      return child;
    },
  };
});

const DRAWING =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#c33"/></svg>';

describe("a render process that dies", () => {
  it("refuses the asset by name, and the publisher is still here to say so", async () => {
    await expect(prepareAsset("dies.svg", Buffer.from(DRAWING), { renderTimeoutMs: 30_000 })).rejects.toThrow(
      /^dies\.svg could not be rendered: the renderer stopped without saying why \(exit by signal\)/,
    );
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * A compiled target being replaced while it is read: the read finds no file, and by the time anything
 * looks again the file is back. The read here is made to find nothing while the file stays on disk,
 * which is that moment held still.
 */
const reads = vi.hoisted(() => ({ missing: new Set<string>() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const readFile = (async (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && [...reads.missing].some((name) => path.endsWith(name))) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
    }
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const { TargetNotReadError, createWorkspace, targetFilename } = await import("../src/workspace.js");

const made: string[] = [];
afterAll(async () => {
  for (const folder of made) await rm(folder, { recursive: true, force: true });
});

describe("a compiled target replaced while it is read", () => {
  it("is taken for gone on the read's own word, though the file is back when anything looks again", async () => {
    // A second look, meant to tell a gone file from a link to nothing, met the file put back and
    // called it one that could not be read, so its card asked for a distance it had on disk.
    const root = await mkdtemp(join(tmpdir(), "gone-target-"));
    made.push(root);
    const workspace = createWorkspace(join(root, "workspace"));
    const created = await workspace.create("back-again", "Back again");
    await workspace.writeTarget(created.id, "front", { formatVersion: 3 });
    expect(await workspace.hasTarget(created.id, "front")).toBe(true);
    reads.missing.add(targetFilename("front"));
    const refused = await workspace.readTarget(created.id, "front").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(TargetNotReadError);
    expect((refused as InstanceType<typeof TargetNotReadError>).gone).toBe(true);
  });
});

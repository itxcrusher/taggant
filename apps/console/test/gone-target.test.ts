import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * A compiled target being replaced while it is read: the read finds no file, and a moment later the
 * file is back. The reads here are made to find nothing a given number of times while the file
 * stays on disk, which is that moment held still.
 */
const reads = vi.hoisted(() => ({ missing: new Map<string, number>() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const readFile = (async (path: unknown, ...rest: unknown[]) => {
    for (const [name, left] of reads.missing) {
      if (typeof path === "string" && path.endsWith(name) && left > 0) {
        reads.missing.set(name, left - 1);
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: "ENOENT",
        });
      }
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

async function oneTarget() {
  const root = await mkdtemp(join(tmpdir(), "gone-target-"));
  made.push(root);
  const workspace = createWorkspace(join(root, "workspace"));
  const created = await workspace.create("back-again", "Back again");
  await workspace.writeTarget(created.id, "front", { formatVersion: 3, marker: "on disk" });
  expect(await workspace.hasTarget(created.id, "front")).toBe(true);
  return { workspace, id: created.id };
}

describe("a compiled target replaced while it is read", () => {
  it("is read once more, and the file put back is the one read", async () => {
    // Taken for gone at once, a publish compiled it again at a guess over the file put back; a
    // second look that found it called it unread, and its card asked for a distance on disk.
    const { workspace, id } = await oneTarget();
    reads.missing.set(targetFilename("front"), 1);
    expect(await workspace.readTarget(id, "front")).toEqual({ formatVersion: 3, marker: "on disk" });
  });

  it("is taken for gone when the second read finds nothing too", async () => {
    const { workspace, id } = await oneTarget();
    reads.missing.set(targetFilename("front"), 2);
    const refused = await workspace.readTarget(id, "front").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(TargetNotReadError);
    expect((refused as InstanceType<typeof TargetNotReadError>).gone).toBe(true);
  });
});

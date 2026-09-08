import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchTable } from "../src/table-source.js";

/**
 * The two ways noticing a changed file goes wrong.
 *
 * Both were found by running the real stack, not by reading. The resolver had a watch on
 * the link table, an operator edit produced nothing, and readiness went on reporting the
 * count it had at boot. Neither case is exotic: one is what every safe writer does, and
 * the other is what a container does on most developer machines.
 */

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "table-source-")), "links.json");
}

/** Wait for a condition rather than for a duration, so this is not a race. */
async function until(condition: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

describe("noticing that the table changed", () => {
  it("sees an ordinary edit", async () => {
    const path = await scratch();
    await writeFile(path, "1");
    let changes = 0;
    const source = await watchTable(path, {
      pollMs: 50,
      onChange: () => {
        changes++;
      },
    });
    await writeFile(path, "2");
    expect(await until(() => changes >= 1)).toBe(true);
    source.stop();
  });

  it("still sees edits after the file has been replaced by a rename", async () => {
    // The case that broke it. Anything that writes a file safely writes it beside the
    // destination and renames over it: this project's own console does, and so does vim.
    // A watch bound to the path stops firing for good at that point, on Linux, silently.
    const path = await scratch();
    await writeFile(path, "1");
    let changes = 0;
    const source = await watchTable(path, {
      pollMs: 50,
      onChange: () => {
        changes++;
      },
    });

    await writeFile(`${path}.writing`, "2");
    await rename(`${path}.writing`, path);
    expect(await until(() => changes >= 1)).toBe(true);

    const afterSwap = changes;
    await writeFile(path, "3");
    expect(await until(() => changes > afterSwap)).toBe(true);

    // And again, because one recovery could be luck.
    const afterEdit = changes;
    await writeFile(`${path}.writing`, "4");
    await rename(`${path}.writing`, path);
    expect(await until(() => changes > afterEdit)).toBe(true);
    source.stop();
  });

  it("notices without any file events at all, which is what a bind mount gives", async () => {
    // Measured against this project's compose stack on Docker Desktop: an edit on the host
    // produced no event inside the container, so the watch is a fast path and the timer is
    // the mechanism. Here the watch is never allowed to help: the file is created after the
    // source is already watching a directory that does not exist.
    const path = join(await mkdtemp(join(tmpdir(), "table-source-")), "absent", "links.json");
    let changes = 0;
    const source = await watchTable(path, {
      pollMs: 50,
      onChange: () => {
        changes++;
      },
    });
    await writeFile(join(path, "..", "..", "unrelated"), "x").catch(() => undefined);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "1");
    expect(await until(() => changes >= 1)).toBe(true);
    source.stop();
  });

  it("says nothing when nothing changed", async () => {
    const path = await scratch();
    await writeFile(path, "1");
    let changes = 0;
    const source = await watchTable(path, {
      pollMs: 20,
      onChange: () => {
        changes++;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes).toBe(0);
    source.stop();
  });

  it("treats the table being deleted as a change, rather than as nothing happening", async () => {
    const path = await scratch();
    await writeFile(path, "1");
    let changes = 0;
    const source = await watchTable(path, {
      pollMs: 50,
      onChange: () => {
        changes++;
      },
    });
    await rm(path);
    expect(await until(() => changes >= 1)).toBe(true);
    source.stop();
  });

  it("stops when it is stopped", async () => {
    const path = await scratch();
    await writeFile(path, "1");
    let changes = 0;
    const source = await watchTable(path, {
      pollMs: 20,
      onChange: () => {
        changes++;
      },
    });
    source.stop();
    await writeFile(path, "2");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changes).toBe(0);
  });
});

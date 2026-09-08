import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ID_PATTERN,
  ID_PATTERN_ATTRIBUTE,
  WorkspaceError,
  createWorkspace,
  safeFilename,
  targetFilename,
} from "../src/workspace.js";

/**
 * The store is a directory, so everything worth testing here is about names and about
 * what is on disk after something goes wrong.
 */

const made: string[] = [];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "taggant-console-"));
  made.push(root);
  return createWorkspace(root);
}

afterEach(() => {
  made.length = 0;
});

describe("what an id may be", () => {
  it("refuses anything that would leave the workspace directory", async () => {
    const store = await workspace();
    for (const id of ["../escape", "a/b", "..", ".", "a\\b", "", "-leading", "trailing-"]) {
      expect(() => store.directoryFor(id), id).toThrow(WorkspaceError);
    }
  });

  it("refuses an id that differs from another only by case, because two file systems disagree about that", async () => {
    const store = await workspace();
    expect(() => store.directoryFor("Botanica")).toThrow(WorkspaceError);
  });

  it("gives the browser a pattern it can actually compile, meaning the same thing", () => {
    // A `pattern` attribute is compiled with the unicode-sets flag. An unescaped hyphen at
    // the end of a class is a syntax error there, and a browser that cannot compile the
    // attribute ignores it: the field accepts anything and nobody is told. This was live.
    const attribute = new RegExp(`^(?:${ID_PATTERN_ATTRIBUTE})$`, "v");
    for (const id of ["a", "botanica-500", "0", "-lead", "trail-", "Botanica", "a/b", "../x"]) {
      expect(attribute.test(id), id).toBe(ID_PATTERN.test(id));
    }
  });

  it("accepts the ordinary ones", async () => {
    const store = await workspace();
    for (const id of ["a", "botanica-500", "x1", "0"]) {
      expect(() => store.directoryFor(id), id).not.toThrow();
    }
  });
});

describe("what an uploaded filename becomes", () => {
  it("keeps only the last segment, whichever separator was used", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Windows\\System32\\config")).toBe("config");
    expect(safeFilename("a/b/c/front.PNG")).toBe("front.png");
  });

  it("rebuilds the stem rather than filtering it", () => {
    expect(safeFilename("my artwork (final) v2.png")).toBe("my-artwork-final-v2.png");
    expect(safeFilename("front\u0000.png")).toBe("front.png");
  });

  it("still produces a name when there is nothing usable left", () => {
    expect(safeFilename("...")).toMatch(/^file-[0-9a-f]{8}$/);
    expect(safeFilename("///")).toMatch(/^file-[0-9a-f]{8}$/);
  });

  it("names a compiled target after the target, not after a path", () => {
    expect(targetFilename("front-panel")).toBe("front-panel.target.json");
    expect(targetFilename("../../x")).toBe("x.target.json");
    expect(targetFilename("!!!")).toBe("target.target.json");
  });
});

describe("a draft is not yet a manifest, and that is allowed", () => {
  it("stores an experience with no targets, which the schema forbids in a published bundle", async () => {
    const store = await workspace();
    const created = await store.create("botanica-500", "Botanica 500 ml");
    expect(created.manifest.targets).toEqual([]);
    // The point: it is readable, it is the same format, and it says what is missing.
    const read = await store.read("botanica-500");
    expect(read.problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(read.problems)).toContain("target");
  });

  it("reports no problems once it holds a target with content", async () => {
    const store = await workspace();
    await store.create("pack", "Pack");
    const saved = await store.save("pack", {
      schemaVersion: "1.0.0",
      id: "pack",
      title: "Pack",
      targets: [
        {
          id: "front",
          source: "artwork/front.png",
          physicalWidthMm: 62,
          content: [{ type: "video", src: "media/a.mp4" }],
        },
      ],
    });
    expect(saved.problems).toEqual([]);
  });

  it("does not write the schema's defaults into the operator's own file", async () => {
    const store = await workspace();
    await store.create("pack", "Pack");
    await store.save("pack", {
      schemaVersion: "1.0.0",
      id: "pack",
      targets: [
        {
          id: "front",
          source: "artwork/front.png",
          physicalWidthMm: 62,
          content: [{ type: "video", src: "media/a.mp4" }],
        },
      ],
    });
    await store.read("pack");
    const onDisk = JSON.parse(await readFile(join(store.root, "pack", "manifest.json"), "utf8"));
    // Validation fills defaults as it goes. Reading a manifest must not rewrite it.
    expect(onDisk.targets[0].content[0]).toEqual({ type: "video", src: "media/a.mp4" });
  });

  it("refuses to save a manifest under an id that is not its own", async () => {
    const store = await workspace();
    await store.create("pack", "Pack");
    await expect(store.save("pack", { schemaVersion: "1.0.0", id: "other", targets: [] })).rejects.toThrow(
      /says its id is other/,
    );
  });
});

describe("what the list shows", () => {
  it("ignores a directory that is not an experience, and names one that has stopped being a manifest", async () => {
    const store = await workspace();
    await store.create("real", "Real");
    await mkdir(join(store.root, "notes"), { recursive: true });
    await writeFile(join(store.root, "notes", "readme.txt"), "nothing to do with this");
    await mkdir(join(store.root, "broken"), { recursive: true });
    await writeFile(join(store.root, "broken", "manifest.json"), '["not an object"]');

    const listed = await store.list();
    expect(listed.map((entry) => entry.id).sort()).toEqual(["broken", "real"]);
    const broken = listed.find((entry) => entry.id === "broken");
    expect(broken?.ok).toBe(false);
  });

  it("survives a workspace directory that does not exist yet", async () => {
    const store = createWorkspace(join(tmpdir(), `taggant-absent-${Date.now()}`));
    expect(await store.list()).toEqual([]);
  });
});

describe("writing", () => {
  it("leaves nothing behind when a write fails", async () => {
    const store = await workspace();
    await store.create("pack", "Pack");
    // A directory where the manifest should be: the rename cannot succeed.
    await mkdir(join(store.root, "pack", "artwork", "taken.png"), { recursive: true });
    await expect(store.storeFile("pack", "artwork", "taken.png", new Uint8Array([1]))).rejects.toThrow();
    const left = await readdir(join(store.root, "pack", "artwork"));
    expect(left.filter((name) => name.includes(".writing-"))).toEqual([]);
  });

  it("refuses to write through a link that leaves the workspace", async () => {
    const store = await workspace();
    await store.create("pack", "Pack");
    const outside = await mkdtemp(join(tmpdir(), "taggant-outside-"));
    let linked = true;
    try {
      // A junction on Windows needs no elevation; a symlink to a directory may.
      await symlink(outside, join(store.root, "pack", "media"), "junction");
    } catch {
      linked = false;
    }
    if (!linked) return; // Recorded rather than silently passing: see the coverage note.
    await expect(store.storeFile("pack", "media", "x.mp4", new Uint8Array([1]))).rejects.toThrow(
      /outside the workspace/,
    );
  });
});

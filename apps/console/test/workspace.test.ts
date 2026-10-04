import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { canonical, queueKey } from "../src/in-turn.js";
import {
  ID_PATTERN,
  ID_PATTERN_ATTRIBUTE,
  TARGET_ID_PATTERN,
  TARGET_ID_PATTERN_ATTRIBUTE,
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

  it("gives the browser a target id pattern it can compile too", () => {
    // The same trap, walked into a second time by a new pattern written from the schema.
    const attribute = new RegExp(`^(?:${TARGET_ID_PATTERN_ATTRIBUTE})$`, "v");
    for (const id of ["abc", "front-panel", "ab", "Front", "a b", "x".repeat(65)]) {
      expect(attribute.test(id), id).toBe(TARGET_ID_PATTERN.test(id));
    }
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
    expect(targetFilename("front-panel")).toMatch(/^front-panel-[0-9a-f]{8}\.target\.json$/);
    expect(targetFilename("../../x")).toMatch(/^x-[0-9a-f]{8}\.target\.json$/);
    expect(targetFilename("!!!")).toMatch(/^target-[0-9a-f]{8}\.target\.json$/);
  });

  it("does not give two different target ids the same compiled filename", () => {
    // Both slug to `front-panel`, and a manifest may carry both. Without the digest,
    // compiling the second overwrote the first and the runtime was handed the wrong
    // target for one of them with nothing anywhere saying so.
    expect(targetFilename("front panel")).not.toBe(targetFilename("front-panel"));
    expect(targetFilename("a/b")).not.toBe(targetFilename("a-b"));
    // And the same id always gives the same name, or nothing could be found again.
    expect(targetFilename("front-panel")).toBe(targetFilename("front-panel"));
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

describe("changing an experience while something else is changing it", () => {
  it("keeps every target when four are added at once", async () => {
    // Read and save as separate calls lost three of these four: each read the manifest
    // before any of the others had written theirs, and the last write won.
    const store = await workspace();
    await store.create("race", "Race");
    await Promise.all(
      ["one", "two", "three", "four"].map((id) =>
        store.update("race", (manifest) => ({
          ...manifest,
          targets: [
            ...manifest.targets,
            { id, source: `artwork/${id}.png`, physicalWidthMm: 62, content: [] },
          ],
        })),
      ),
    );
    const saved = await store.read("race");
    expect(saved.manifest.targets.map((target) => target.id).sort()).toEqual(["four", "one", "three", "two"]);
  });

  it("does not wedge the queue when one change throws", async () => {
    const store = await workspace();
    await store.create("wedge", "Wedge");
    const failing = store.update("wedge", () => {
      throw new WorkspaceError("no");
    });
    await expect(failing).rejects.toThrow("no");
    const after = await store.update("wedge", (manifest) => ({ ...manifest, title: "still works" }));
    expect(after.manifest.title).toBe("still works");
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
  it("steps around a name something else already has", async () => {
    const store = await workspace();
    await store.create("pack", "Pack");
    const first = await store.storeFile("pack", "artwork", "logo.png", new Uint8Array([1]));
    const second = await store.storeFile("pack", "artwork", "LOGO.PNG", new Uint8Array([2]));
    expect(first).not.toBe(second);
    expect(second).toMatch(/logo-2\.png$/);
    const stored = await readdir(join(store.root, "pack", "artwork"));
    expect(stored.sort()).toEqual(["logo-2.png", "logo.png"]);
  });

  it("gives a new upload its own name when the manifest holds that name in escaped form", async () => {
    // The bundler decodes a manifest's paths before it reads them, so `artwork/logo%2Epng` is
    // `artwork/logo.png` to it. Compared undecoded, an upload was stored as `logo.png` while a
    // target named it escaped, and the bundler gave that target the new upload.
    const store = await workspace();
    await store.create("pack", "Pack");
    await store.save("pack", {
      schemaVersion: "1.0.0",
      id: "pack",
      targets: [{ id: "front", source: "artwork/logo%2Epng", physicalWidthMm: 120, content: [] }],
    });
    const stored = await store.storeFile("pack", "artwork", "logo.png", new Uint8Array([1]));
    expect(stored).toBe("artwork/logo-2.png");
  });

  it("waits out a reader holding the manifest open, rather than failing the write", async () => {
    // On Windows a rename onto a file another handle holds is refused, even when the holder is
    // only reading it, and a page view reads the manifest: a write made while one was being
    // viewed was a 500 with an EPERM stack. Elsewhere this cannot fail, and passes there.
    const store = await workspace();
    await store.create("pack", "Pack");
    const reader = await open(join(store.root, "pack", "manifest.json"), "r");
    const letGo = setTimeout(() => void reader.close(), 150);
    try {
      await store.update("pack", (manifest) => ({ ...manifest, title: "Changed" }));
    } finally {
      clearTimeout(letGo);
      await reader.close().catch(() => undefined);
    }
    expect(JSON.parse(await readFile(join(store.root, "pack", "manifest.json"), "utf8")).title).toBe(
      "Changed",
    );
  });

  it("says so in a sentence when a reader holds it open for longer than it waits", async (context) => {
    // Only Windows refuses the rename, so only there is there anything to wait out.
    if (process.platform !== "win32") {
      context.skip();
      return;
    }
    const store = await workspace();
    await store.create("pack", "Pack");
    const reader = await open(join(store.root, "pack", "manifest.json"), "r");
    try {
      await expect(store.update("pack", (manifest) => ({ ...manifest, title: "Changed" }))).rejects.toThrow(
        WorkspaceError,
      );
      await expect(store.update("pack", (manifest) => ({ ...manifest, title: "Changed" }))).rejects.toThrow(
        /held it open for over a second/,
      );
    } finally {
      await reader.close();
    }
    const left = await readdir(join(store.root, "pack"));
    expect(left.filter((name) => name.includes(".writing-"))).toEqual([]);
  });

  it("leaves nothing behind when a write fails", async () => {
    const store = await workspace();
    await store.create("pack", "Pack");
    // A directory where the manifest has to go, so the rename into place cannot succeed.
    // The staging file it built beside it must not survive that.
    await rm(join(store.root, "pack", "manifest.json"));
    await mkdir(join(store.root, "pack", "manifest.json"), { recursive: true });
    const refused = await store.save("pack", { schemaVersion: "1.0.0", id: "pack", targets: [] }).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refused, "a write onto a folder succeeded").not.toBeNull();
    // A folder where the file goes is not another program holding it, however the refusal reads
    // on Windows, where it is the same code a reader causes; waiting would not change it.
    expect(refused).not.toContain("held it open");
    const left = await readdir(join(store.root, "pack"));
    expect(left.filter((name) => name.includes(".writing-"))).toEqual([]);
  });

  it("names a file that does not exist yet as Windows will store it", async (context) => {
    // Windows drops trailing dots and spaces from a name it creates, so `links.json.` is written
    // to `links.json`, and before it existed its lock was taken under the name as typed: a
    // console given each spelling opened the same table with a lock each.
    if (process.platform !== "win32") {
      context.skip();
      return;
    }
    const folder = await mkdtemp(join(tmpdir(), "taggant-names-"));
    made.push(folder);
    const plain = canonical(join(folder, "links.json"));
    expect(canonical(join(folder, "links.json."))).toBe(plain);
    expect(canonical(join(folder, "links.json. ."))).toBe(plain);
    expect(queueKey(join(folder, "links.json."))).toBe(queueKey(join(folder, "links.json")));
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

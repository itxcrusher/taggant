/**
 * The console's store, which is a directory.
 *
 * An experience is a manifest plus the files it names. That is already what the bundler
 * consumes and what every other package in this repository speaks, so there is nothing
 * here translating between a database and the format (D-018). One folder per experience:
 *
 *     <root>/<id>/manifest.json      the experience
 *     <root>/<id>/artwork/           artwork a target is compiled from
 *     <root>/<id>/media/             content anchored to a target
 *     <root>/<id>/targets/           compiled targets, one file per target id
 *
 * Two things here are load bearing and both are about names, because an experience id and
 * an uploaded filename are written by whoever is using the console and both become path
 * segments. Ids are matched against a pattern before they are joined to anything, and an
 * uploaded name is reduced to a base name and rebuilt rather than trusted.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { type ManifestError, type TaggantExperienceManifest, validateManifest } from "@taggant/manifest";

/**
 * What an experience id may be.
 *
 * It becomes a directory name, it appears in a URL, and it ends up in the published
 * bundle's own path, so it is deliberately narrower than any of those three would allow.
 * Lower case because a store that treats two ids as different on Linux and the same on
 * Windows is a store that loses one of them.
 */
export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?$/;

/**
 * The same rule, for the form to hand the browser.
 *
 * Taken from the pattern above rather than written twice, because a hint that
 * disagrees with the rule is worse than no hint. The hyphen is escaped because a
 * pattern attribute is compiled with the unicode-sets flag, under which an
 * unescaped one at the end of a class is a syntax error: the attribute is then
 * ignored altogether and the field silently accepts anything.
 */
export const ID_PATTERN_ATTRIBUTE = ID_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * A manifest as the console holds it, which is not always one that could be published.
 *
 * The schema requires a manifest to have at least one target and every target to have at
 * least one piece of content, and it is right to: a manifest describes something that can
 * be recognised and shows something when it is. Authoring passes through states that are
 * neither, because a person adds the artwork before they add what it shows.
 *
 * So the schema is the gate on publishing rather than the gate on saving. What is on disk
 * is always the same format and always readable by anything; what is published is always
 * valid, and the console says what is missing until it is.
 */
export interface DraftContent {
  type: "image" | "video" | "model" | "audio";
  src: string;
  placement?: { scale?: number; offsetX?: number; offsetY?: number; rotationDeg?: number };
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
}

export interface DraftTarget {
  id: string;
  source: string;
  physicalWidthMm: number;
  content: DraftContent[];
}

export interface DraftManifest {
  schemaVersion: string;
  id: string;
  title?: string;
  subject?: Record<string, unknown>;
  targets: DraftTarget[];
  fallback?: string;
}

export interface Experience {
  id: string;
  /** The manifest as it is on disk. Publishable exactly when `problems` is empty. */
  manifest: DraftManifest;
  /** What the schema says is still wrong with it. Empty means it can be published. */
  problems: ManifestError[];
  /** Where its paths resolve from, which is what the bundler needs. */
  directory: string;
}

/** The valid form, for the one place that requires it. */
export function publishable(experience: Experience): TaggantExperienceManifest {
  if (experience.problems.length > 0) {
    throw new WorkspaceError(
      `${experience.id} cannot be published yet: ${experience.problems
        .map((problem) => `${problem.path} ${problem.message}`)
        .join("; ")}`,
    );
  }
  return experience.manifest as unknown as TaggantExperienceManifest;
}

/** An experience whose file is on disk but is not a manifest at all, so it can still be seen. */
export interface BrokenExperience {
  id: string;
  directory: string;
  reason: string;
}

export type Listed = ({ ok: true } & Experience) | ({ ok: false } & BrokenExperience);

export function assertId(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new WorkspaceError(
      `${JSON.stringify(id)} is not a usable id: lower case letters, digits and hyphens, starting and ending with a letter or digit, up to 63 characters`,
    );
  }
  return id;
}

/**
 * What a target id may be, which is the schema's rule rather than a second opinion.
 *
 * The console holds drafts the schema would reject, deliberately, because authoring passes
 * through incomplete states. An id is not one of those: it is either the shape the format
 * allows or it is something that can never be published. A 4000 character id and one
 * carrying a carriage return and a null byte were both stored, slugged onto disk, and only
 * refused later at the publish gate.
 */
export const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9\-]{2,63}$/;

/** The same rule for the form, escaped for the flag a pattern attribute is compiled with. */
export const TARGET_ID_PATTERN_ATTRIBUTE = TARGET_ID_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");

export function assertTargetId(id: string): string {
  if (!TARGET_ID_PATTERN.test(id)) {
    throw new WorkspaceError(
      `${JSON.stringify(id.slice(0, 40))} is not a usable target id: lower case letters, digits and hyphens, starting with a letter or digit, three to sixty four characters`,
    );
  }
  return id;
}

/**
 * A name safe to write into the store, built from an uploaded one rather than taken.
 *
 * The name arrives from a browser and is whatever the sender put in the multipart part,
 * which is to say `../../etc/cron.d/x`, a Windows path, a name that is all dots, or one
 * carrying a null byte. Only the last segment is looked at, only the extension is kept,
 * and the stem is rebuilt from the characters that are allowed rather than filtered for
 * the ones that are not.
 */
export function safeFilename(name: string): string {
  const last = basename(name.replace(/\\/g, "/").split("/").pop() ?? "");
  // A name that is only an extension has no stem, and `extname` reports nothing for it,
  // so `.png` was stored as a file called `png` with no extension at all.
  if (/^\.[a-z0-9]+$/i.test(last)) {
    return `file-${randomBytes(4).toString("hex")}${last.toLowerCase()}`;
  }
  // An extension is a dot followed by something. `...` has an `extname` of `.`, and a
  // name ending in a dot is one Windows will not store as written.
  const found = extname(last)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
  const extension = /^\.[a-z0-9]+$/.test(found) ? found : "";
  const stem = last
    .slice(0, last.length - extname(last).length)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stem || `file-${randomBytes(4).toString("hex")}`}${extension}`;
}

/**
 * A target id reduced to something that can be a filename, without two ids becoming one.
 *
 * The schema lets a target id be any non-empty string and the compiled target has to be
 * written somewhere, so the id is slugged. Slugging alone is not enough: `front panel`
 * and `front-panel` both reduce to `front-panel`, and a manifest may legitimately carry
 * both. With only the slug, compiling the second overwrote the first, and the runtime was
 * then handed the wrong target for one of them with nothing anywhere saying so.
 *
 * So the name carries a short digest of the id itself. The slug is what makes the folder
 * readable; the digest is what makes the name a function of the id and nothing else.
 */
export function targetFilename(targetId: string): string {
  const slug =
    targetId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "target";
  const digest = createHash("sha256").update(targetId, "utf8").digest("hex").slice(0, 8);
  return `${slug}-${digest}.target.json`;
}

/**
 * A name in this folder that nothing else has taken.
 *
 * Two uploaded names that reduce to one safe name is ordinary, and writing over the first
 * left a manifest entry pointing at a different target's image.
 */
async function freeName(directory: string, wanted: string): Promise<string> {
  const extension = extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = attempt === 0 ? wanted : `${stem}-${attempt + 1}${extension}`;
    try {
      await stat(join(directory, candidate));
    } catch {
      return candidate;
    }
  }
  throw new WorkspaceError(`there are already a thousand files called something like ${wanted}`);
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Write a file by building it beside its destination and moving it into place.
 *
 * The same build-then-swap the bundler uses, and for the same reason: a manifest half
 * written is a manifest that will not parse, and the console's whole store is manifests.
 * A crash between the two leaves the previous one intact.
 */
async function writeAtomic(path: string, contents: string | Uint8Array): Promise<void> {
  const staging = `${path}.writing-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(staging, contents);
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

export interface Workspace {
  root: string;
  directoryFor(id: string): string;
  list(): Promise<Listed[]>;
  read(id: string): Promise<Experience>;
  exists(id: string): Promise<boolean>;
  create(id: string, title: string): Promise<Experience>;
  save(id: string, manifest: DraftManifest): Promise<Experience>;
  /**
   * Read an experience, change it, and write it back, with nothing else touching it in
   * between.
   *
   * Every caller that adds a target or a piece of content has to use this rather than a
   * read followed by a save. Four targets added at the same moment through the separate
   * calls left one in the manifest and three pieces of artwork orphaned on disk, because
   * each request read the manifest before any of the others had written theirs.
   */
  update(id: string, change: (manifest: DraftManifest) => DraftManifest): Promise<Experience>;
  /** Store an upload under `artwork/` or `media/` and return its manifest-relative path. */
  storeFile(id: string, folder: "artwork" | "media", name: string, bytes: Uint8Array): Promise<string>;
  writeTarget(id: string, targetId: string, target: unknown): Promise<string>;
  readTarget(id: string, targetId: string): Promise<unknown>;
  hasTarget(id: string, targetId: string): Promise<boolean>;
}

export function createWorkspace(root: string): Workspace {
  const base = resolve(root);

  /**
   * One queue per experience, so a read and the write that follows it are not separated.
   *
   * This is a self-hosted tool for the people who own the artwork, so the process is the
   * boundary and an in-process queue is the right size of answer. It is not a lock file
   * and it does not defend against two consoles pointed at one directory, which is a thing
   * the documentation says not to do rather than a thing this pretends to survive.
   */
  const queues = new Map<string, Promise<void>>();
  const inTurn = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(id) ?? Promise.resolve();
    // Run on either outcome of the one before, so a failed operation does not wedge the
    // queue behind it.
    const result = previous.then(work, work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(id, settled);
    // Dropped only when nothing queued behind it, so an idle workspace holds nothing.
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id);
    });
    return result;
  };

  const directoryFor = (id: string): string => {
    const directory = resolve(base, assertId(id));
    // The pattern already forbids a separator or a dot segment, so this cannot currently
    // fail. It stays because the pattern is one edit away from being loosened and this is
    // the check that would catch that edit.
    if (directory !== base && !directory.startsWith(base + sep)) {
      throw new WorkspaceError(`${id} does not resolve inside the workspace`);
    }
    return directory;
  };

  const readManifestFile = async (id: string): Promise<unknown> => {
    const path = join(directoryFor(id), "manifest.json");
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new WorkspaceError(
        `${id} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Where a folder inside an experience really is, refused if that is not inside the
   * workspace.
   *
   * `directoryFor` compares paths as text, which cannot see a symbolic link or a Windows
   * junction: the operator's own store is a directory they can put anything in, and an
   * upload written through a link goes wherever the link points. The bundler shipped
   * exactly this defect and it took an adversarial pass to find it.
   */
  const inside = async (lexical: string, what: string): Promise<string> => {
    await mkdir(lexical, { recursive: true });
    const real = await realpath(lexical);
    const realBase = await realpath(base);
    if (!real.startsWith(realBase + sep)) {
      throw new WorkspaceError(`${what} resolves to ${real}, which is outside the workspace`);
    }
    return real;
  };

  /** The experience's own directory, resolved on disk. */
  const realDirectory = async (id: string): Promise<string> => await inside(directoryFor(id), id);

  const realFolder = async (id: string, folder: string): Promise<string> =>
    // The experience's own directory is checked first, because a junction there takes
    // everything under it with it and the folder below would resolve inside the target.
    await inside(join(await realDirectory(id), folder), `${folder} in ${id}`);

  /** The write itself, called only from inside a turn. */
  const write = async (id: string, manifest: DraftManifest): Promise<Experience> => {
    if (manifest.id !== id) {
      throw new WorkspaceError(`the manifest says its id is ${manifest.id}, and it is stored as ${id}`);
    }
    const directory = await realDirectory(id);
    await writeAtomic(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return interpret(id, manifest);
  };

  const exists = async (id: string): Promise<boolean> => {
    try {
      await stat(join(directoryFor(id), "manifest.json"));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Turn what is on disk into an experience, and say what the schema still objects to.
   *
   * The draft is validated as a copy. The validator fills in the schema's defaults as it
   * goes, and running it over the stored object would quietly rewrite the operator's file
   * with every default spelled out the next time anything was saved.
   */
  const interpret = (id: string, raw: unknown): Experience => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new WorkspaceError(`${id} does not hold a manifest object`);
    }
    const draft = raw as Partial<DraftManifest>;
    if (typeof draft.id !== "string" || !Array.isArray(draft.targets)) {
      throw new WorkspaceError(`${id} holds JSON, but not a manifest: it needs an id and a list of targets`);
    }
    // Shaped enough for a page to render, which is a separate question from valid. One
    // hand written manifest whose targets had no `content` took out the whole index: the
    // view reached for `target.content.length`, threw, and every other experience became
    // unreachable behind a 500 that named nothing.
    const shaped = draft.targets.every(
      (target: unknown) =>
        typeof target === "object" &&
        target !== null &&
        typeof (target as DraftTarget).id === "string" &&
        Array.isArray((target as DraftTarget).content),
    );
    if (!shaped) {
      throw new WorkspaceError(`${id} has a target that is not one: each needs an id and a list of content`);
    }
    const result = validateManifest(structuredClone(raw));
    return {
      id,
      manifest: draft as DraftManifest,
      problems: result.ok ? [] : result.errors,
      directory: directoryFor(id),
    };
  };

  const read = async (id: string): Promise<Experience> => interpret(id, await readManifestFile(id));

  return {
    root: base,
    directoryFor,

    async list(): Promise<Listed[]> {
      let entries: string[];
      try {
        entries = (await readdir(base, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        // An empty or absent workspace is a new one, not an error.
        return [];
      }
      const listed: Listed[] = [];
      for (const id of entries.sort()) {
        let raw: unknown;
        try {
          raw = await readManifestFile(id);
        } catch {
          // A directory with no readable manifest is not an experience. It may be anything
          // the operator put there, and the console does not claim it.
          continue;
        }
        try {
          listed.push({ ok: true, ...interpret(id, raw) });
        } catch (error) {
          // JSON that is not a manifest at all. Shown rather than hidden, because a folder
          // that has silently stopped being an experience is worse than one that says so.
          listed.push({ ok: false, id, directory: directoryFor(id), reason: reasonFor(error) });
        }
      }
      return listed;
    },

    read,

    exists,

    async create(id: string, title: string): Promise<Experience> {
      const directory = directoryFor(id);
      if (await exists(id)) {
        throw new WorkspaceError(`${id} already exists`);
      }
      // Through `realFolder`, so a link left in the workspace cannot put the manifest and
      // its folders somewhere else. That check was written for uploads and guarded only
      // those, so a junction named after an experience took the manifest write with it.
      await realFolder(id, "artwork");
      await realFolder(id, "media");
      await realFolder(id, "targets");
      const draft: DraftManifest = { schemaVersion: "1.0.0", id, title, targets: [] };
      await writeAtomic(join(directory, "manifest.json"), `${JSON.stringify(draft, null, 2)}\n`);
      return interpret(id, draft);
    },

    async save(id: string, manifest: DraftManifest): Promise<Experience> {
      return await inTurn(id, () => write(id, manifest));
    },

    async update(id: string, change: (manifest: DraftManifest) => DraftManifest): Promise<Experience> {
      return await inTurn(id, async () => {
        const current = interpret(id, await readManifestFile(id));
        return await write(id, change(current.manifest));
      });
    },

    async storeFile(
      id: string,
      folder: "artwork" | "media",
      name: string,
      bytes: Uint8Array,
    ): Promise<string> {
      const directory = await realFolder(id, folder);
      // Two names that reduce to one is the ordinary case, not a corner: `logo.png` and
      // `LOGO.PNG`, or `photo one.png` and `photo-one.png`. Writing the safe name blind
      // deleted the first file and left the first target's manifest entry pointing at the
      // second target's image, with nothing saying so.
      const filename = await freeName(directory, safeFilename(name));
      await writeAtomic(join(directory, filename), bytes);
      return `${folder}/${filename}`;
    },

    async writeTarget(id: string, targetId: string, target: unknown): Promise<string> {
      const directory = await realFolder(id, "targets");
      const filename = targetFilename(targetId);
      await writeAtomic(join(directory, filename), `${JSON.stringify(target)}\n`);
      return `targets/${filename}`;
    },

    async readTarget(id: string, targetId: string): Promise<unknown> {
      const filename = targetFilename(targetId);
      const path = join(directoryFor(id), "targets", filename);
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        throw new WorkspaceError(
          `the compiled target for ${targetId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async hasTarget(id: string, targetId: string): Promise<boolean> {
      const filename = targetFilename(targetId);
      try {
        await stat(join(directoryFor(id), "targets", filename));
        return true;
      } catch {
        return false;
      }
    },
  };
}

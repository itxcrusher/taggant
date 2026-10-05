import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * A rename that can be told to fail, so the two halves of the swap can be failed on every
 * platform. Failing them for real needs a process holding the folder open, which stops a
 * rename on Windows and does nothing on Linux, and a test that only fails on one of the two
 * is a test half the runs do not have.
 */
const failing = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => string | null),
  /** Runs after a rename that succeeded, to do what another publish would at that moment. */
  afterRename: null as null | ((from: string, to: string) => Promise<void>),
  stat: null as null | ((path: string) => string | null),
  rm: null as null | ((path: string) => string | null),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const refuse = (code: string, what: string) =>
    Object.assign(new Error(`${code}: operation refused for the test, ${what}`), { code });
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const code = failing.rename?.(String(from), String(to)) ?? null;
      if (code !== null) throw refuse(code, `rename '${from}' -> '${to}'`);
      await actual.rename(from, to);
      await failing.afterRename?.(String(from), String(to));
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const code = failing.stat?.(String(args[0])) ?? null;
      if (code !== null) throw refuse(code, `stat '${String(args[0])}'`);
      return actual.stat(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const code = failing.rm?.(String(args[0])) ?? null;
      if (code !== null) throw refuse(code, `rm '${String(args[0])}'`);
      return actual.rm(...args);
    },
  };
});

const { bundle } = await import("../src/bundle.js");
const { currentReport } = await import("./current-report.js");

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = join(here, "../../runtime/dist");
const FEATURE = { x: 50, y: 50, strength: 1, angle: 0, scale: 1, descriptor: [0, 1, 2, 3, 4, 5, 6, 7] };
// Built as the compiler builds one: the analysed width the report names, and features at the
// size it confirms, which the gate now checks the report against.
const TARGET = {
  formatVersion: 2,
  id: "front",
  width: 640,
  height: 452,
  features: [FEATURE, { ...FEATURE, scale: 0.5 }],
  report: await currentReport(),
};
const OVERLAY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c33" /></svg>';
const OTHER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c33" /><circle cx="5" cy="5" r="4" fill="#36c" /></svg>';

const manifest = (title: string, src = "overlay.svg") => ({
  schemaVersion: "1.0.0",
  id: "swap",
  title,
  targets: [{ id: "front", source: "artwork.png", physicalWidthMm: 148, content: [{ type: "image", src }] }],
});

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});
afterEach(() => {
  failing.rename = null;
  failing.afterRename = null;
  failing.stat = null;
  failing.rm = null;
});

async function scratch(): Promise<{ sourceDir: string; outDir: string; parent: string }> {
  const root = await mkdtemp(join(tmpdir(), "taggant-swap-"));
  roots.push(root);
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "overlay.svg"), OVERLAY);
  await writeFile(join(sourceDir, "other.svg"), OTHER);
  const parent = join(root, "bundles");
  return { sourceDir, outDir: join(parent, "swap"), parent };
}

const publish = (sourceDir: string, outDir: string, title: string, src?: string) =>
  bundle({
    manifest: manifest(title, src),
    targets: { front: TARGET },
    sourceDir,
    outDir,
    runtimeDir: RUNTIME_DIST,
  });

/** The title of the bundle that is live, and whether every asset its manifest names is there. */
async function live(outDir: string): Promise<{ title: string; whole: boolean }> {
  const shipped = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
  const sources = shipped.targets.flatMap((target: { content: { src: string }[] }) =>
    target.content.map((item) => item.src),
  );
  const present = await Promise.all(
    sources.map((src: string) =>
      stat(join(outDir, src)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return { title: shipped.title, whole: present.every(Boolean) };
}

/** Folders a publish puts beside the destination, which must not outlive it. */
const besides = async (parent: string): Promise<string[]> =>
  (await readdir(parent)).filter((name) => name !== "swap");

describe("replacing a published bundle", () => {
  it("leaves the published folder as it was when it cannot be moved aside, and nothing beside it", async () => {
    // Windows will not move a folder a process is using. The removal this replaced deleted
    // every file it could first, so the experience went dark, and the staging folder stayed in
    // the served tree with the operator reading a raw EBUSY that named it.
    const { sourceDir, outDir, parent } = await scratch();
    await publish(sourceDir, outDir, "first");
    failing.rename = (from) => (from === outDir ? "EBUSY" : null);

    const refused = await publish(sourceDir, outDir, "second").then(
      () => null,
      (error: Error) => error.message,
    );

    expect(refused, "a swap that could not move the published folder said it published").not.toBeNull();
    expect(refused).toContain("left exactly as it was");
    expect(refused).not.toMatch(/publishing-|replaced-/);
    expect(await live(outDir)).toEqual({ title: "first", whole: true });
    expect(await besides(parent)).toEqual([]);
  });

  it("puts back what it moved when the new bundle cannot be moved in", async () => {
    const { sourceDir, outDir, parent } = await scratch();
    await publish(sourceDir, outDir, "first");
    failing.rename = (from, to) =>
      to === outDir && basename(from).includes(".publishing-") ? "EPERM" : null;

    const refused = await publish(sourceDir, outDir, "second").then(
      () => null,
      (error: Error) => error.message,
    );

    expect(refused).toContain("the version that was live is unchanged");
    expect(await live(outDir)).toEqual({ title: "first", whole: true });
    expect(await besides(parent)).toEqual([]);
  });

  it("keeps the live version and says where it is when it can neither move in nor move back", async () => {
    // The failure of the failure path. Moved aside, the old bundle is the only copy there is,
    // so it is not deleted with the rest of what this publish made, and the operator is told
    // where it went and how to put it back.
    const { sourceDir, outDir, parent } = await scratch();
    await publish(sourceDir, outDir, "first");
    failing.rename = (_from, to) => (to === outDir ? "EPERM" : null);

    const refused = await publish(sourceDir, outDir, "second").then(
      () => null,
      (error: Error) => error.message,
    );

    expect(refused).toMatch(/could not be put back either: it is at .*swap\.replaced-[0-9a-f]{8}/);
    const kept = await besides(parent);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^swap\.replaced-[0-9a-f]{8}$/);
    expect(await live(join(parent, kept[0] ?? ""))).toEqual({ title: "first", whole: true });
  });

  it("lets one swap of a destination finish before the next starts, within a process", async () => {
    // Two renames of one folder can both succeed on Windows, so two publishes swapping at once
    // could each believe they had set the live version aside; with three, one put back the
    // version all three replaced and another deleted a bundle its operator was told was live.
    // The first swap here is held for a second after it moves the live folder aside, which is
    // when the second one would find nothing to move if it did not wait its turn.
    const { sourceDir, outDir, parent } = await scratch();
    await publish(sourceDir, outDir, "first");
    failing.afterRename = async (from, to) => {
      if (from !== outDir || !basename(to).startsWith("swap.replaced-")) return;
      failing.afterRename = null;
      await new Promise((settle) => setTimeout(settle, 1_000));
    };
    const outcomes = await Promise.all(
      ["second", "third"].map((title) =>
        publish(sourceDir, outDir, title).then(
          () => "published",
          (error: Error) => error.message,
        ),
      ),
    );
    expect(outcomes).toEqual(["published", "published"]);
    expect(["second", "third"]).toContain((await live(outDir)).title);
    expect(await besides(parent)).toEqual([]);
  });

  it("gives up when another publish took the folder it moved aside, and says so", async () => {
    // On Windows two renames of one folder to two names can both succeed, the second moving the
    // folder from where the first put it, so both publishes believed they had set the live
    // version aside. A publish that finds nothing where it put the folder lost that race.
    const { sourceDir, outDir, parent } = await scratch();
    await publish(sourceDir, outDir, "first");
    failing.afterRename = async (from, to) => {
      if (from !== outDir || !basename(to).startsWith("swap.replaced-")) return;
      failing.afterRename = null;
      // What the other publish's rename did at the same moment.
      await rename(to, join(parent, "swap.replaced-0ther0ne"));
    };
    const refused = await publish(sourceDir, outDir, "second").then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refused).toContain("was replacing it at the same moment");
    // Nothing of this publish is left, and the version that was live is where the other put it.
    expect(await besides(parent)).toEqual(["swap.replaced-0ther0ne"]);
  });

  it("goes on with the swap when the check of the moved folder fails for another reason", async () => {
    // Only nothing there means another publish took it. Giving up on any failed look left what
    // was live set aside with nothing in its place.
    const { sourceDir, outDir, parent } = await scratch();
    await publish(sourceDir, outDir, "first");
    failing.stat = (path) => (basename(path).startsWith("swap.replaced-") ? "EPERM" : null);
    await publish(sourceDir, outDir, "second");
    failing.stat = null;
    expect(await live(outDir)).toEqual({ title: "second", whole: true });
    expect(await besides(parent)).toEqual([]);
  });

  it("says where an unfinished bundle is when it cannot be removed, rather than a raw EBUSY", async () => {
    // A scanner holding one freshly written file made the removal fail, and its EBUSY replaced
    // the sentence it was cleaning up after, while the unfinished bundle stayed in the served tree.
    const { sourceDir, outDir } = await scratch();
    await publish(sourceDir, outDir, "first");
    failing.rename = (from, to) =>
      to === outDir && basename(from).includes(".publishing-") ? "EPERM" : null;
    failing.rm = (path) => (basename(path).includes(".publishing-") ? "EBUSY" : null);
    const refused = await publish(sourceDir, outDir, "second").then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refused).toContain("the version that was live is unchanged");
    expect(refused).toMatch(
      /The unfinished bundle could not be removed \(EBUSY\) and is at .*swap\.publishing-[0-9a-f]{8}/,
    );
    expect(refused).not.toContain("operation refused for the test");
    failing.rename = null;
    failing.rm = null;
    expect(await live(outDir)).toEqual({ title: "first", whole: true });
  });

  it("removes what an earlier publish left beside it, once that is old enough to be nobody's", async () => {
    const { sourceDir, outDir, parent } = await scratch();
    await publish(sourceDir, outDir, "first");
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const left = ["swap.publishing-0a292fd4", "swap.replaced-b9d02e92"];
    // Kept: one young enough to belong to a publish still running in another console, another
    // experience's, and names this module does not write.
    const kept = [
      "swap.publishing-c0ffee00",
      "other.publishing-0a292fd4",
      "swap.publishing-notmine",
      "swap.notes",
    ];
    for (const name of [...left, ...kept]) {
      await mkdir(join(parent, name), { recursive: true });
      await writeFile(join(parent, name, "index.html"), "an old bundle");
    }
    for (const name of [...left, ...kept.filter((name) => name !== "swap.publishing-c0ffee00")]) {
      await utimes(join(parent, name), longAgo, longAgo);
    }

    await publish(sourceDir, outDir, "second");

    expect((await besides(parent)).sort()).toEqual([...kept].sort());
    expect(await live(outDir)).toEqual({ title: "second", whole: true });
  });

  it("keeps an old copy of what was live while nothing is live, because it may be the only one", async () => {
    const { sourceDir, outDir, parent } = await scratch();
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await mkdir(join(parent, "swap.replaced-b9d02e92"), { recursive: true });
    await utimes(join(parent, "swap.replaced-b9d02e92"), longAgo, longAgo);

    await publish(sourceDir, outDir, "first");

    expect(await besides(parent)).toEqual(["swap.replaced-b9d02e92"]);
  });

  it("leaves one whole bundle and nothing beside it when two publishes of it meet", async () => {
    // Two consoles on different workspaces can share a publish folder legitimately, and the
    // console's queue is per process. Without the queue every round of fourteen failed one or
    // both with a raw errno, and twelve rounds left a staging folder in the served tree.
    // Driven twenty times, because one clean run of a race is one scheduling.
    for (let round = 0; round < 20; round++) {
      const { sourceDir, outDir, parent } = await scratch();
      await publish(sourceDir, outDir, "first");
      const outcomes = await Promise.allSettled([
        publish(sourceDir, outDir, "left"),
        publish(sourceDir, outDir, "right", "other.svg"),
      ]);
      const now = await live(outDir);
      expect(now.whole, `round ${round}: the live bundle is missing assets`).toBe(true);
      const won = outcomes.flatMap((outcome, i) =>
        outcome.status === "fulfilled" ? [["left", "right"][i]] : [],
      );
      // The live one is a publish that was told it published, or the first, if neither was.
      expect(won.length === 0 ? ["first"] : won, `round ${round}: ${now.title} is live`).toContain(now.title);
      expect(await besides(parent), `round ${round}`).toEqual([]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          const message = (outcome.reason as Error).message;
          expect(message, `round ${round}`).not.toMatch(/publishing-|replaced-|^E[A-Z]+:/);
        }
      }
    }
  });
});

import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTable, parseTableText } from "../src/links.js";
import { stampFor, watchTable } from "../src/table-source.js";

/** Every folder a test makes, removed after it, or each run leaves one per test behind. */
const made: string[] = [];

afterEach(async () => {
  // Best effort: a folder Windows has not let go of yet is not a test failure.
  for (const folder of made.splice(0)) {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});

/**
 * The two ways noticing a changed file goes wrong.
 *
 * Both were found by running the real stack, not by reading. The resolver had a watch on
 * the link table, an operator edit produced nothing, and readiness went on reporting the
 * count it had at boot. Neither case is exotic: one is what every safe writer does, and
 * the other is what a container does on most developer machines.
 */

async function scratch(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "table-source-"));
  made.push(folder);
  return join(folder, "links.json");
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
    const path = join(await scratch(), "..", "absent", "links.json");
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

  it("sees a write that put the modification time straight back", async () => {
    // `rsync -a --inplace`, `cp -p` over an existing file and a restore from backup all
    // preserve mtime. With the same length and the same inode, size and mtime alone were
    // identical and the edit was invisible for good. The watch is closed here because the
    // places this matters, a bind mount and NFS, deliver no events at all.
    const { utimes } = await import("node:fs/promises");
    const fixed = new Date(1_700_000_000_000);
    const path = await scratch();
    await writeFile(path, "aaaaa");
    await utimes(path, fixed, fixed);

    let changes = 0;
    const source = await watchTable(path, {
      pollMs: 30,
      onChange: () => {
        changes++;
      },
    });
    source.stopWatchingForTest();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(changes).toBe(0);

    await writeFile(path, "bbbbb");
    await utimes(path, fixed, fixed);
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

  it("takes a save between the caller's read and the watch as a change", async () => {
    // A caller stamps the file, reads it, then starts watching. A save landing after the read
    // and before the watch's own first stamp was the state the watch started from: the older
    // table was served, the stamp matched the newer file, and nothing would ever report a
    // change. The stamp taken before the read is passed in, so that save is one.
    const path = await scratch();
    await writeFile(path, "1");
    const since = await stampFor(path);
    await writeFile(path, "22");
    let changes = 0;
    const source = await watchTable(path, {
      since,
      pollMs: 60_000,
      onChange: () => {
        changes++;
      },
    });
    await source.check();
    expect(await until(() => changes >= 1, 2000), "the save before the watch was never seen").toBe(true);
    source.stop();
  });

  it("finishes a change it is handling before it says it has stopped, and starts none after", async () => {
    // A reload in flight went on after the stop: the command line read the table and said it had
    // reloaded it after the stop it hands a caller had resolved, every time, against a large table.
    const path = await scratch();
    await writeFile(path, "1");
    let release: () => void = () => undefined;
    const handling = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun = 0;
    let finished = 0;
    const source = await watchTable(path, {
      pollMs: 20,
      onChange: async () => {
        begun++;
        await handling;
        finished++;
      },
    });
    await writeFile(path, "22");
    expect(await until(() => begun === 1), "the change was never noticed").toBe(true);
    let stopped = false;
    const stopping = source.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped, "the stop resolved while a change was still being handled").toBe(false);
    release();
    await stopping;
    expect(finished).toBe(1);
    await writeFile(path, "333");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(begun, "a change was handled after the stop").toBe(1);
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

describe("what a table may not say", () => {
  it("refuses a media type in time however many empty parameters it holds", () => {
    // Spaces that can belong to two places make a pattern's time grow with every ` ; ` added: a
    // second to refuse sixteen of them and an `x`, and the table is checked before the resolver
    // starts. The first value takes the measured second where the spaces are ambiguous.
    const link = { href: "https://a.example/", linkType: "gs1:pip", title: "A", default: true };
    for (const type of [`text/html${" ; ".repeat(16)}x`, `text/html${" ; ".repeat(100_000)}x`]) {
      const started = performance.now();
      expect(() =>
        parseTable({ version: 1, entries: { "/01/09520123456788": [{ ...link, type }] } }),
      ).toThrow(/not a media type/);
      expect(performance.now() - started, `${type.length} characters`).toBeLessThan(250);
    }
  });

  it("reads a table saved with a byte-order mark as one without it", () => {
    // RFC 8259 lets a reader drop the mark, and an editor that saves UTF-8 with one in front wrote
    // a table the resolver would not start on, naming a character nobody can see.
    const text = JSON.stringify({
      version: 1,
      entries: {
        "/01/09520123456788": [
          { href: "https://a.example/", linkType: "gs1:pip", title: "A", default: true },
        ],
      },
    });
    expect(parseTableText(`${String.fromCharCode(0xfeff)}${text}`)).toEqual(parseTableText(text));
  });

  it("refuses two default links of one type under one identifier", () => {
    // Both were accepted, the resolver followed the first, and the linkset published both
    // as `gs1:defaultLink`, so a client reading the linkset and a client following a plain
    // scan disagreed about the same printed code, with nothing saying so.
    expect(() =>
      parseTable({
        version: 1,
        entries: {
          "/01/09520123456788": [
            { href: "https://a.example/", linkType: "gs1:pip", title: "A", default: true },
            { href: "https://b.example/", linkType: "gs1:pip", title: "B", default: true },
          ],
        },
      }),
    ).toThrow(/two default links/);
  });

  it("refuses a title holding a control character or a line break", () => {
    // A title is for a person, shown by whatever reads the linkset to choose a link: a line break
    // splits it wherever it is printed, and a line separator is invisible in the editor of
    // whoever wrote the table.
    // Built from code points rather than written as escapes. Written as escapes they have
    // arrived in this file as the characters themselves twice, which the repository's own
    // sweep for control characters in tracked files then refuses, correctly.
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const nul = String.fromCharCode(0);
    const lineSeparator = String.fromCharCode(0x2028);
    for (const title of [`a${cr}${lf}X-Injected: yes`, `a${nul}b`, `a${lineSeparator}b`]) {
      expect(() =>
        parseTable({
          version: 1,
          entries: {
            "/01/09520123456788": [{ href: "https://a.example/", linkType: "gs1:pip", title, default: true }],
          },
        }),
      ).toThrow(/control character/);
    }
  });

  it("refuses languages, a media type, a default, a link type or a title a scan could not be answered from", () => {
    // The languages are searched for the one a phone asks in, and every browser sends one, so a
    // list that was not a list of tags was a 500 on the commonest scan there is, at any identifier
    // with two links of a type, while readiness said ready. A default written as a string was no
    // default at all, so a plain scan of the code answered that none was set.
    const link = { href: "https://a.example/", linkType: "gs1:pip", title: "A", default: true };
    const table = (fields: Record<string, unknown>) => ({
      version: 1,
      entries: { "/01/09520123456788": [{ ...link, ...fields }] },
    });
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ hreflang: "en" }, /not a list of language tags/],
      [{ hreflang: [44] }, /not a list of language tags/],
      [{ hreflang: [""] }, /not a list of language tags/],
      [{ hreflang: ["en_US"] }, /not a list of language tags/],
      [{ hreflang: ["en", null] }, /not a list of language tags/],
      [{ hreflang: ["*"] }, /not a list of language tags/],
      [{ type: 44 }, /not a media type/],
      [{ type: "" }, /not a media type/],
      [{ type: "html" }, /not a media type/],
      // Spaces only where the grammar has them, after a `;`: not after the type or a parameter.
      [{ type: "text/html  " }, /not a media type/],
      [{ type: "text/html; a=b " }, /not a media type/],
      [{ default: "true" }, /true or false/],
      [{ default: 1 }, /true or false/],
      // A media type broken across lines is not one, and a GS1 link type with no term names
      // nothing in the vocabulary.
      [{ type: `text/html${String.fromCharCode(10)}; charset=utf-8` }, /not a media type/],
      [{ linkType: "gs1:" }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: "https://gs1.org/voc/" }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: "pip" }, /not a GS1 vocabulary term or an absolute URI/],
      // Characters a URI cannot hold, and GS1 terms that are not words: each was accepted and
      // published as a relation name.
      [{ linkType: "urn:a<b>" }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: 'tag:x"y' }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: `urn:${String.fromCharCode(0xe9)}` }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: "urn:a%zz" }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: "gs1:/" }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: "gs1:#" }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: "gs1:<pip>" }, /not a GS1 vocabulary term or an absolute URI/],
      [{ linkType: "https://gs1.org/voc/pip/x" }, /not a GS1 vocabulary term or an absolute URI/],
      // A field this format does not have, which was ignored: a misspelled default set none, and
      // every plain scan of the code answered that no default was set.
      [{ Default: true }, /does not have/],
      [{ hrefLang: ["fr"] }, /does not have/],
      [{ note: "for the spring range" }, /does not have/],
      // The C1 controls are control characters too; U+0085 is a line break to some parsers.
      [{ title: `a${String.fromCharCode(0x85)}b` }, /control character/],
      [{ title: `a${String.fromCharCode(0x9b)}b` }, /control character/],
      // An href with spaces round it, or a tab or a line break inside: `new URL` cleans them
      // away, and the linkset and the log published the href as written.
      [{ href: " https://a.example/ " }, /space or a control character/],
      [{ href: `https://a.example/a${String.fromCharCode(9)}b` }, /space or a control character/],
      [{ href: `https://a.example/a${String.fromCharCode(10)}` }, /space or a control character/],
      [{ href: "https://a.example/a b" }, /space or a control character/],
    ];
    for (const [fields, expected] of refused) {
      expect(() => parseTable(table(fields)), JSON.stringify(fields)).toThrow(expected);
    }
    // And what a table does say is still read.
    for (const fields of [
      { href: "https://a.example/a%20b" },
      // A zero-width non-joiner is part of how Persian is written, so a title holding one is kept.
      { title: `mi${String.fromCharCode(0x200c)}khaham` },
      { linkType: "urn:example:rel" },
      { linkType: "tag:example.com,2026:manual" },
      { hreflang: [] },
      { hreflang: ["en", "fr-CA", "zh-Hant-TW", "es-419"] },
      { type: "text/html" },
      { type: "text/html; charset=utf-8" },
      { type: 'text/html; charset="utf-8"' },
      { type: "application/ld+json" },
      // As RFC 9110 writes a media type: an empty parameter, an escaped quote, and a tab inside a
      // quoted value. Each kept a resolver from starting.
      { type: "text/html;" },
      { type: 'text/html; title="a\\"b"' },
      { type: `text/html; title="a${String.fromCharCode(9)}b"` },
      { type: "text/html; " },
      { linkType: "gs1:recipeInfo" },
      { linkType: "https://example.com/rels/manual?v=2#top" },
      { linkType: "urn:example:a%20b" },
      { default: false },
    ]) {
      expect(() => parseTable(table(fields)), JSON.stringify(fields)).not.toThrow();
    }
  });
});

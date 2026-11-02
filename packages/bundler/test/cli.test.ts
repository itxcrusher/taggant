import { describe, expect, it } from "vitest";
import { EXIT, main, parseArguments } from "../src/cli.js";
import { currentFeatures, currentReport } from "./current-report.js";

describe("parseArguments", () => {
  it("reads a manifest, several targets and an output folder", () => {
    const parsed = parseArguments([
      "m.json",
      "--target",
      "front=f.json",
      "--target",
      "back=b.json",
      "--out",
      "dist",
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.arguments.manifest).toBe("m.json");
    expect(parsed.arguments.targets).toEqual([
      ["front", "f.json"],
      ["back", "b.json"],
    ]);
    expect(parsed.arguments.out).toBe("dist");
  });

  it("refuses a target that does not say which id it is for", () => {
    const parsed = parseArguments(["m.json", "--target", "f.json", "--out", "dist"]);
    expect("error" in parsed && parsed.error).toMatch(/<id>=<file>/);
  });

  it("refuses the same target id twice, rather than quietly taking one", () => {
    const parsed = parseArguments(["m.json", "--target", "a=1.json", "--target", "a=2.json", "--out", "d"]);
    expect("error" in parsed && parsed.error).toMatch(/given twice/);
  });

  it("refuses a flag with no value, and a flag whose value is another flag", () => {
    expect("error" in parseArguments(["m.json", "--out"])).toBe(true);
    expect("error" in parseArguments(["m.json", "--target", "--out", "dist"])).toBe(true);
    // An empty value names nothing: an empty file was said to be unreadable with no name, and an
    // empty folder built the whole bundle in the working folder before it failed.
    expect("error" in parseArguments(["m.json", "--target", "a=1.json", "--out", ""])).toBe(true);
    expect("error" in parseArguments(["m.json", "--target", "a=", "--out", "d"])).toBe(true);
    expect("error" in parseArguments(["", "--target", "a=1.json", "--out", "d"])).toBe(true);
  });

  it("refuses an unknown option instead of ignoring it", () => {
    const parsed = parseArguments(["m.json", "--wat", "1", "--target", "a=1.json", "--out", "d"]);
    expect("error" in parsed && parsed.error).toMatch(/unknown option --wat/);
  });

  it("requires an output folder, so nothing is written by accident", () => {
    expect("error" in parseArguments(["m.json", "--target", "a=1.json"])).toBe(true);
  });

  it("refuses a second manifest rather than bundling the wrong one", () => {
    const parsed = parseArguments(["a.json", "b.json", "--target", "a=1.json", "--out", "d"]);
    expect("error" in parsed && parsed.error).toMatch(/second/);
  });
});

describe("main", () => {
  it("prints usage and exits non-zero with no arguments", async () => {
    expect(await main([])).toBe(EXIT.usage);
  });

  it("reports a manifest it cannot read, with its own exit code, by its name", async () => {
    const said: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["nope.json", "--target", "a=1.json", "--out", "d"])).toBe(EXIT.cannotRead);
    } finally {
      process.stderr.write = write;
    }
    expect(said.join("")).toContain("nope.json could not be read: ENOENT");
  });

  it("reads a manifest and a target saved with a byte-order mark as though they had none", async () => {
    // RFC 8259 lets a reader drop the mark, and a file an editor saved with one was refused as one
    // it could not read, the message naming a character nobody can see.
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "bundle-marked-"));
    const mark = String.fromCharCode(0xfeff);
    await writeFile(join(dir, "manifest.json"), `${mark}{}`);
    await writeFile(join(dir, "front.json"), `${mark}{}`);
    const said: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await main([
        join(dir, "manifest.json"),
        "--target",
        `front=${join(dir, "front.json")}`,
        "--out",
        join(dir, "out"),
      ]);
      // Read, and then refused for what they say, an empty manifest being no experience.
      expect(code, said.join("")).not.toBe(EXIT.cannotRead);
      expect(said.join("")).not.toMatch(/Unexpected token|not valid JSON/);
      // A second mark is not JSON, and the message says which character it is rather than
      // printing one nobody can see.
      said.length = 0;
      await writeFile(join(dir, "manifest.json"), `${mark}${mark}{}`);
      expect(
        await main([
          join(dir, "manifest.json"),
          "--target",
          `front=${join(dir, "front.json")}`,
          "--out",
          join(dir, "out"),
        ]),
      ).toBe(EXIT.cannotRead);
      expect(said.join("")).toContain("\\u{feff}");
      expect(said.join("")).not.toContain(mark);
      expect(said.join("")).toContain(`${join(dir, "manifest.json")} does not parse`);
      // A folder given as a file is said to be one, by its name: with two targets given, the
      // system's "illegal operation on a directory" named none of the three.
      said.length = 0;
      const { mkdir } = await import("node:fs/promises");
      await writeFile(join(dir, "manifest.json"), "{}");
      await mkdir(join(dir, "back.json"));
      expect(
        await main([
          join(dir, "manifest.json"),
          "--target",
          `front=${join(dir, "front.json")}`,
          "--target",
          `back=${join(dir, "back.json")}`,
          "--out",
          join(dir, "out"),
        ]),
      ).toBe(EXIT.cannotRead);
      expect(said.join("")).toContain(`${join(dir, "back.json")} is a folder, not a file.`);
    } finally {
      process.stderr.write = write;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shows what it was given by its code points on a usage error and on a write that failed", async () => {
    // Both name what the command line was given, and a right-to-left override in it reversed the
    // line the terminal printed.
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "bundle-said-"));
    // An experience the bundle gets as far as its destination with, written from the fixtures the
    // bundler's other tests use: copied from the example, it needed the target another package's
    // tests compile, and failed where this package ran alone.
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        id: "postcard",
        title: "Postcard",
        targets: [
          {
            id: "front",
            source: "artwork.png",
            physicalWidthMm: 148,
            content: [{ type: "image", src: "overlay.svg" }],
          },
        ],
      }),
    );
    await writeFile(
      join(dir, "front.target.json"),
      JSON.stringify({
        formatVersion: 2,
        id: "front",
        width: 640,
        height: 452,
        features: currentFeatures(),
        report: await currentReport(),
      }),
    );
    await writeFile(
      join(dir, "overlay.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c33" /></svg>',
    );
    const rlo = String.fromCharCode(0x202e);
    const notes = join(dir, `notes${rlo}.txt`);
    await writeFile(notes, "notes");
    const said: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main([`--out${rlo}`])).toBe(EXIT.usage);
      expect(said.join("")).toContain("unknown option --out\\u{202e}");
      expect(said.join("")).not.toContain(rlo);
      said.length = 0;
      expect(
        await main([
          join(dir, "manifest.json"),
          "--target",
          `front=${join(dir, "front.target.json")}`,
          "--out",
          notes,
        ]),
      ).toBe(EXIT.cannotWrite);
      expect(said.join("")).toContain("notes\\u{202e}.txt is a file, not a folder");
      expect(said.join("")).not.toContain(rlo);
      // A line feed in what was given is written by its code point too, where it printed a line of
      // its own in the middle of the message.
      said.length = 0;
      expect(await main(["--wat\nforged"])).toBe(EXIT.usage);
      expect(said.join("")).toContain("unknown option --wat\\u{a}forged");
      expect(said.join("").split("\n")).not.toContain("forged");
      // So is a file it cannot read, named in front of the system's reason, which names it again.
      said.length = 0;
      expect(
        await main([
          join(dir, "gone\nforged.json"),
          "--target",
          `front=${join(dir, "front.target.json")}`,
          "--out",
          join(dir, "out-gone"),
        ]),
      ).toBe(EXIT.cannotRead);
      expect(said.join("")).toContain("gone\\u{a}forged.json could not be read");
      expect(
        said
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("forged")),
      ).toEqual([]);
      // And on success, where the folder written to was printed as given.
      const printed: string[] = [];
      const out = process.stdout.write;
      process.stdout.write = ((chunk: unknown) => {
        printed.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        expect(
          await main([
            join(dir, "manifest.json"),
            "--target",
            `front=${join(dir, "front.target.json")}`,
            "--out",
            join(dir, `out${rlo}`),
          ]),
        ).toBe(EXIT.ok);
      } finally {
        process.stdout.write = out;
      }
      expect(printed.join("")).toContain("files written to");
      expect(printed.join("")).toContain("out\\u{202e}");
      expect(printed.join("")).not.toContain(rlo);
    } finally {
      process.stderr.write = write;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the command line reached through a link", () => {
  it("runs, as it does when a package manager puts it on the path", async () => {
    // It compared argv[1] with its own module address as text, and through a link the first names
    // the link and the second the file, so it did nothing at all and exited 0. A package manager
    // puts a command line on the path through a link, and pnpm lays out a workspace with them.
    const { spawnSync } = await import("node:child_process");
    const { mkdtemp, rm, rmdir, symlink, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = await mkdtemp(join(tmpdir(), "linked-cli-"));
    const link = join(dir, "dist");
    await symlink(fileURLToPath(new URL("../dist", import.meta.url)), link, "junction");
    try {
      const run = spawnSync(process.execPath, [join(link, "cli.js"), "--help"], { encoding: "utf8" });
      expect(`${run.stdout}${run.stderr}`, "said nothing through the link").toContain("usage:");
      expect(run.status).toBe(0);
      // And named without its extension, which Node runs as the same file.
      const bare = spawnSync(process.execPath, [join(link, "cli"), "--help"], { encoding: "utf8" });
      expect(`${bare.stdout}${bare.stderr}`, "said nothing named without its extension").toContain("usage:");
    } finally {
      // The link alone, never what it points at.
      await unlink(link).catch(() => rmdir(link));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

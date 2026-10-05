import { describe, expect, it } from "vitest";
import { EXIT, main, parseArguments } from "../src/cli.js";

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

  it("reports a manifest it cannot read, with its own exit code", async () => {
    expect(await main(["nope.json", "--target", "a=1.json", "--out", "d"])).toBe(EXIT.cannotRead);
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

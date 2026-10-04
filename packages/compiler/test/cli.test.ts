import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, formatReportLines, main, parseArguments } from "../src/cli.js";

const POSTCARD = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/postcard/artwork.png");

/** The short name Windows keeps beside a long one, where the volume keeps them; else null. */
function shortNameOf(file: string): string | null {
  if (process.platform !== "win32") return null;
  const listing = spawnSync("cmd", ["/c", "dir", "/x", dirname(file)], { encoding: "utf8" }).stdout ?? "";
  const line = listing.split(/\r?\n/).find((row) => row.trimEnd().endsWith(` ${basename(file)}`));
  const short = line?.trim().split(/\s+/).at(-2);
  return short?.includes("~") ? join(dirname(file), short) : null;
}

describe("formatReportLines", () => {
  it("prints the numbers a printer needs, in millimetres", () => {
    const lines = formatReportLines("front.tif", {
      formatVersion: 2,
      id: "front-panel",
      width: 1200,
      height: 800,
      features: [],
      report: {
        score: 82,
        pass: true,
        featureCount: 240,
        areasWithFeatures: 14,
        areas: 16,
        repetition: { places: 5, of: 300, move: { across: 0, down: 0.3, turnDegrees: 0, scale: 1 } },
        analysisWidth: 1200,
        smallestUsableScale: 0.5,
        minimumWidthMm: 62,
        scanDistanceMm: 150,
        recognition: {
          pixelsAcross: 320,
          widths: 5,
          widthsAgreed: 4,
          views: 20,
          misplaced: 0,
          found: true,
          inliers: 58,
          needed: 20,
        },
        reasons: [],
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("front.tif");
    expect(text).toContain("82 / 100");
    expect(text).toContain("62 mm");
    // Beside the verdict, what the verdict was made of. The figure is the middle of the five
    // widths' worst turns, which is what three of them reaching it means; it read "at the middle
    // one", as though it were the worst turn at the middle width.
    expect(text).toContain(
      "every turn found it with 20 or more points agreeing at 4 of 5 widths, and with at least 58 at three of them",
    );
    expect(text).toContain(
      "maps onto itself      no: the most one move carries onto look-alikes is 5 of its 300 places",
    );
  });

  it("lists every reason when the artwork fails", () => {
    const lines = formatReportLines("front.tif", {
      formatVersion: 2,
      id: "front-panel",
      width: 1200,
      height: 800,
      features: [],
      report: {
        score: 20,
        pass: false,
        featureCount: 12,
        areasWithFeatures: 4,
        areas: 16,
        repetition: { places: 0, of: 12, move: null },
        analysisWidth: 1200,
        smallestUsableScale: 0.5,
        minimumWidthMm: 62,
        scanDistanceMm: 150,
        recognition: null,
        reasons: ["too few features to track reliably", "features are concentrated in part of the artwork"],
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("too few features");
    expect(text).toContain("concentrated");
    expect(text).toContain("not ready");
    // Without a cause, which is in the reasons: a distance past the widest piece a manifest can
    // declare stops it here too, and "the artwork did not get that far" blamed the artwork.
    expect(text).toContain("not asked, for the reason below");
  });
});

describe("main", () => {
  it("reports a bad scan distance and exits non-zero instead of printing nonsense", async () => {
    expect(await main(["whatever.png", "--scan-distance", "abc"])).toBe(EXIT.usage);
  });

  it("reports a missing file cleanly rather than throwing a stack trace", async () => {
    expect(await main(["definitely-not-here.png"])).toBe(EXIT.cannotRead);
  });

  it("prints usage and exits non-zero when given no arguments", async () => {
    expect(await main([])).toBe(EXIT.usage);
  });

  it("refuses to write the target over the artwork it was compiled from", async () => {
    // It wrote 158 031 bytes of JSON over a 6 092 byte PNG, printed "written" and exited 0.
    const dir = await mkdtemp(join(tmpdir(), "compile-out-"));
    const art = join(dir, "front.png");
    await copyFile(POSTCARD, art);
    const before = await readFile(art);
    // Spelled differently, where the filesystem folds case, is still the same file.
    const shouting = process.platform === "linux" ? art : join(dir, "FRONT.PNG");
    // And reached another way. Folding case was the whole comparison, and a junction to the
    // artwork's folder, or the short name Windows keeps beside a long one, replaced the artwork
    // with the target and printed "written".
    const via = join(dir, "via");
    await symlink(dir, via, "junction");
    const others = [art, shouting, join(via, "front.png")];
    const short = shortNameOf(art);
    if (short !== null) others.push(short);
    for (const out of others) {
      expect(await main([art, "--scan-distance", "190", "--out", out]), out).toBe(EXIT.usage);
    }
    expect(Buffer.compare(await readFile(art), before)).toBe(0);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("says --out is a folder, rather than naming a file nobody gave it", async () => {
    // A rename onto a folder fails, and the message named the temporary file beside it,
    // `outdir.writing-79b82021`, a name nobody gave the command.
    const dir = await mkdtemp(join(tmpdir(), "compile-out-"));
    const said: string[] = [];
    const wrote = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main([POSTCARD, "--scan-distance", "190", "--out", dir]);
    } finally {
      process.stderr.write = wrote;
    }
    expect(code).toBe(EXIT.cannotWrite);
    expect(said.join("")).toContain("is a folder");
    expect(said.join("")).not.toContain(".writing-");
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("leaves nothing beside the target once it is written", async () => {
    // Written beside its destination and renamed into place, so an interrupted write cannot
    // leave half a target under the right name; and the staging file does not outlive it.
    const dir = await mkdtemp(join(tmpdir(), "compile-out-"));
    const out = join(dir, "front.target.json");
    expect(await main([POSTCARD, "--scan-distance", "190", "--out", out])).toBe(EXIT.ok);
    expect(JSON.parse(await readFile(out, "utf8")).formatVersion).toBe(2);
    expect(await readdir(dir)).toEqual(["front.target.json"]);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("prints usage for --help wherever it is on the line", async () => {
    expect(await main(["art.png", "--help"])).toBe(EXIT.ok);
  });
});

describe("parseArguments", () => {
  function error(args: string[]): string {
    const parsed = parseArguments(args);
    if (!("error" in parsed)) throw new Error(`expected ${args.join(" ")} to be refused`);
    return parsed.error;
  }

  it("refuses a flag with no value instead of quietly using the default", () => {
    expect(error(["art.png", "--scan-distance"])).toMatch(/needs a value/);
    expect(error(["art.png", "--out"])).toMatch(/needs a value/);
  });

  it("refuses a flag whose value is another flag", () => {
    expect(error(["art.png", "--id", "--scan-distance", "900"])).toMatch(/another option/);
  });

  it("refuses an option it does not know, because a typo is not a default", () => {
    expect(error(["art.png", "--scan-distanc", "900"])).toMatch(/unknown option/);
    expect(error(["art.png", "--wat", "1"])).toMatch(/unknown option/);
  });

  it("takes a single dash as an option somebody meant, not as the artwork", () => {
    // `-h` became the artwork, its name the id, and the answer was a rule about ids.
    expect(error(["-h"])).toMatch(/unknown option -h/);
    expect(error(["art.png", "-o", "x.json"])).toMatch(/unknown option -o/);
  });

  it("reads a flag placed before the file", () => {
    const parsed = parseArguments(["--scan-distance", "900", "art.png"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.arguments.source).toBe("art.png");
    expect(parsed.arguments.scanDistanceMm).toBe(900);
  });

  it("takes the last of a repeated flag, as every other command line does", () => {
    const parsed = parseArguments(["art.png", "--scan-distance", "400", "--scan-distance", "900"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.arguments.scanDistanceMm).toBe(900);
  });

  it("refuses a scan distance that is not plain decimal millimetres", () => {
    expect(error(["art.png", "--scan-distance", "0x190"])).toMatch(/number of millimetres/);
    expect(error(["art.png", "--scan-distance", "abc"])).toMatch(/number of millimetres/);
    expect(error(["art.png", "--scan-distance", "1e300"])).toMatch(/number of millimetres/);
  });

  it("refuses a scan distance nobody could stand at", () => {
    expect(error(["art.png", "--scan-distance", "1"])).toMatch(/between 50 and 10000/);
    expect(error(["art.png", "--scan-distance", "50000"])).toMatch(/between 50 and 10000/);
  });

  it("refuses an id the manifest schema would reject, so the two cannot disagree", () => {
    expect(error(["art.png", "--id", "Front Panel"])).toMatch(/lower case letters/);
    expect(error(["art.png", "--id", "ab"])).toMatch(/lower case letters/);
  });

  it("takes the id from the filename when none is given", () => {
    const parsed = parseArguments(["Front-Panel.TIF"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.arguments.id).toBe("front-panel");
  });
});

describe("exit codes", () => {
  it("separates a typing mistake from artwork that cannot be read", async () => {
    expect(await main(["art.png", "--wat"])).toBe(EXIT.usage);
    expect(await main(["definitely-not-here.png"])).toBe(EXIT.cannotRead);
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
    } finally {
      // The link alone, never what it points at.
      await unlink(link).catch(() => rmdir(link));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

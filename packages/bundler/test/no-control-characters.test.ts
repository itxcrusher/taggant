import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * No control character in any tracked text file.
 *
 * This exists because one got in and disabled a security check in silence. A word boundary
 * written into a shell heredoc became a literal backspace, so the pattern meant to refuse an
 * SVG that fetches from another host read:
 *
 *   const remote = withoutNamespaces.match(/[backspace](?:https?:)?\/\/[^\s"'<>)]+/i);
 *
 * It matched nothing. Lint passed, the type checker passed, and printing the built output
 * looked correct, because a terminal does not show the character. Only `cat -A` did. Within
 * the hour the same class put an escape character into a workflow file, which GitHub then
 * refused to parse at all, so that one at least announced itself.
 *
 * Tabs, newlines and carriage returns are ordinary text. Everything else in that range is
 * something nobody typed on purpose.
 */
describe("every tracked text file", () => {
  it("contains no character a person did not mean to type", async () => {
    // Asked of git rather than walked, so generated folders and anything ignored stay out
    // of it without a list of exceptions to keep up to date.
    const { stdout } = await run("git", ["-C", REPO, "ls-files", "-z"], { maxBuffer: 8 * 1024 * 1024 });
    const paths = stdout.split("\0").filter((name) => name.length > 0);
    expect(paths.length, "git listed no files, so this checked nothing").toBeGreaterThan(50);

    // Binary by extension. Reading them as text would report their own bytes as control
    // characters, which is true and useless.
    const binary = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".ico",
      ".mp4",
      ".woff",
      ".woff2",
      ".pdf",
    ]);
    const offenders: string[] = [];
    let looked = 0;
    for (const path of paths) {
      if (binary.has(extname(path).toLowerCase())) continue;
      const text = await readFile(join(REPO, path), "utf8").catch(() => null);
      if (text === null) continue;
      looked++;
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        const ordinary = code === 9 || code === 10 || code === 13;
        if (!ordinary && (code < 32 || code === 127)) {
          const line = text.slice(0, index).split("\n").length;
          offenders.push(`${path}:${line} holds U+${code.toString(16).padStart(4, "0").toUpperCase()}`);
          break;
        }
      }
    }
    expect(looked, "no text files were opened, so this checked nothing").toBeGreaterThan(50);
    expect(offenders, `control characters found: ${offenders.join(", ")}`).toEqual([]);
  }, 120_000);
});

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
 *
 * The second sweep in this file is over the same files for a credential. Nothing in the
 * repository needs a secret: no program in it reads one, and the services are configured
 * by flags. That was a fact about the code and not a property anything enforced, and the
 * way it stops being true is familiar: a key pasted into a script to try something,
 * committed with the script, and live in every clone from then on. The sweep refuses the
 * shapes that are unmistakable, the fixed prefixes vendors put on their keys so that they
 * can be recognised, and the header of a private key. Anything looser would flag the tests
 * and documents that talk about such things, and a check people learn to ignore is worse
 * than none.
 */
const CREDENTIAL_SHAPES: Array<[string, RegExp]> = [
  ["a private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["an OpenAI, OpenRouter or Anthropic key", /\bsk-(?:or-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Stripe key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["a Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/],
];

/** Every tracked file that reads as text, with its content. */
async function trackedText(): Promise<Array<[string, string]>> {
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
    ".avif",
    ".ico",
    ".mp4",
    ".mp3",
    ".wav",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".wasm",
    ".zip",
    ".gz",
    ".pdf",
  ]);
  const files: Array<[string, string]> = [];
  for (const path of paths) {
    if (binary.has(extname(path).toLowerCase())) continue;
    const text = await readFile(join(REPO, path), "utf8").catch(() => null);
    if (text !== null) files.push([path, text]);
  }
  expect(files.length, "no text files were opened, so this checked nothing").toBeGreaterThan(50);
  return files;
}

describe("every tracked text file", () => {
  it("carries no credential", async () => {
    const offenders: string[] = [];
    for (const [path, text] of await trackedText()) {
      for (const [what, shape] of CREDENTIAL_SHAPES) {
        const at = text.search(shape);
        if (at < 0) continue;
        offenders.push(`${path}:${text.slice(0, at).split("\n").length} looks like ${what}`);
        break;
      }
    }
    expect(offenders, `credentials found: ${offenders.join(", ")}`).toEqual([]);
  }, 120_000);

  it("contains no character a person did not mean to type", async () => {
    const offenders: string[] = [];
    for (const [path, text] of await trackedText()) {
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        const ordinary = code === 9 || code === 10 || code === 13;
        // The C0 range is where the backspace came from. It is not the only way to put an
        // invisible character into a pattern, and the others are likelier, because they
        // survive a copy from a web page or a document where a backspace does not: a zero
        // width space in front of the same pattern disables it identically.
        const invisible =
          code === 0x200b || // zero width space
          code === 0x200c || // zero width non joiner
          code === 0x200d || // zero width joiner
          code === 0x2060 || // word joiner
          code === 0xfeff || // byte order mark, anywhere including the head of a file
          code === 0x00a0 || // no break space, which looks exactly like an indent
          (code >= 0x202a && code <= 0x202e) || // bidirectional overrides
          (code >= 0x2066 && code <= 0x2069);
        if (!ordinary && (code < 32 || code === 127 || invisible)) {
          const line = text.slice(0, index).split("\n").length;
          offenders.push(`${path}:${line} holds U+${code.toString(16).padStart(4, "0").toUpperCase()}`);
          break;
        }
      }
    }
    expect(offenders, `control characters found: ${offenders.join(", ")}`).toEqual([]);
  }, 120_000);
});

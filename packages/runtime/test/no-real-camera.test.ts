import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No test in this repository asks a browser for a real camera.
 *
 * This is here because the alternative was tried and it went wrong. Firefox's fake-device
 * preference and Chromium's fake-device flags both stand between a test and real hardware
 * without replacing anything: Firefox accepts a preference name whether or not it exists,
 * Playwright drops those preferences entirely on one of its launch paths, and a flag that
 * stops applying leaves a test that passes while filming whoever ran it. One of them opened
 * the camera of the person working on this.
 *
 * What replaces them is `installCanvasCamera`, which replaces `navigator.mediaDevices`
 * before any page script runs, so there is nothing to fall through to. That is a property
 * of how the tests are written, and a property of how something is written is exactly the
 * kind of thing that decays, so it is checked rather than remembered.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");

/** Every test file in the workspace, wherever it lives. */
async function testFiles(from: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(from, entry.name);
    if (entry.isDirectory()) found.push(...(await testFiles(full)));
    else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.mjs")) found.push(full);
  }
  return found;
}

/** Ways of getting at a camera that are not "replace the API". */
const WAYS_ROUND_IT: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern:
      /--use-fake-device-for-media-stream|--use-file-for-fake-video-capture|--use-fake-ui-for-media-stream/,
    why: "a Chromium launch flag, which does not replace the API and is gone if the flag stops applying",
  },
  {
    pattern: /media\.navigator\.streams\.fake|media\.navigator\.permission\.disabled/,
    why: "a Firefox preference, which Firefox accepts whether or not it exists and Playwright drops on one launch path",
  },
  {
    pattern: /permissions:\s*\[\s*["']camera["']/,
    why: "granting the camera permission, which only matters if something is going to ask for a real one",
  },
  {
    pattern: /grantPermissions\(\s*\[\s*["']camera["']/,
    why: "granting the camera permission, which only matters if something is going to ask for a real one",
  },
];

describe("no test asks a browser for a real camera", () => {
  it("finds test files to check, so this is not passing over an empty list", async () => {
    const files = await testFiles(ROOT);
    // The sweep walks the whole workspace, so a wrong root would make every check below
    // vacuous while reporting success.
    expect(files.length, `no test files were found under ${ROOT}`).toBeGreaterThan(15);
    expect(
      files.some((file) => file.endsWith(`browser${sep}experience.browser.test.ts`)),
      "the sweep did not reach the browser tests, which are the ones this is about",
    ).toBe(true);
  });

  it("uses no launch flag, preference or permission that leaves real hardware reachable", async () => {
    const offending: string[] = [];
    for (const file of await testFiles(ROOT)) {
      // Not this file, which holds every pattern as a literal and would otherwise be the
      // only thing it ever reports. It did, on the first run, which is one way to find out
      // that the sweep reaches things.
      if (file === fileURLToPath(import.meta.url)) continue;
      const text = await readFile(file, "utf8");
      for (const { pattern, why } of WAYS_ROUND_IT) {
        const found = text.match(pattern);
        if (found) offending.push(`${relative(ROOT, file).split(sep).join("/")}: ${found[0]} is ${why}`);
      }
    }
    expect(
      offending,
      "a test is relying on something other than replacing navigator.mediaDevices to keep away from a camera",
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { EXIT, main, parseArguments } from "../src/cli.js";

/**
 * What the command line refuses, and why the origin is one of those things.
 *
 * The origin is the subject of every fact this resolver presents: the linkset anchor, all
 * three `Link` references, and `resolverRoot` in the description file. With none given it
 * used to be taken from the `Host` header, so a request could publish the identity of the
 * operator's products on a host of its own choosing, and the start-up warning about that
 * went into a log at the one moment nobody is reading one. It is required now, and checked,
 * because it is also the remedy the documents name.
 */
describe("the command line", () => {
  it("refuses to start without an origin, and says what one is for", async () => {
    const said: string[] = [];
    const code = await withStderr(said, () => main(["table.json"]));
    expect(code).toBe(EXIT.usage);
    expect(said.join("")).toMatch(/--origin/);
  });

  it("refuses an origin that is not a URL, or is not http, or carries a query", async () => {
    for (const origin of ["not a url at all", "ftp://id.example.com", "https://id.example.com?x=1"]) {
      const said: string[] = [];
      const code = await withStderr(said, () => main(["table.json", "--origin", origin]));
      expect(code, `${origin} was accepted`).toBe(EXIT.usage);
      expect(said.join(""), `${origin} was refused without saying why`).toMatch(/--origin/);
    }
  });

  it("takes the origin off the arguments before anything else looks at it", () => {
    const parsed = parseArguments(["table.json", "--origin", "https://id.example.com"]);
    expect("arguments" in parsed && parsed.arguments.origin).toBe("https://id.example.com");
  });
});

/** Capture what `main` writes to standard error, which is where it says why it refused. */
async function withStderr(into: string[], run: () => Promise<number>): Promise<number> {
  const stderr = await import("node:process").then((process) => process.stderr);
  const original = stderr.write.bind(stderr);
  stderr.write = ((chunk: unknown) => {
    into.push(String(chunk));
    return true;
  }) as typeof stderr.write;
  try {
    return await run();
  } finally {
    stderr.write = original;
  }
}

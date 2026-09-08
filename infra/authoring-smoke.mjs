#!/usr/bin/env node
/**
 * The authoring loop against the running stack.
 *
 * The other smoke test drives a bundle that was published by a command line before the
 * containers started. This one starts from nothing: the console authors an experience,
 * compiles its artwork, publishes it into the folder the static host serves, and writes
 * the table the resolver reads. Then it checks that the other two containers noticed,
 * without being told and without being restarted.
 *
 * It exists because that last step was broken and nothing caught it. The resolver watched
 * its link table with a file watch, which dies the moment the file is replaced by a
 * rename, and which a bind mount often never feeds at all. Everything else passed:
 * readiness was green, the table on disk was correct, and scans went on being answered
 * from the table the process had at boot.
 */

import { readFile, rm, writeFile } from "node:fs/promises";

const CONSOLE = process.env.CONSOLE_ORIGIN ?? "http://127.0.0.1:4000";
const RESOLVER = process.env.RESOLVER_ORIGIN ?? "http://127.0.0.1:8080";
const BUNDLES = process.env.BUNDLES_ORIGIN ?? "http://127.0.0.1:8081";

const ID = "smoke-authored";
/** A GTIN with a valid check digit that the example table does not already carry. */
const CODE = "/01/09520123456771";

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

/**
 * A request that reports a dead container as an answer rather than as a crash.
 *
 * Without this, stopping any one of the three ends the run with a stack trace where the
 * remaining checks should be, which tells whoever is reading the log much less than the
 * list of what did and did not work.
 */
async function ask(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      unreachable: String(error?.cause?.code ?? error?.message ?? error),
      headers: { get: () => null },
      text: async () => "",
      json: async () => ({ status: "unreachable" }),
    };
  }
}

/** A form post from the console's own pages, which is what a browser sends. */
function post(path, body) {
  return ask(`${CONSOLE}${path}`, {
    method: "POST",
    body,
    headers: { "sec-fetch-site": "same-origin" },
    redirect: "manual",
  });
}

/**
 * Whether a form post actually did what it was asked.
 *
 * The status alone does not say: the console answers both a success and the operator's
 * own mistake with the same 303, and puts the difference in the message on the page it
 * redirects to. Checking only the status would have called "that id already exists" a
 * successful creation, which is exactly what a second run of this file produces.
 */
async function did(label, response) {
  if (response.status !== 303) {
    check(
      false,
      label,
      `answered ${response.status}${response.unreachable ? ` (${response.unreachable})` : ""}`,
    );
    return false;
  }
  const page = await (await ask(`${CONSOLE}${response.headers.get("location")}`)).text();
  const complaint = page.match(/<div class="notice bad"[^>]*>\s*<p>([^<]+)</)?.[1];
  check(complaint === undefined, label, complaint ?? "");
  return complaint === undefined;
}

async function until(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await fn();
    if (found !== undefined && found !== null && found !== false) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Everything this run owns, taken back before it starts.
 *
 * The workspace and the bundles folder are bind mounts on the host, so `compose down -v`
 * does not empty them and a second run finds its own leftovers. Which is worth knowing:
 * the first version of this file checked only the status code, and the console answers a
 * refusal with the same 303 as a success, so a re-run reported that it had created an
 * experience that already existed.
 */
const here = new URL(".", import.meta.url);
await rm(new URL(`workspace/${ID}`, here), { recursive: true, force: true });
await rm(new URL(`bundles/${ID}`, here), { recursive: true, force: true });
try {
  const table = JSON.parse(await readFile(new URL("links/links.json", here), "utf8"));
  if (delete table.entries[CODE]) {
    await writeFile(
      new URL("links/links.json", here),
      `${JSON.stringify(table, null, 2)}
`,
    );
  }
} catch {
  // No table yet is the ordinary case on a first run.
}

const artwork = await readFile(new URL("../examples/postcard/artwork.png", import.meta.url));
const overlay = await readFile(new URL("../examples/postcard/overlay.svg", import.meta.url));

console.log(`\n  authoring against ${CONSOLE}\n`);

await did(
  "the console creates an experience",
  await post("/experiences", new URLSearchParams({ id: ID, title: "Authored in the console" })),
);

const target = new FormData();
target.append("targetId", "front");
target.append("physicalWidthMm", "120");
target.append("artwork", new Blob([artwork], { type: "image/png" }), "artwork.png");
await did("artwork is uploaded as a target", await post(`/e/${ID}/targets`, target));

// The compiler is a native module, so this is also the check that it runs in the image.
await did(
  "the artwork compiles inside the container",
  await post(`/e/${ID}/targets/front/compile`, new URLSearchParams({ scanDistanceMm: "350" })),
);

const page = await (await ask(`${CONSOLE}/e/${ID}`)).text();
const verdict = page.match(/<span class="state">([^<]+)</)?.[1];
check(verdict === "Ready for press", "and the verdict reaches the page", verdict ?? "no verdict");

const content = new FormData();
content.append("type", "image");
content.append("file", new Blob([overlay], { type: "image/svg+xml" }), "overlay.svg");
await did("content is added to the target", await post(`/e/${ID}/targets/front/content`, content));

await did("the experience publishes", await post(`/e/${ID}/publish`, new URLSearchParams()));

// A different container, which was never told any of this happened.
const served = await until(async () => {
  const response = await ask(`${BUNDLES}/${ID}/`);
  return response.ok ? await response.text() : null;
});
check(served !== null, "the static host serves what was just published");
check(served?.includes("<script") === true, "and the bundle carries its own runtime");

const before = await ask(`${RESOLVER}${CODE}`, { redirect: "manual" });
check(before.status === 404, "the code is unassigned before it is registered", String(before.status));

await did(
  "the console points the code at the bundle",
  await post(`/e/${ID}/code`, new URLSearchParams({ path: CODE, href: `http://localhost:8081/${ID}/` })),
);

// The claim this file exists for. Nothing restarted the resolver and nothing called it.
const location = await until(async () => {
  const response = await ask(`${RESOLVER}${CODE}`, { redirect: "manual" });
  return response.status === 307 ? response.headers.get("location") : null;
});
check(
  location === `http://localhost:8081/${ID}/`,
  "the resolver answers the new code with no restart",
  location ?? "never picked it up",
);

const ready = await (await ask(`${RESOLVER}/readyz`)).json();
check(ready.status === "ready", "and it is ready on the table it reloaded", JSON.stringify(ready));

console.log(`\n  ${failures === 0 ? "all checks passed" : `${failures} failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;

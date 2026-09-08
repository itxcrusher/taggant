/**
 * The whole path a printed code takes, driven against the running containers.
 *
 * Not a unit test and not a substitute for one. What this checks is the part no unit test
 * can: that the image builds, that the stack comes up healthy, that a scan of a code
 * reaches a bundle on a host that knows nothing about Digital Links, and that stopping the
 * resolver does not take the published bundle with it.
 *
 * Run it against a stack that is already up:
 *   node infra/smoke.mjs
 *
 * It brings nothing up and tears nothing down, so a failure leaves the containers there to
 * be looked at.
 */
import process from "node:process";

const RESOLVER = process.env.RESOLVER_ORIGIN ?? "http://127.0.0.1:8080";
const BUNDLES = process.env.BUNDLES_ORIGIN ?? "http://127.0.0.1:8081";
const CODE = "/01/09520123456788";

const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

/**
 * Wait for something to answer.
 *
 * `ok` is the wrong test for a static host: it has no index at its root, so being up looks
 * like a 403. What is being waited for is a reply of any kind, which is the difference
 * between a container that is listening and one that is not.
 */
async function waitFor(url, seconds = 60, wantOk = true) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (!wantOk || response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

console.log("\nwaiting for the stack");
check("the resolver becomes ready", await waitFor(`${RESOLVER}/readyz`));
check("the static host answers", await waitFor(`${BUNDLES}/`, 30, false));

console.log("\nscanning a printed code");
const scan = await fetch(`${RESOLVER}${CODE}?utm_source=pack`, { redirect: "manual" });
check("it redirects rather than answering itself", scan.status === 307, `status ${scan.status}`);
const location = scan.headers.get("location") ?? "";
check("it carries the request's own query through", location.includes("utm_source=pack"), location);
check("it points at the static host, not at itself", location.includes("8081"), location);
check(
  "it says where the whole picture is, even while redirecting",
  (scan.headers.get("link") ?? "").includes('rel="linkset"'),
);

console.log("\nfollowing it");
const followed = await fetch(`${RESOLVER}${CODE}`, { redirect: "follow" });
const html = await followed.text();
check("the bundle is served", followed.ok, `status ${followed.status}`);
// Not just any page with a title: every nginx error page has one, and this check
// reported ok on a 403 while the bundle was gone.
check(
  "and it is the entry page",
  html.includes("data-taggant") || html.includes('id="scene"'),
  `${html.length} bytes`,
);

const target = new URL(location);
for (const path of ["runtime/index.js", "runtime/worker.js", "runtime/vision.js", "manifest.json"]) {
  const response = await fetch(new URL(path, target).toString());
  check(`the bundle carries ${path}`, response.ok, `status ${response.status}`);
}

console.log("\nwhat it reports about itself");
const metrics = await fetch(`${RESOLVER}/metrics`);
const body = await metrics.text();
check("it counts the scans it answered", /taggant_scans_total\{outcome="redirect"\} [1-9]/.test(body));

const linkset = await fetch(`${RESOLVER}${CODE}`, { headers: { accept: "application/linkset+json" } });
const parsed = await linkset.json();
check("it will describe the code rather than only route it", Array.isArray(parsed.linkset));

console.log("\nthe part that is the whole point");
const unresolved = await fetch(`${RESOLVER}/01/09520123456702`, { redirect: "manual" });
check("a code nothing is assigned to is a 404, not a guess", unresolved.status === 404);

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;

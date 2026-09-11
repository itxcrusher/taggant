import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTarget, toTargetJson } from "@taggant/compiler";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CameraDiagnostics, installCanvasCamera } from "../../../runtime/test/browser/camera-stub.js";
import { artwork, inView } from "../../../runtime/test/browser/feed.js";
import { requiredEngines } from "../../../runtime/test/browser/required.js";
import { bundle } from "../../src/bundle.js";

declare global {
  interface Window {
    taggantExperience?: { threaded: boolean };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = join(here, "../../../runtime/dist");

/**
 * Sized so the camera actually delivers what the compiled target needs.
 *
 * The runtime recognises against a frame reduced to 480 px wide, and a target's smallest
 * size is half the raster it was analysed at, so the artwork has to fill enough of the
 * frame to clear that. Artwork at 480 px in a 640 px frame lands at 360 processed pixels
 * against a target whose smallest size is 320. Getting this wrong looks exactly like a
 * broken tracker and is neither.
 */
const ART = { width: 480, height: 360 };
const FRAME = { width: 640, height: 480 };
/**
 * Deliberately not the middle. At 80,60 the artwork sat exactly centred in the frame, so a
 * pose that ignored recognition entirely and simply centred the target passed every
 * assertion here, as did a pose a quarter too large. A position only means something when
 * being wrong puts it somewhere else.
 */
const PLACED = { x: 24, y: 16 };

const OVERLAY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#e2402a"/></svg>';

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/**
 * Every engine, launched here rather than in a hook, because the cases below are generated
 * from this list and a `describe` body runs first. No launch flags: the camera these tests
 * use is a canvas, so nothing here needs a fake device and nothing here can reach one.
 */
const ENGINES: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];
const started: [string, Browser][] = [];
for (const [name, type] of ENGINES) {
  try {
    started.push([name, await type.launch()]);
  } catch (error) {
    console.warn(
      `served: ${name} could not be launched, so the bundle was not opened in it: ${String(error).slice(0, 300)}`,
    );
  }
}

/**
 * Which engines have to get from a camera to content on the artwork in the bundle, rather
 * than merely report that they could not open one. Chromium always, since it has what a
 * canvas camera needs on every platform; and every engine this machine says it requires,
 * which on CI is all three, because that is what the README claims happens there.
 */
const MUST_OPEN_THE_BUNDLE = new Set(["chromium", ...requiredEngines()]);

let close: (() => Promise<void>) | undefined;
let origin = "";
let outDir = "";
/** Captured before anything can fail, so the cleanup does not depend on getting further. */
let scratchRoot = "";
/** The camera frame, as base64, because it crosses into an init script. */
let frame64 = "";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "taggant-served-"));
  scratchRoot = root;
  const sourceDir = join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "overlay.svg"), OVERLAY);
  outDir = join(root, "out");

  const art = artwork(ART.width, ART.height);
  // Compiled by the real compiler rather than described directly, so this test is also the
  // only place the two halves of the system meet: artwork in one end, recognised out of the
  // other. Building targets by hand everywhere else is what let a change that made nothing
  // recognisable pass every test.
  const artworkPng = await sharp(Buffer.from(art.data), {
    raw: { width: art.width, height: art.height, channels: 1 },
  })
    .png()
    .toBuffer();
  const compiled = await compileTarget(artworkPng, { id: "front", scanDistanceMm: 350 });
  await bundle({
    manifest: {
      schemaVersion: "1.0.0",
      id: "served",
      title: "Served bundle",
      targets: [
        {
          id: "front",
          source: "artwork.png",
          physicalWidthMm: 148,
          content: [{ type: "image", src: "overlay.svg" }],
        },
      ],
    },
    targets: { front: toTargetJson(compiled) },
    sourceDir,
    outDir,
    runtimeDir: RUNTIME_DIST,
  });

  frame64 = Buffer.from(inView(art, FRAME.width, FRAME.height, PLACED.x, PLACED.y).data).toString("base64");

  // A plain static server over the bundle folder and nothing else. No resolver, no
  // console, no package registry, no path outside this directory. If the bundle needs
  // anything that is not in it, this is where that shows up.
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const parts = path.split("/").filter((part) => part && part !== "." && part !== "..");
    try {
      const body = await readFile(join(outDir, ...parts));
      response
        .writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a bound port");
  origin = `http://127.0.0.1:${address.port}`;

  close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}, 180_000);

afterAll(async () => {
  // All of it outside `close`, and none of it able to stop the rest. `close` is assigned at
  // the end of a hook that compiles artwork and builds a bundle first, so anything failing
  // before that left the browsers running and the directory behind; and one rejecting
  // `close()` used to orphan every browser after it.
  for (const [, instance] of started) await instance.close().catch(() => undefined);
  await close?.().catch(() => undefined);
  if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** The first engine that started, for the cases that are not about engine differences. */
function anyBrowser(): Browser {
  const first = started[0]?.[1];
  if (!first) throw new Error("no browser engine could be launched");
  return first;
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(full);
  }
  return found;
}

describe("a published bundle", () => {
  it("was opened in the engines this machine says it must", () => {
    const names = started.map(([name]) => name);
    const missing = requiredEngines().filter((name) => !names.includes(name));
    expect(
      missing,
      `TAGGANT_REQUIRE_ENGINES asks for ${requiredEngines().join(", ")} and ${missing.join(", ")} did not launch, so the bundle was opened in fewer engines than claimed`,
    ).toEqual([]);
    expect(
      started.length,
      "no browser engine could be launched, so the bundle was never opened",
    ).toBeGreaterThan(0);
  });

  /**
   * The bundle is the thing a viewer actually gets: a folder on a static host, opened by
   * whatever browser their phone has. It was opened in Chromium alone, because Chromium is
   * the only engine that can be handed a video file to play as a camera, and that left the
   * one artifact this project ships checked in one engine.
   *
   * No engine is asked for a camera. `navigator.mediaDevices` is replaced before any page
   * script runs with one returning a canvas the artwork has been drawn into, so there is no
   * path from here to hardware, and the frame contains the artwork so the whole path runs:
   * the page loads from the folder, its modules resolve, its worker starts, recognition
   * happens, and the content lands where the frame put the artwork.
   */
  it.each(started)(
    "runs from a static folder with everything else switched off in %s",
    async (engine, browser) => {
      // The viewport matches the frame, so a position in the page can be compared with the
      // position the frame put the artwork at. The runtime scales the pose from the size it
      // tracked at to the size it is shown at, which is correct and would otherwise make
      // these two numbers describe different spaces.
      const context = await browser.newContext({ viewport: { width: FRAME.width, height: FRAME.height } });
      const page = await context.newPage();
      try {
        await page.addInitScript(installCanvasCamera, frame64);

        const failures: string[] = [];
        page.on("pageerror", (error) => failures.push(String(error)));
        // Anything the page asks for that this folder does not hold is a broken promise.
        const missing: string[] = [];
        page.on("response", (response) => {
          if (response.status() === 404) missing.push(response.url());
        });
        // And any request that leaves this origin at all.
        const offsite: string[] = [];
        page.on("request", (request) => {
          if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
            offsite.push(request.url());
        });

        await page.goto(`${origin}/index.html`);
        // Whichever the page settles on. Which of the two is correct is decided by what the
        // stub proved about this engine, by trying it rather than by looking for the APIs:
        // both are present in WebKit on Linux and the stream never becomes a picture there.
        await page.waitForFunction(
          () => {
            const state = document.querySelector("#scene")?.getAttribute("data-state");
            return state === "tracking" || state === "error" || state === "denied";
          },
          undefined,
          { timeout: 90_000 },
        );
        const camera = await page.evaluate(
          () => (window as unknown as { cameraDiagnostics?: CameraDiagnostics }).cameraDiagnostics,
        );
        // What the page settled on. Whether an engine can use a canvas as a camera is not
        // something to decide beforehand: both APIs are present in WebKit on Linux and the
        // stream may never become a picture there, and a trial with a video element of its
        // own was stricter than the runtime's and called engines incapable that may not be.
        const settledState = await page.evaluate(
          () => document.querySelector("#scene")?.getAttribute("data-state") ?? "",
        );
        const capable = settledState === "tracking";
        if (MUST_OPEN_THE_BUNDLE.has(engine)) {
          expect(
            capable,
            `${engine} is required to open the bundle and reach content on the artwork, and stopped at "${settledState}": ${JSON.stringify(camera)}`,
          ).toBe(true);
        }

        if (!capable) {
          // No canvas camera here. What the bundle still has to do is say so on the page
          // rather than leave whoever scanned a printed code reading "Starting" for ever.
          // Read in one call, so the state and the words cannot come from two moments.
          const both = await page.evaluate(() => ({
            state: document.querySelector("#scene")?.getAttribute("data-state") ?? "",
            status: document.getElementById("status")?.textContent ?? "",
          }));
          console.log(
            `engine-line ${engine}: a canvas was not a camera here, the bundle says "${both.status}" in state ${both.state} after ${camera?.called ?? 0} request(s), stream ${camera?.tracks || "none"} ${camera?.settings || ""}`,
          );
          // The stub was in place: either this engine offered nothing to replace, or the
          // replacement was asked for a camera. Without it, an init script that never ran
          // and a real camera refused by the browser look the same from here, and "denied"
          // is exactly what that produces, which is why it is not accepted.
          const offered = await page.evaluate(() => navigator.mediaDevices !== undefined);
          expect(
            offered ? (camera?.called ?? 0) > 0 : true,
            "this engine has a camera API and the stub was never asked for one, so something else answered",
          ).toBe(true);
          expect(both.state).toBe("error");
          expect(both.status).not.toMatch(/^Starting/);
          expect(missing).toEqual([]);
          expect(offsite).toEqual([]);
          expect(failures).toEqual([]);
          return;
        }

        await page
          .waitForFunction(
            () => document.querySelector("#scene")?.getAttribute("data-state") === "tracking",
            undefined,
            // Already settled on tracking above; this only reads it back.
            { timeout: 5_000 },
          )
          .catch(async (error) => {
            const stuck = await page.evaluate(() => {
              const video = document.querySelector("#scene video") as HTMLVideoElement | null;
              return {
                state: document.querySelector("#scene")?.getAttribute("data-state") ?? "none",
                status: document.getElementById("status")?.textContent ?? "",
                video: video
                  ? `${video.videoWidth}x${video.videoHeight} ready ${video.readyState} paused ${video.paused}`
                  : "no video element",
                camera: (window as unknown as { cameraDiagnostics?: CameraDiagnostics }).cameraDiagnostics,
              };
            });
            throw new Error(
              `${engine} never reached tracking in the published bundle: stopped at "${stuck.state}", status "${stuck.status}", video ${stuck.video}, camera ${JSON.stringify(stuck.camera)}, 404s ${JSON.stringify(missing)}, offsite ${JSON.stringify(offsite)}, page errors ${JSON.stringify(failures)} (${String(error).slice(0, 120)})`,
            );
          });

        const overlay = page.locator('[data-taggant-target="front"]');
        expect(await overlay.count()).toBe(1);
        expect(await overlay.isHidden()).toBe(false);
        const box = await overlay.boundingBox();
        if (!box) throw new Error("expected the overlay to have a box");

        // What is inside it, and whether the work happened off the page's thread. A bundle
        // whose worker is present and answers nothing still reaches tracking, on the page's
        // thread, with a five second wait per frame; and content this build cannot show
        // leaves an overlay with nothing in it at all. Both passed before these two lines.
        const shown = await page.evaluate(() => {
          const holder = document.querySelector('[data-taggant-target="front"]');
          const image = holder?.querySelector("img");
          return {
            children: holder?.childElementCount ?? 0,
            image: image ? `${image.naturalWidth}x${image.naturalHeight}` : "none",
            threaded: window.taggantExperience?.threaded,
          };
        });

        console.log(
          `engine-line ${engine}: the bundle tracked, content ${box.width.toFixed(0)}x${box.height.toFixed(0)} at ${box.x.toFixed(0)},${box.y.toFixed(0)} against artwork ${ART.width}x${ART.height} at ${PLACED.x},${PLACED.y}, image ${shown.image}, worker ${shown.threaded ? "in a thread" : "ON THE PAGE THREAD"}, ${missing.length} missing, ${offsite.length} offsite`,
        );
        expect(Math.abs(box.x - PLACED.x)).toBeLessThan(40);
        expect(Math.abs(box.y - PLACED.y)).toBeLessThan(40);
        // The container and the frame are the same size, so the content is shown at the
        // size it was tracked at. Without this a pose a quarter too large passed.
        expect(Math.abs(box.width - ART.width)).toBeLessThan(ART.width * 0.15);
        expect(Math.abs(box.height - ART.height)).toBeLessThan(ART.height * 0.15);
        expect(shown.children, "the overlay is there and empty, so a viewer sees nothing").toBeGreaterThan(0);
        expect(shown.image, "the content image did not load").not.toBe("none");
        expect(shown.image, "the content image loaded as nothing").not.toBe("0x0");
        expect(
          shown.threaded,
          "the bundle recognised on the page's thread, which is the silent fallback",
        ).toBe(true);

        // And the frames came from the canvas rather than from anywhere else. Read on the
        // success path, because a diagnostic only read when a test fails is not evidence.
        expect(camera?.called ?? 0, "the stub was never asked for a camera").toBeGreaterThan(0);
        expect(missing).toEqual([]);
        expect(offsite).toEqual([]);
        expect(failures).toEqual([]);
      } finally {
        await context.close();
      }
    },
    180_000,
  );

  it("holds no absolute reference to anywhere in the code it ships", async () => {
    const files = await walk(outDir);
    // Over the bundle it just built, so an empty list means the bundle is empty rather
    // than clean.
    expect(files.length, "the published folder held no files, so nothing was examined").toBeGreaterThan(4);
    const offending: string[] = [];
    for (const file of files) {
      if (![".html", ".js"].includes(extname(file))) continue;
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
        // An XML namespace is a name, not an address, and nothing fetches it.
        if (match[0].startsWith("http://www.w3.org/")) continue;
        offending.push(`${relative(outDir, file).split(sep).join("/")}: ${match[0]}`);
      }
    }
    expect(offending).toEqual([]);
  });
});

describe("a bundle that cannot start", () => {
  // The page used to do its work at the top of the module. A module that throws while it
  // is being evaluated is a page error, not a rejection, so the unhandledrejection handler
  // never fired: whoever scanned a printed code was left reading "Starting." with the
  // reason in a console they do not have, and the fallback the manifest exists to provide
  // was never reached. That is worse than a camera which will not open.
  //
  // Two cases rather than one, because following the fallback destroys the page: asserting
  // on the message and on the navigation in the same run is a race with the navigation.
  const breakTheTarget = async () => {
    const targetPath = join(outDir, "targets", "front.json");
    const good = await readFile(targetPath, "utf8");
    // Valid JSON, wrong shape: exactly how an unreadable target arrives.
    await writeFile(targetPath, JSON.stringify({ formatVersion: 99 }));
    return () => writeFile(targetPath, good);
  };
  const setFallback = async (value: string | undefined) => {
    const manifestPath = join(outDir, "manifest.json");
    const good = await readFile(manifestPath, "utf8");
    const { fallback: _existing, ...rest } = JSON.parse(good);
    const manifest = value === undefined ? rest : { ...rest, fallback: value };
    await writeFile(manifestPath, JSON.stringify(manifest));
    return () => writeFile(manifestPath, good);
  };

  it("says so, instead of leaving the viewer on Starting forever", async () => {
    const restoreTarget = await breakTheTarget();
    const restoreManifest = await setFallback(undefined);
    const page = await anyBrowser().newPage();
    // This page opens the real bundle, which asks for a camera. It is safe today only
    // because a broken target stops the page before it gets there, which is not a
    // guarantee anybody wrote down. The stub makes it one.
    await page.addInitScript(installCanvasCamera, frame64);
    try {
      await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => !(document.getElementById("status")?.textContent ?? "").startsWith("Starting"),
        undefined,
        { timeout: 20_000 },
      );
      expect(await page.textContent("#status")).toContain("could not be loaded");
      expect(await page.getAttribute("#scene", "data-state")).toBe("error");
    } finally {
      await page.close().catch(() => undefined);
      await restoreTarget();
      await restoreManifest();
    }
  }, 60_000);

  it("sends the viewer where the manifest says to go", async () => {
    const restoreTarget = await breakTheTarget();
    const restoreManifest = await setFallback(`${origin}/fallback-reached`);
    const page = await anyBrowser().newPage();
    // This page opens the real bundle, which asks for a camera. It is safe today only
    // because a broken target stops the page before it gets there, which is not a
    // guarantee anybody wrote down. The stub makes it one.
    await page.addInitScript(installCanvasCamera, frame64);
    try {
      await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/fallback-reached/, { timeout: 20_000 });
      expect(page.url()).toContain("/fallback-reached");
    } finally {
      await page.close().catch(() => undefined);
      await restoreTarget();
      await restoreManifest();
    }
  }, 60_000);
});

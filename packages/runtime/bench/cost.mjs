/**
 * What one recognition call costs, in a browser, on the example.
 *
 * The runtime's design rests on a cost: finding artwork in a frame is expensive enough that
 * doing it on the page's thread stops the page. That is a number, and a number stated in a
 * README without a way to produce it goes stale silently, so this produces it.
 *
 * It is not a test and it does not run in the gate. A timing assertion on a shared machine
 * measures the machine, which is exactly the mistake the frame pacing check in
 * `test/browser/experience.browser.test.ts` was cut back for. Run it by hand:
 *
 *     pnpm --filter @taggant/runtime build
 *     pnpm --filter @taggant/vision build
 *     node packages/compiler/dist/cli.js examples/postcard/artwork.png --id postcard --out <file>
 *     node packages/runtime/bench/cost.mjs <file>
 *
 * The artwork is decoded by the browser and drawn at the width the print readiness report
 * says it is read at, inside a 480 by 360 frame, which is the size the runtime asks a camera
 * for. Both cases are measured: a frame the artwork is in, which hits on the first scale,
 * and a frame it is not, which pays for every scale before giving up.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const target = process.argv[2];
if (!target) {
  console.error("usage: node packages/runtime/bench/cost.mjs <compiled target file>");
  process.exit(2);
}

const FRAME = { width: 480, height: 360 };
const SAMPLES = 41;

const files = new Map([
  [
    "/vision.js",
    { body: await readFile(join(REPO, "packages/vision/dist/index.js")), type: "text/javascript" },
  ],
  ["/target.json", { body: await readFile(resolve(target)), type: "application/json" }],
  ["/artwork.png", { body: await readFile(join(REPO, "examples/postcard/artwork.png")), type: "image/png" }],
  [
    "/page.html",
    {
      body: Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>cost</title><canvas id="c"></canvas>' +
          '<script type="module">import * as vision from "/vision.js"; window.vision = vision; window.ready = true;</script>',
      ),
      type: "text/html",
    },
  ],
]);

const server = createServer((request, response) => {
  const file = files.get((request.url ?? "").split("?")[0]);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": file.type }).end(file.body);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${origin}/page.html`);
await page.waitForFunction(() => window.ready === true);

const measured = await page.evaluate(
  async ({ width, height, samples }) => {
    const stored = await (await fetch("/target.json")).json();
    const target = window.vision.fromTargetFile(stored);

    const image = new Image();
    image.src = "/artwork.png";
    await image.decode();
    const across = Math.min(320, width);
    const down = Math.round((image.naturalHeight / image.naturalWidth) * across);
    const canvas = document.getElementById("c");
    canvas.width = across;
    canvas.height = down;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, across, down);
    const pixels = context.getImageData(0, 0, across, down).data;

    const data = new Uint8Array(width * height).fill(140);
    const ox = Math.floor((width - across) / 2);
    const oy = Math.floor((height - down) / 2);
    for (let y = 0; y < down; y++) {
      for (let x = 0; x < across; x++) {
        const p = (y * across + x) * 4;
        data[(y + oy) * width + (x + ox)] = Math.round(
          0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2],
        );
      }
    }

    const time = (frame, count) => {
      window.vision.locate(frame, target);
      const times = [];
      for (let i = 0; i < count; i++) {
        const at = performance.now();
        window.vision.locate(frame, target);
        times.push(performance.now() - at);
      }
      times.sort((a, b) => a - b);
      return {
        median: times[Math.floor(times.length / 2)],
        fastest: times[0],
        slowest: times[times.length - 1],
      };
    };

    const present = { width, height, data };
    const absent = { width, height, data: new Uint8Array(width * height).fill(140) };
    const first = window.vision.locate(present, target);
    return {
      features: target.features.length,
      across,
      down,
      found: first.found,
      inliers: first.inliers,
      hit: time(present, samples),
      miss: time(absent, Math.ceil(samples / 2)),
    };
  },
  { width: FRAME.width, height: FRAME.height, samples: SAMPLES },
);

const ms = (value) => `${value.toFixed(1)} ms`;
console.log(`target            ${measured.features} features`);
console.log(
  `frame             ${FRAME.width} by ${FRAME.height}, artwork drawn ${measured.across} by ${measured.down}`,
);
console.log(`recognised        ${measured.found} on ${measured.inliers} inliers`);
console.log(
  `artwork in view   median ${ms(measured.hit.median)} (fastest ${ms(measured.hit.fastest)}, slowest ${ms(measured.hit.slowest)}) over ${SAMPLES}`,
);
console.log(`artwork absent    median ${ms(measured.miss.median)}`);
if (!measured.found) {
  console.error("the artwork was not recognised, so the timing above is not the cost of recognising it");
  process.exitCode = 1;
}

await browser.close();
server.close();

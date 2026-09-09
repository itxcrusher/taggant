#!/usr/bin/env node
/**
 * Does a change to recognition change recognition?
 *
 * Run:
 *   node packages/vision/bench/recognition.mjs
 *   node packages/vision/bench/recognition.mjs <folder of artwork>
 *
 * This exists because descriptor quality is not the same thing as recognition, and it is
 * easy to improve the first and report it as the second. A change to the descriptor's
 * sampling pattern once measured better on every quality figure taken (bit balance, dead
 * bits, separation between distinct features) and moved recognition by four trials in 336,
 * which is nothing: the matcher already applies a ratio test, a mutual best check, a 72
 * bit ceiling and a ten inlier floor, and those absorb descriptor quality before it
 * reaches a decision.
 *
 * So this measures the decision, not the descriptor. Run it before and after any change to
 * detection, description, matching or pose fitting, and compare the two numbers.
 *
 * It uses generated artwork plus whatever is in the folder given, if one is. Ten or more
 * real pieces are worth far more than the generated set: the generated set understated the
 * effect of that pattern change in one direction and overstated it in another.
 */

import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyHomography, buildTrackingFeatures, detectCorners, locate } from "../dist/index.js";

/** Worst artwork-corner error, in frame pixels, that still counts as found. */
const ACCEPT_PX = 25;
const FRAME = 640;

const conditions = [];
for (const scale of [0.9, 0.7, 0.55, 0.45]) conditions.push({ name: `scale ${scale}`, scale, angle: 0 });
for (const deg of [15, 45, 90, 135, 180]) {
  conditions.push({ name: `rotated ${deg}`, scale: 0.8, angle: (deg * Math.PI) / 180 });
}
for (const blur of [1, 2, 3]) conditions.push({ name: `blur ${blur}`, scale: 0.8, angle: 0.2, blur });
for (const noise of [10, 20, 30]) conditions.push({ name: `noise ${noise}`, scale: 0.8, angle: 0.2, noise });
for (const occlude of [0.3, 0.5])
  conditions.push({ name: `occluded ${occlude}`, scale: 0.85, angle: 0.1, occlude });
for (const p of [0.00015, 0.0003])
  conditions.push({ name: `perspective ${p}`, scale: 0.8, angle: 0.3, perspective: p });
conditions.push({ name: "far, turned, blurred", scale: 0.55, angle: 1.1, blur: 1, noise: 12 });
conditions.push({ name: "worst case", scale: 0.45, angle: 2.4, blur: 2, noise: 18, occlude: 0.25 });

function invert([a, b, c, d, e, f, g, i, j]) {
  const A = e * j - f * i;
  const B = f * g - d * j;
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    (c * i - b * j) / det,
    (b * f - c * e) / det,
    B / det,
    (a * j - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * i) / det,
    (a * e - b * d) / det,
  ];
}

/** Where the artwork sits in the frame: scaled, turned, and optionally leaning away. */
function placement(image, { scale, angle, perspective = 0 }) {
  const s = (scale * FRAME) / Math.max(image.width, image.height);
  const cos = Math.cos(angle) * s;
  const sin = Math.sin(angle) * s;
  return [
    cos,
    -sin,
    FRAME / 2 - (cos * image.width - sin * image.height) / 2,
    sin,
    cos,
    FRAME / 2 - (sin * image.width + cos * image.height) / 2,
    perspective / image.width,
    perspective / image.height,
    1,
  ];
}

function render(image, h, { blur = 0, noise = 0, occlude = 0 }) {
  const out = new Uint8Array(FRAME * FRAME).fill(128);
  const inv = invert(h);
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      const [sx, sy] = applyHomography(inv, x + 0.5, y + 0.5);
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const xi = Math.min(image.width - 1, Math.max(0, Math.round(sx - 0.5)));
      const yi = Math.min(image.height - 1, Math.max(0, Math.round(sy - 0.5)));
      out[y * FRAME + x] = image.data[yi * image.width + xi];
    }
  }
  for (let pass = 0; pass < blur; pass++) {
    const copy = Uint8Array.from(out);
    for (let y = 1; y < FRAME - 1; y++) {
      for (let x = 1; x < FRAME - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) sum += copy[(y + dy) * FRAME + x + dx];
        out[y * FRAME + x] = sum / 9;
      }
    }
  }
  if (noise > 0) {
    // Deterministic, so two runs of this bench compare like with like.
    let seed = 20260909;
    for (let i = 0; i < out.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      out[i] = Math.max(0, Math.min(255, out[i] + (((seed >>> 0) / 0x1_0000_0000) * 2 - 1) * noise));
    }
  }
  if (occlude > 0) {
    const wide = Math.round(FRAME * occlude);
    for (let y = 0; y < FRAME; y++) for (let x = 0; x < wide; x++) out[y * FRAME + x] = 90;
  }
  return { width: FRAME, height: FRAME, data: out };
}

/** Blots, which have corners rather than only edges. Stands in for artwork with detail. */
function generated(size, count, radius, seed) {
  const data = new Uint8Array(size * size).fill(232);
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fff_ffff;
    return s;
  };
  for (let i = 0; i < count; i++) {
    const cx = next() % size;
    const cy = next() % size;
    const value = next() % 2 === 0 ? 24 : 130;
    for (let y = Math.max(0, cy - radius); y < Math.min(size, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x < Math.min(size, cx + radius); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius && x >= cx - radius / 2) {
          data[y * size + x] = value;
        }
      }
    }
  }
  return { width: size, height: size, data };
}

async function corpus(folder) {
  const images = [
    { name: "generated, fine", image: generated(520, 220, 14, 987654321) },
    { name: "generated, coarse", image: generated(520, 90, 30, 123456789) },
  ];
  // The example artwork, so a bare run still measures something real.
  const example = fileURLToPath(new URL("../../../examples/postcard/artwork.png", import.meta.url));
  const { loadGrayscale } = await import("../../compiler/dist/index.js").catch(() => ({}));
  if (loadGrayscale) {
    try {
      images.push({ name: "example postcard", image: await loadGrayscale(await readFile(example)) });
    } catch {
      // The example is optional; a checkout without a built compiler still runs.
    }
    if (folder) {
      for (const name of (await readdir(folder)).sort()) {
        if (![".png", ".jpg", ".jpeg", ".webp"].includes(extname(name).toLowerCase())) continue;
        try {
          const image = await loadGrayscale(await readFile(join(folder, name)));
          if (detectCorners(image).length >= 40) images.push({ name: name.slice(0, 20), image });
        } catch {
          // Not an image this can read. Skipped rather than fatal.
        }
      }
    }
  }
  return images;
}

const folder = process.argv[2];
const images = await corpus(folder);
console.log(
  `\n  ${images.length} images x ${conditions.length} conditions = ${images.length * conditions.length} trials`,
);
console.log(`  found means a pose whose worst artwork corner is within ${ACCEPT_PX} px of the truth\n`);

const perCondition = new Map(conditions.map((c) => [c.name, { found: 0, total: 0 }]));
const errors = [];
let found = 0;
let trials = 0;
let wrong = 0;

for (const { image } of images) {
  const target = {
    id: "bench",
    width: image.width,
    height: image.height,
    features: buildTrackingFeatures(image),
  };
  for (const condition of conditions) {
    const truth = placement(image, condition);
    const result = locate(render(image, truth, condition), target);
    const tally = perCondition.get(condition.name);
    trials++;
    tally.total++;
    if (!result.found || !result.homography) continue;
    let worst = 0;
    for (const [x, y] of [
      [0, 0],
      [image.width, 0],
      [0, image.height],
      [image.width, image.height],
    ]) {
      const [ax, ay] = applyHomography(result.homography, x, y);
      const [bx, by] = applyHomography(truth, x, y);
      worst = Math.max(worst, Math.hypot(ax - bx, ay - by));
    }
    if (worst < ACCEPT_PX) {
      found++;
      tally.found++;
      errors.push(worst);
    } else {
      // A pose was returned and it was wrong. Worse than not finding it, because the
      // content lands somewhere on the page and the viewer is told it worked.
      wrong++;
    }
  }
}

for (const [name, tally] of perCondition) {
  const bar = "#".repeat(Math.round((20 * tally.found) / tally.total)).padEnd(20, ".");
  console.log(`  ${name.padEnd(22)} ${bar} ${tally.found}/${tally.total}`);
}

errors.sort((a, b) => a - b);
const median = errors[Math.floor(errors.length / 2)] ?? 0;
const mean = errors.reduce((a, b) => a + b, 0) / (errors.length || 1);
console.log(`\n  found            ${found} of ${trials} (${((100 * found) / trials).toFixed(1)}%)`);
console.log(`  wrong pose taken ${wrong}`);
console.log(`  corner error     median ${median.toFixed(2)} px, mean ${mean.toFixed(2)} px`);
console.log("\n  Compare two runs, not one. A few trials either way is noise.\n");

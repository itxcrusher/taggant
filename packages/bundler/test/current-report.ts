import { type Report, buildReport } from "@taggant/compiler";
import type { TargetFeature } from "@taggant/vision";

/**
 * A report as the compiler writes it today, for artwork the recogniser confirms at the smallest
 * size its target covers, read back through JSON as it is stored.
 *
 * Built by the compiler rather than written out by hand, because the gate is now the compiler's
 * own check of a stored report, and a hand-written fixture is a guess at that check: the ones
 * these replaced had no score and no verdict, and the gate they were written against let them
 * through. Tests change the one field they are about and keep the rest.
 */
export async function currentReport(changes: Partial<Report> = {}, scanDistanceMm = 190): Promise<Report> {
  const corners: { x: number; y: number; strength: number }[] = [];
  for (let y = 40; y < 452; y += 40)
    for (let x = 40; x < 640; x += 40) corners.push({ x, y, strength: 1000 });
  const report = await buildReport({
    image: { width: 640, height: 452 },
    levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners })),
    // Measured over features nothing repeats in, one at each corner described unlike the rest,
    // as a report written for artwork that does not repeat itself is.
    features: unrepeated(corners),
    scanDistanceMm,
    recognises: () => [{ found: true, inliers: 58, misplaced: false }],
  });
  return { ...JSON.parse(JSON.stringify(report)), ...changes };
}

/** A feature at each point, each described unlike the others, so that nothing repeats. */
function unrepeated(points: Array<{ x: number; y: number }>): TargetFeature[] {
  let seed = 3;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    return seed;
  };
  return points.map(({ x, y }) => {
    const descriptor = new Uint32Array(8);
    for (let w = 0; w < 8; w++) descriptor[w] = (next() ^ (next() << 16)) >>> 0;
    return { x, y, strength: 1, angle: 0.3, scale: 1, descriptor };
  });
}

/**
 * The scan distance at which this report asks for a given width, for a test that needs the
 * width to be a particular number. The width is worked out from the distance and checked
 * against it, so editing the width alone now makes a report this build does not stand behind.
 */
export async function reportAskingFor(widthMm: number): Promise<Report> {
  for (let distance = 50; distance <= 10_000; distance++) {
    const report = await currentReport({}, distance);
    if (report.minimumWidthMm === widthMm) return report;
    if ((report.minimumWidthMm ?? 0) > widthMm) break;
  }
  throw new Error(`no scan distance gives this fixture a minimum width of ${widthMm} mm`);
}

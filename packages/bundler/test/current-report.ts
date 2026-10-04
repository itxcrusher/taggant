import { type Report, buildReport } from "@taggant/compiler";

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
    // Measured over no features, which nothing repeats in: the report says so as one written for
    // artwork that does not repeat itself would.
    features: [],
    scanDistanceMm,
    recognises: () => [{ found: true, inliers: 58, misplaced: false }],
  });
  return { ...JSON.parse(JSON.stringify(report)), ...changes };
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

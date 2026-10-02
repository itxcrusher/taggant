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
    scanDistanceMm,
    recognises: () => [{ found: true, inliers: 58, misplaced: false }],
  });
  return { ...JSON.parse(JSON.stringify(report)), ...changes };
}

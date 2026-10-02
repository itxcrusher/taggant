import type { Corner } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import {
  type View,
  buildReport,
  carriesItsDistance,
  describeWidth,
  distanceBehind,
  isCurrentReport,
} from "../src/report.js";

/** One look that found the artwork with this many points agreeing, in the right place. */
const seen = (inliers: number): View => ({ found: true, inliers, misplaced: false });

/**
 * A stand-in for the recogniser that finds the artwork at any width.
 *
 * These tests are about the width arithmetic, the corner gates and the rule that turns looks
 * into a verdict, built from synthetic corners with no pixels to show anybody. Readiness is the
 * recogniser's answer, so they have to say what they assumed it would answer, and this is it, by
 * name. One look per width, where the real one takes four turns. The real recogniser is driven
 * against real artwork in `artwork.test.ts` and `printed.test.ts`.
 */
const FOUND_EVERYWHERE = (): View[] => [seen(99)];

function corners(count: number, spread = 100): Corner[] {
  return Array.from({ length: count }, (_, i) => ({
    x: (i * 37) % spread,
    y: (i * 61) % spread,
    strength: 1000 - i,
  }));
}

describe("buildReport", () => {
  it("fails artwork with too few corners", async () => {
    const report = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(4) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.pass).toBe(false);
    expect(report.reasons).toContain("too few features to track reliably");
  });

  it("passes artwork with plenty of well spread corners", async () => {
    const report = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.pass).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("scores from 0 to 100", async () => {
    const report = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("requires a larger print for a longer scan distance", async () => {
    const near = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 300,
      recognises: FOUND_EVERYWHERE,
    });
    const far = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 900,
      recognises: FOUND_EVERYWHERE,
    });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan(near.minimumWidthMm ?? 0);
  });

  it("flags artwork whose features crowd one part of the image", async () => {
    const report = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 60) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.reasons).toContain("features are concentrated in part of the artwork");
  });
});

describe("buildReport input validation", () => {
  it("refuses a scan distance that is not a positive finite number", async () => {
    for (const bad of [0, -400, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        buildReport({
          image: { width: 400, height: 400 },
          levels: [{ scale: 1, corners: corners(10) }],
          scanDistanceMm: bad,
          recognises: FOUND_EVERYWHERE,
        }),
      ).rejects.toThrow(/scan distance/i);
    }
  });

  it("refuses an image with no area, rather than reporting on it", async () => {
    await expect(
      buildReport({
        image: { width: 0, height: 0 },
        levels: [{ scale: 1, corners: corners(10) }],
        scanDistanceMm: 400,
        recognises: FOUND_EVERYWHERE,
      }),
    ).rejects.toThrow(/image/i);
  });
});

describe("the numbers a printer acts on", () => {
  it("does not report a print width for artwork with nothing to track", async () => {
    const report = await buildReport({
      image: { width: 500, height: 500 },
      levels: [{ scale: 1, corners: [] }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.minimumWidthMm).toBeNull();
  });

  it("asks the recogniser from the smallest size the target covers, whatever the corners say", async () => {
    // Started where the corners said, bold artwork whose corners hold up only at full size was
    // asked about at full size alone, where the mark overflows the frame, and was refused for
    // repeating itself when it repeats nothing. The recogniser finds such artwork at half that
    // size, and the width is the recogniser's answer.
    const image = { width: 640, height: 640 };
    const good = await buildReport({
      image,
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    const cornersOnlyAtFullSize = await buildReport({
      image,
      levels: [
        { scale: 1, corners: lattice(40, 640) },
        { scale: 0.79, corners: lattice(400, 640) },
        { scale: 0.63, corners: lattice(400, 640) },
        { scale: 0.5, corners: lattice(400, 640) },
      ],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(cornersOnlyAtFullSize.pass).toBe(true);
    expect(cornersOnlyAtFullSize.smallestUsableScale).toBe(0.5);
    expect(cornersOnlyAtFullSize.minimumWidthMm).toBe(good.minimumWidthMm);
  });

  it("says what the width was derived from, so it cannot be read as a measurement of the design", async () => {
    const report = await buildReport({
      image: { width: 640, height: 640 },
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    const described = describeWidth(report);
    expect(described).toContain("400 mm away");
    // And which edge. The same postcard reads 147 mm on its side and 104 mm upright, so a width
    // that does not say it is left to right invites a manifest that declares the other edge.
    expect(described).toContain("px across the artwork from left to right");
    expect(report.analysisWidth).toBe(640);
  });

  it("prints the pixel figure the recogniser was shown", async () => {
    // It printed one number and checked another, 506 beside 508, because the check took the
    // width after the distance's rounding and the sentence took it before.
    const asked: number[] = [];
    const report = await buildReport({
      image: { width: 640, height: 640 },
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 190,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(60)];
      },
    });
    expect(asked).toContain(320);
    expect(report.recognition?.pixelsAcross).toBe(320);
    expect(describeWidth(report)).toContain("at least 320 px across");
  });

  /**
   * Artwork that holds up only near its own size asks for a big print, and a big print is
   * a legal answer.
   *
   * There was a ceiling here for a day: anything needing more pixels across itself than the
   * frame is wide was refused, on the reasoning that it would have to fill more than the
   * whole picture. The recogniser does not need the whole mark in view. Against this
   * repository's example, at the runtime's own frame width, a mark 506 px across was found
   * with 116 inliers with 95% of its width in frame, and one 640 px across was found with
   * 123 inliers with 75% of it in frame.
   */
  it("names a width larger than the frame rather than refusing it", async () => {
    const image = { width: 640, height: 640 };
    const onlyAtFullSize = await buildReport({
      image,
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 400,
      // Found well only once the mark is wider than the frame.
      recognises: (pixelsAcross) => [pixelsAcross >= 600 ? seen(60) : seen(8)],
    });
    expect(onlyAtFullSize.pass).toBe(true);
    expect(onlyAtFullSize.smallestUsableScale).toBe(1);
    // 640 px across the artwork in a frame 480 px wide: the width at which the whole mark spans
    // more than the picture, and printing larger is read from further back.
    expect(onlyAtFullSize.minimumWidthMm ?? 0).toBeGreaterThan(480 / (480 / (1154.7 * 0.4)));
    expect(onlyAtFullSize.reasons).toEqual([]);
  });

  it("does not tell someone whose artwork cannot track that the print is too small", async () => {
    // Only the reason someone can act on should be there, and for faint artwork that is the
    // features: printing it larger does not give it any.
    const tooFaint = await buildReport({
      image: { width: 640, height: 640 },
      levels: [{ scale: 1, corners: lattice(200, 640) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(tooFaint.pass).toBe(false);
    expect(tooFaint.reasons).toEqual(["too few features to track reliably"]);
  });

  it("scales the width with the scan distance, because a camera further away sees less", async () => {
    const image = { width: 640, height: 640 };
    const levels = [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) }));
    const near = await buildReport({ image, levels, scanDistanceMm: 300, recognises: FOUND_EVERYWHERE });
    const far = await buildReport({ image, levels, scanDistanceMm: 900, recognises: FOUND_EVERYWHERE });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan((near.minimumWidthMm ?? 0) * 2);
  });

  it("never prints a passing verdict under a failing score, or the reverse", async () => {
    const image = { width: 1000, height: 1000 };
    for (const spacing of [10, 18, 25, 40, 70, 120, 300]) {
      for (const recognises of [FOUND_EVERYWHERE, () => [seen(12)], () => [seen(0)]]) {
        const report = await buildReport({
          image,
          levels: [{ scale: 1, corners: lattice(spacing, 1000) }],
          scanDistanceMm: 400,
          recognises,
        });
        expect(report.pass).toBe(report.score >= 60);
      }
    }
  });

  it("does not tell someone with no features that they are concentrated", async () => {
    const report = await buildReport({
      image: { width: 500, height: 500 },
      levels: [{ scale: 1, corners: [] }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    // Both are true of artwork with nothing on it, and the point of this case is the one
    // that is not said: nothing about features being bunched together, since there are none.
    expect(report.reasons).toContain("too few features to track reliably");
    expect(report.reasons.join(" ")).not.toMatch(/concentrated|corner of the artwork/i);
  });

  it("keeps the area count inside the grid even for coordinates it did not produce", async () => {
    const report = await buildReport({
      image: { width: 400, height: 400 },
      levels: [
        {
          scale: 1,
          corners: [
            { x: -900, y: -900, strength: 1 },
            { x: 9000, y: 9000, strength: 1 },
            { x: 200, y: 200, strength: 1 },
          ],
        },
      ],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.areasWithFeatures).toBeLessThanOrEqual(report.areas);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

describe("readiness is the recogniser's answer", () => {
  const image = { width: 640, height: 640 };
  const levels = [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) }));

  it("does not pass a report nobody showed to the recogniser", async () => {
    // Every way of deciding readiness from corners alone has been measured wrong, the last a
    // repetition figure that passed a sheet of sixteen identical postcards. A report that was
    // never checked says so rather than saying ready.
    const report = await buildReport({ image, levels, scanDistanceMm: 300 });
    expect(report.pass).toBe(false);
    expect(report.minimumWidthMm).toBeNull();
    expect(report.recognition).toBeNull();
    expect(report.score).toBeLessThan(60);
    expect(report.reasons.join(" ")).toMatch(/never put in front of the recogniser/);
  });

  it("judges each size over widths the scan distance cannot move", async () => {
    // One width, chosen by rounding the distance's arithmetic to whole millimetres and back, put
    // the verdict on that arithmetic: a sheet was ready at 190 mm and not at 191. The widths
    // asked about now follow from the size alone.
    const askedAt = async (scanDistanceMm: number) => {
      const asked: number[] = [];
      const report = await buildReport({
        image,
        levels,
        scanDistanceMm,
        recognises: (pixelsAcross) => {
          asked.push(pixelsAcross);
          return [seen(pixelsAcross % 3 === 0 ? 25 : 15)];
        },
      });
      return { asked, report };
    };
    const at190 = await askedAt(190);
    const at191 = await askedAt(191);
    expect(at190.asked).toEqual(at191.asked);
    expect(at190.report.pass).toBe(at191.report.pass);
    expect(at190.report.smallestUsableScale).toBe(at191.report.smallestUsableScale);

    // A size that passes is shown at all five widths, two per cent apart around its own, and
    // nothing else is asked once it has.
    const asked: number[] = [];
    await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(60)];
      },
    });
    expect(asked).toEqual([314, 317, 320, 323, 326]);
  });

  it("moves the width up to the first size the recogniser confirms, and says which", async () => {
    const asked: number[] = [];
    // Found with plenty only once the mark is at least 400 pixels across.
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(pixelsAcross >= 400 ? 60 : 12)];
      },
    });
    const unconfirmed = await buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: FOUND_EVERYWHERE,
    });

    expect(report.pass).toBe(true);
    expect(asked[0]).toBe(Math.round(0.5 * 640 * 0.98));
    expect(report.recognition?.pixelsAcross).toBe(403);
    expect(report.recognition?.inliers).toBe(60);
    expect(report.minimumWidthMm ?? 0).toBeGreaterThan(unconfirmed.minimumWidthMm ?? 0);
    // The scale it carries is the one its width came from.
    expect(Math.round(report.smallestUsableScale * report.analysisWidth)).toBe(403);
    expect(describeWidth(report)).toContain(`${report.minimumWidthMm} mm`);
  });

  it("confirms a size when most of its widths agree in every turn, and not when fewer do", async () => {
    // Three of five widths agreeing is enough; two is not. Counted over every look instead, as
    // half of twenty, the line was easier than the rule it replaced, and a sheet of four
    // postcards was ready for press.
    const agreeingAt = (count: number) => (pixelsAcross: number) => {
      const widths = [314, 317, 320, 323, 326];
      const index = widths.indexOf(pixelsAcross);
      return [seen(index >= 0 && index < count ? 40 : index >= 0 ? 12 : 99)];
    };
    const three = await buildReport({ image, levels, scanDistanceMm: 190, recognises: agreeingAt(3) });
    const two = await buildReport({ image, levels, scanDistanceMm: 190, recognises: agreeingAt(2) });
    expect(three.smallestUsableScale).toBe(0.5);
    expect(three.recognition).toMatchObject({
      widths: 5,
      widthsAgreed: 3,
      views: 5,
      misplaced: 0,
      found: true,
    });
    expect(two.smallestUsableScale).toBe(0.63);
  });

  it("holds every turn at a width to the line, not the turns on average", async () => {
    // A person holds a label at whatever angle it comes to hand, so a width where one turn falls
    // short is a width that falls short, however well the other turns do.
    const turns = (inliers: number[]) => (): View[] => inliers.map((count) => seen(count));
    const oneTurnShort = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: turns([90, 90, 90, 15]),
    });
    const everyTurn = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: turns([21, 22, 20, 25]),
    });
    expect(oneTurnShort.pass).toBe(false);
    expect(oneTurnShort.recognition?.inliers).toBe(15);
    expect(everyTurn.pass).toBe(true);
    expect(everyTurn.recognition?.inliers).toBe(20);
  });

  it("refuses a size where a look puts the artwork in the wrong place, and says so", async () => {
    // Plenty of points and on the wrong copy is the worst outcome there is: the content is drawn
    // on the wrong label. A size where it happens is not confirmed however well the rest agree.
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: (pixelsAcross) => [{ found: true, inliers: 80, misplaced: pixelsAcross % 2 === 0 }],
    });
    expect(report.pass).toBe(false);
    expect(report.reasons.join(" ")).toMatch(/wrong place in \d+ of \d+ looks/);
    expect(report.reasons.join(" ")).toMatch(/A design that repeats itself does this/);
  });

  it("refuses a size whose next size down puts the artwork in the wrong place", async () => {
    // A reader a little further off than planned sees the print one size smaller. Found there
    // with too few points, they step closer; found on the wrong copy, they are shown the wrong
    // thing. Here the wrong copy is at the smallest size only, so the size above it is refused
    // and the one above that, whose next size down places it correctly, is confirmed.
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: (pixelsAcross) =>
        pixelsAcross < 330 ? [{ found: true, inliers: 12, misplaced: pixelsAcross === 320 }] : [seen(60)],
    });
    expect(report.pass).toBe(true);
    expect(report.smallestUsableScale).toBe(0.79);
  });

  it("refuses artwork the recogniser confirms at no size, and says how close it came", async () => {
    const report = await buildReport({ image, levels, scanDistanceMm: 300, recognises: () => [seen(13)] });
    expect(report.pass).toBe(false);
    expect(report.minimumWidthMm).toBeNull();
    expect(report.score).toBeLessThan(60);
    expect(report.recognition?.inliers).toBe(13);
    expect(report.reasons.join(" ")).toMatch(
      /did not find it in every turn with 20 points agreeing at most of its widths/,
    );
    expect(report.reasons.join(" ")).not.toMatch(/repeats itself does this:/);
  });

  it("scores a refusal by how far short of agreeing it fell", async () => {
    // A sheet found nowhere scored 59, one point under passing, because the score looked at the
    // corners alone.
    const nowhere = await buildReport({ image, levels, scanDistanceMm: 190, recognises: () => [seen(0)] });
    const nearly = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: (pixelsAcross) => [seen([314, 317, 403, 407].includes(pixelsAcross) ? 40 : 12)],
    });
    expect(nowhere.score).toBe(0);
    expect(nearly.score).toBeGreaterThan(nowhere.score);
    expect(nearly.score).toBeLessThan(60);
  });

  it("counts a look that found nothing as nothing agreeing, whatever count came with it", async () => {
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: () => [{ found: false, inliers: 500, misplaced: false }],
    });
    expect(report.pass).toBe(false);
    expect(report.recognition?.inliers).toBe(0);
  });

  it("stops looking at a size as soon as that size cannot pass", async () => {
    // Twenty looks are what a passing size costs; a failing one is given up on once more than
    // half of its looks are short.
    const asked: number[] = [];
    await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(5)];
      },
    });
    const atFirstSize = asked.filter((pixels) => pixels < 330);
    expect(atFirstSize).toEqual([314, 317, 320]);
  });

  it("stops searching at the first width no manifest can declare", async () => {
    // At 5.2 metres the first size needs 4003 mm, which a manifest can carry, and the next
    // needs more than 5000, which it cannot. Refused at the first, the search stops there rather
    // than go on asking about widths nobody can print.
    const asked: number[] = [];
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 5200,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(5)];
      },
    });
    expect(report.pass).toBe(false);
    expect(asked.every((pixels) => pixels <= Math.round(0.5 * 640 * 1.02))).toBe(true);
  });

  it("is not asked about widths no manifest can declare, and says to read it from closer", async () => {
    const asked: number[] = [];
    // Ten metres needs more than five thousand millimetres at every size, so there is nothing
    // to confirm and the recogniser must not be run for a width nobody can print.
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 10_000,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(99)];
      },
    });
    expect(report.pass).toBe(false);
    expect(asked).toEqual([]);
    expect(report.reasons.join(" ")).toMatch(/Read it from closer/);
  });
});

describe("what a caller may hand the report", () => {
  it("refuses a level whose scale is not a fraction of the artwork", async () => {
    // A scale of zero printed "0 mm", minus one printed a negative width, and NaN was written
    // to the target file as null, which the bundler read as nothing to compare.
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(
        buildReport({
          image: { width: 640, height: 640 },
          levels: [
            { scale: 1, corners: lattice(40, 640) },
            { scale, corners: lattice(40, 640) },
          ],
          scanDistanceMm: 190,
          recognises: FOUND_EVERYWHERE,
        }),
        `a scale of ${scale} was accepted`,
      ).rejects.toThrow(RangeError);
    }
  });

  it("calls repetition unmeasured when there was nothing to measure", async () => {
    // An empty list read as 0, so a checkerboard with no usable features printed "0% of
    // features have a look-alike, which is normal".
    const report = await buildReport({
      image: { width: 640, height: 640 },
      levels: [{ scale: 1, corners: [] }],
      described: [],
      scanDistanceMm: 190,
      recognises: FOUND_EVERYWHERE,
    });
    expect(report.repetition).toBeNull();

    // And a list with nothing far enough apart to compare: one feature, or five within 24
    // pixels of each other, read 0, which says no look-alikes about artwork nothing was learned
    // about.
    const described = (points: Array<[number, number]>) =>
      points.map(([x, y], i) => ({ x, y, strength: 1, angle: 0, descriptor: new Uint32Array(8).fill(i) }));
    for (const points of [
      [[100, 100]],
      [
        [100, 100],
        [104, 100],
        [100, 104],
        [108, 108],
        [110, 102],
      ],
    ] as Array<Array<[number, number]>>) {
      const sparse = await buildReport({
        image: { width: 640, height: 640 },
        levels: [{ scale: 1, corners: [] }],
        described: described(points),
        scanDistanceMm: 190,
        recognises: FOUND_EVERYWHERE,
      });
      expect(sparse.repetition, `${points.length} features`).toBeNull();
    }
  });
});

describe("what a stored report has to hold before it is trusted", () => {
  const current = async () =>
    JSON.parse(
      JSON.stringify(
        await buildReport({
          image: { width: 640, height: 640 },
          levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
          scanDistanceMm: 190,
          recognises: FOUND_EVERYWHERE,
        }),
      ),
    );

  it("trusts a report this build writes, through JSON as it is stored", async () => {
    expect(isCurrentReport(await current())).toBe(true);
  });

  it("does not trust the fields one at a time", async () => {
    const report = await current();
    // A distance and nothing else was enough for the old guard, and its type said Report.
    expect(carriesItsDistance({ scanDistanceMm: 190 })).toBe(true);
    expect(isCurrentReport({ scanDistanceMm: 190 })).toBe(false);
    const { widths, widthsAgreed, views, misplaced, ...oneWidth } = report.recognition;
    for (const [label, broken] of [
      ["no recognition at all", { ...report, recognition: undefined }],
      ["a recognition that is a list", { ...report, recognition: [] }],
      [
        "a pass the recogniser did not agree with",
        { ...report, recognition: { ...report.recognition, inliers: 3 } },
      ],
      [
        "a pass with fewer than most widths agreeing",
        { ...report, recognition: { ...report.recognition, widthsAgreed: 2 } },
      ],
      [
        "a pass with a look in the wrong place",
        { ...report, recognition: { ...report.recognition, misplaced: 1 } },
      ],
      [
        "a pass on no widths at all",
        { ...report, recognition: { ...report.recognition, widths: 0, widthsAgreed: 0 } },
      ],
      [
        "a count that is not a count",
        { ...report, recognition: { ...report.recognition, widthsAgreed: "5" } },
      ],
      ["a negative count", { ...report, recognition: { ...report.recognition, misplaced: -1 } }],
      // What the build before wrote: one width, the worst of four turns, no looks counted.
      ["a recognition decided on one width", { ...report, recognition: oneWidth }],
      ["a pass with no width", { ...report, minimumWidthMm: null }],
      ["a width that is not a number", { ...report, minimumWidthMm: "147" }],
      ["a negative width", { ...report, minimumWidthMm: -615 }],
      ["a failure that names a width", { ...report, pass: false }],
      ["a verdict that is not a boolean", { ...report, pass: "yes" }],
      ["a distance nobody could hold", { ...report, scanDistanceMm: -5 }],
    ] as const) {
      expect(isCurrentReport(broken), label).toBe(false);
    }
    expect([widths, widthsAgreed, views, misplaced]).toEqual([5, 5, 5, 0]);
  });

  it("works an old report's distance back out, and answers a current one with its own", async () => {
    // The documented case: the old build's 70 mm over 320 px was computed at 350 mm.
    expect(distanceBehind({ minimumWidthMm: 70, smallestUsableScale: 0.5, analysisWidth: 640 })).toBe(350);
    // A current report computed at 190 mm. The old arithmetic over its width gives 735.
    expect(distanceBehind(await current())).toBe(190);
    expect(distanceBehind({ minimumWidthMm: "70", smallestUsableScale: 0.5, analysisWidth: 640 })).toBeNull();
  });
});

/** An evenly spaced grid of features, so the spacing under test is the only variable. */
function lattice(spacing: number, size: number): Corner[] {
  const corners: Corner[] = [];
  for (let y = spacing; y < size; y += spacing) {
    for (let x = spacing; x < size; x += spacing) corners.push({ x, y, strength: 1000 });
  }
  return corners;
}

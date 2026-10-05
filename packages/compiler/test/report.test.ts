import type { Corner, TargetFeature } from "@taggant/vision";
import { describe, expect, it } from "vitest";
import {
  AIMED_FROM,
  FRAME_WIDTH_MM_AT_1M,
  RECOGNISED_PIXELS_ACROSS_FRAME,
  type View,
  buildReport,
  carriesItsDistance,
  describeRepetition,
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

/**
 * No features, measured: nothing repeats in a list with nothing in it. These tests are about the
 * width, the corner gates and the rule that turns looks into a verdict; whether a design maps
 * onto itself is measured on real features in `artwork.test.ts` and in the vision package.
 */
const NO_FEATURES: TargetFeature[] = [];

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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
    });
    const far = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 400) }],
      scanDistanceMm: 900,
      recognises: FOUND_EVERYWHERE,
      features: NO_FEATURES,
    });
    expect(far.minimumWidthMm ?? 0).toBeGreaterThan(near.minimumWidthMm ?? 0);
  });

  it("flags artwork whose features crowd one part of the image", async () => {
    const report = await buildReport({
      image: { width: 400, height: 400 },
      levels: [{ scale: 1, corners: corners(300, 60) }],
      scanDistanceMm: 400,
      recognises: FOUND_EVERYWHERE,
      features: NO_FEATURES,
    });
    expect(report.reasons).toContain("features are concentrated in part of the artwork");
  });
});

describe("buildReport input validation", () => {
  it("refuses a scan distance outside the range a stored report is held to", async () => {
    // A positive distance short of the range wrote a passing report the bundler then refused.
    for (const bad of [0, -400, Number.NaN, Number.POSITIVE_INFINITY, 20, 49.5, 10_001]) {
      await expect(
        buildReport({
          image: { width: 400, height: 400 },
          levels: [{ scale: 1, corners: corners(10) }],
          scanDistanceMm: bad,
          recognises: FOUND_EVERYWHERE,
          features: NO_FEATURES,
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
        features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
    });
    expect(tooFaint.pass).toBe(false);
    expect(tooFaint.reasons).toEqual(["too few features to track reliably"]);
  });

  it("scales the width with the scan distance, because a camera further away sees less", async () => {
    const image = { width: 640, height: 640 };
    const levels = [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) }));
    const near = await buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: FOUND_EVERYWHERE,
      features: NO_FEATURES,
    });
    const far = await buildReport({
      image,
      levels,
      scanDistanceMm: 900,
      recognises: FOUND_EVERYWHERE,
      features: NO_FEATURES,
    });
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
          features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
    const report = await buildReport({ image, levels, scanDistanceMm: 300, features: NO_FEATURES });
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
        features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
    const three = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: agreeingAt(3),
      features: NO_FEATURES,
    });
    const two = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: agreeingAt(2),
      features: NO_FEATURES,
    });
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
      features: NO_FEATURES,
    });
    const everyTurn = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: turns([21, 22, 20, 25]),
      features: NO_FEATURES,
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
      features: NO_FEATURES,
    });
    expect(report.pass).toBe(false);
    // The count is of the looks taken before looking stopped, which is at the first in the wrong
    // place, and is said as that rather than as a rate: "1 of 4 looks" read as a quarter of them.
    expect(report.reasons.join(" ")).toMatch(
      /wrong place at \d+ mm wide, read from \d+ mm, in \d+ of the \d+ looks taken at that size before it stopped looking/,
    );
    expect(report.reasons.join(" ")).toMatch(/A design that repeats part of itself does this/);
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
      features: NO_FEATURES,
      recognises: (pixelsAcross) =>
        pixelsAcross < 330 ? [{ found: true, inliers: 12, misplaced: pixelsAcross === 320 }] : [seen(60)],
    });
    expect(report.pass).toBe(true);
    expect(report.smallestUsableScale).toBe(0.79);
  });

  it("refuses artwork the recogniser confirms at no size, and says how close it came", async () => {
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 300,
      recognises: () => [seen(13)],
      features: NO_FEATURES,
    });
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
    const nowhere = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: () => [seen(0)],
      features: NO_FEATURES,
    });
    const nearly = await buildReport({
      image,
      levels,
      scanDistanceMm: 190,
      recognises: (pixelsAcross) => [seen([314, 317, 403, 407].includes(pixelsAcross) ? 40 : 12)],
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
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
      features: NO_FEATURES,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(99)];
      },
    });
    expect(report.pass).toBe(false);
    expect(asked).toEqual([]);
    expect(report.reasons.join(" ")).toMatch(/Read it from closer/);
  });

  it("blames the distance when the sizes that fit were refused and the next one does not fit", async () => {
    // From six metres the smallest size fits under five metres of print and the next does not.
    // The smallest refused, the search stopped, and the reason read "too little distinct detail"
    // for artwork the recogniser was never shown at the size it needed; a little closer, that
    // size is asked about and confirmed.
    const report = await buildReport({
      image,
      levels,
      scanDistanceMm: 6000,
      features: NO_FEATURES,
      recognises: (pixelsAcross) => [seen(pixelsAcross < 400 ? 0 : 99)],
    });
    expect(report.pass).toBe(false);
    expect(report.reasons.join(" ")).toContain("the next size up would have to be printed");
    expect(report.reasons.join(" ")).toContain("Read it from closer, and that size can be asked about");
    expect(report.reasons.join(" ")).not.toContain("too little distinct detail");
  });

  it("counts each width once on artwork too narrow to show five different ones", async () => {
    // Through the exported function a narrow image rounds two of the five widths to one pixel
    // count, and the same looks were counted twice: "4 of 5 widths agreed" was three widths.
    const asked: number[] = [];
    const report = await buildReport({
      image: { width: 100, height: 100 },
      levels: [1, 0.5].map((scale) => ({ scale, corners: lattice(8, 100) })),
      scanDistanceMm: 190,
      features: NO_FEATURES,
      recognises: (pixelsAcross) => {
        asked.push(pixelsAcross);
        return [seen(99)];
      },
    });
    expect(new Set(asked).size).toBe(asked.length);
    expect(report.recognition?.widths).toBe(new Set(asked.filter((pixels) => pixels < 60)).size);
    expect(report.recognition?.widths).toBeLessThan(5);
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
          features: NO_FEATURES,
        }),
        `a scale of ${scale} was accepted`,
      ).rejects.toThrow(RangeError);
    }
  });

  it("says nothing was measured when it was given nothing to measure, and does not pass", async () => {
    // Without the features, nothing says the design is not printed twice, and a report like that
    // is not one to stand behind.
    const unmeasured = await buildReport({
      image: { width: 640, height: 640 },
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 190,
      recognises: FOUND_EVERYWHERE,
    });
    expect(unmeasured.repetition).toBeNull();
    expect(unmeasured.pass).toBe(false);
    expect(unmeasured.reasons.join(" ")).toContain("never checked for repeating itself");

    const empty = await buildReport({
      image: { width: 640, height: 640 },
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 190,
      recognises: FOUND_EVERYWHERE,
      features: NO_FEATURES,
    });
    expect(empty.repetition).toEqual({ places: 0, of: 0, move: null, ends: null, aimed: null });
    expect(empty.pass).toBe(true);
  });

  it("refuses features none of which could be read, rather than reading them as nothing repeating", async () => {
    // Measured, a list of nothing usable says nothing repeats, which is the wrong answer to give
    // about artwork nothing was learned about.
    const unreadable = [
      { x: Number.NaN, y: 10, strength: 1, angle: 0, scale: 1, descriptor: new Uint32Array(8) },
      { x: 10, y: 10, strength: 1, angle: 0, scale: 1, descriptor: new Uint32Array(4) },
    ] as TargetFeature[];
    const report = await buildReport({
      image: { width: 640, height: 640 },
      levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
      scanDistanceMm: 190,
      recognises: FOUND_EVERYWHERE,
      features: unreadable,
    });
    expect(report.repetition?.of).toBe(0);
    expect(report.pass).toBe(false);
    expect(report.reasons.join(" ")).toContain("none of its features could be read");
  });
});

/**
 * Features at their own places with descriptors unlike each other's, plus copies of the first
 * `copied` of them a fixed shift away, facing the same way and found at the same size: a design
 * part of which is printed twice, in the terms the repetition measure reads.
 */
function featuresWith(count: number, copied: number, seed = 20261002): TargetFeature[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fff_ffff;
    return state;
  };
  const originals: TargetFeature[] = [];
  for (let i = 0; i < count; i++) {
    const descriptor = new Uint32Array(8);
    for (let w = 0; w < 8; w++) descriptor[w] = (next() ^ (next() << 16)) >>> 0;
    // Apart from each other by more than a place, in the left half, so a copy lands in the right.
    originals.push({
      x: 20 + (i % 28) * 10,
      y: 20 + Math.floor(i / 28) * 10,
      strength: 1,
      angle: (next() % 628) / 100,
      scale: 1,
      descriptor,
    });
  }
  const copies = originals.slice(0, copied).map((feature) => ({ ...feature, x: feature.x + 320 }));
  return [...originals, ...copies];
}

describe("a design that maps onto itself", () => {
  const image = { width: 640, height: 640 };
  const levels = [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) }));
  const report = (
    features: TargetFeature[],
    recognises: (pixelsAcross: number) => View[] = FOUND_EVERYWHERE,
  ) => buildReport({ image, levels, scanDistanceMm: 190, recognises, features });

  it("is refused before the recogniser is asked, naming the move that does it", async () => {
    const asked: number[] = [];
    const twice = await report(featuresWith(200, 100), (pixels) => {
      asked.push(pixels);
      return [seen(99)];
    });
    expect(twice.pass).toBe(false);
    expect(twice.repetition?.places).toBe(100);
    expect(twice.reasons.join(" ")).toContain("it maps onto itself");
    expect(twice.reasons.join(" ")).toContain("shifting it 50 per cent of its width right");
    expect(twice.recognition).toBeNull();
    expect(asked).toEqual([]);
  });

  it("is not refused for a part repeated that is many places and a small share of the design", async () => {
    // Twenty-five places is past the line of twenty, and a fourteenth of the design's places is
    // well short of a fifth: a logo printed twice on a label, which the recogniser's own looks
    // are left to judge.
    const logo = await report(featuresWith(320, 25));
    expect(logo.repetition?.places).toBe(25);
    expect(logo.pass).toBe(true);
  });

  it("is not refused for a part repeated that is a large share of a design with few places", async () => {
    // Fifteen places is under the line of twenty, though it is more than a fifth of fifty-five.
    const sparse = await report(featuresWith(40, 15));
    expect(sparse.repetition?.places).toBe(15);
    expect(sparse.pass).toBe(true);
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
          features: NO_FEATURES,
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

  it("checks every field against what this build writes, one shape for each check", async () => {
    // Shapes this build never writes, each accepted before these checks, among them a pass
    // decided on one width, a pass scoring 10, and a width edited to 1 mm, which turned the
    // bundler's comparison off for a piece that needs 147. Each shape here breaks one check.
    const report = await current();
    const recognition = report.recognition;
    const failing = JSON.parse(
      JSON.stringify(
        await buildReport({
          image: { width: 640, height: 640 },
          levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
          scanDistanceMm: 190,
          recognises: () => [seen(0)],
          features: NO_FEATURES,
        }),
      ),
    );
    expect(isCurrentReport(failing)).toBe(true);
    const far = (distance: number) => ({
      ...report,
      scanDistanceMm: distance,
      minimumWidthMm: Math.ceil(
        (report.smallestUsableScale * report.analysisWidth) /
          (RECOGNISED_PIXELS_ACROSS_FRAME / (FRAME_WIDTH_MM_AT_1M * (distance / 1000))),
      ),
    });
    expect(isCurrentReport(far(190)), "the width worked out here is not the report's own").toBe(true);
    for (const [label, broken] of [
      ["a score over 100", { ...report, score: 1000 }],
      ["a pass scoring under 60", { ...report, score: 10 }],
      ["a score that is not a whole number", { ...report, score: 82.5 }],
      ["no reasons", { ...report, reasons: undefined }],
      ["reasons that are a word", { ...report, reasons: "abc" }],
      ["reasons that are not words", { ...failing, reasons: [7] }],
      ["a pass with a reason against it", { ...report, reasons: ["too few features to track reliably"] }],
      ["a failure with no reason", { ...failing, reasons: [] }],
      ["a feature count that is not a count", { ...report, featureCount: "300" }],
      ["a grid of twenty-five areas", { ...report, areas: 25 }],
      ["more areas reached than there are", { ...report, areasWithFeatures: 17 }],
      ["no analysed width", { ...failing, analysisWidth: 0 }],
      ["a smallest size of nothing", { ...failing, smallestUsableScale: 0 }],
      ["a smallest size larger than the artwork", { ...failing, smallestUsableScale: 1.5 }],
      ["no points needed", { ...report, recognition: { ...recognition, needed: 0 } }],
      ["more widths agreeing than shown", { ...report, recognition: { ...recognition, widthsAgreed: 6 } }],
      ["more widths than are ever shown", { ...failing, recognition: { ...failing.recognition, widths: 6 } }],
      [
        "more looks in the wrong place than looks",
        {
          ...failing,
          recognition: { ...failing.recognition, misplaced: (failing.recognition.views ?? 0) + 1 },
        },
      ],
      ["no repetition measured", { ...report, repetition: undefined }],
      ["a repetition figure from the build before", { ...report, repetition: 0.36 }],
      [
        "more places repeating than there are",
        { ...report, repetition: { places: 5, of: 3, move: null, ends: null, aimed: null } },
      ],
      [
        "a move that is not one",
        {
          ...report,
          repetition: {
            places: 1,
            of: 300,
            move: { across: Number.NaN, down: 0, turnDegrees: 0, scale: 1 },
            ends: { from: { x: 160, y: 226 }, to: { x: 480, y: 226 } },
            aimed: null,
          },
        },
      ],
      ["a pass with too few features", { ...report, featureCount: 59 }],
      ["a pass with its features in too few areas", { ...report, areasWithFeatures: 7 }],
      [
        "a pass for a design that repeats itself",
        {
          ...report,
          repetition: {
            places: 120,
            of: 400,
            move: { across: 0.5, down: 0, turnDegrees: 0, scale: 1 },
            ends: { from: { x: 160, y: 226 }, to: { x: 480, y: 226 } },
            aimed: { sizes: 4, views: 32, misplaced: 0 },
          },
        },
      ],
      ["a pass the recogniser did not find", { ...report, recognition: { ...recognition, found: false } }],
      [
        "a pass on four widths",
        { ...report, recognition: { ...recognition, widths: 4, widthsAgreed: 4, views: 4 } },
      ],
      ["a pass from no looks", { ...report, recognition: { ...recognition, views: 0 } }],
      [
        "a pass from looks that are not a turn for each width",
        { ...report, recognition: { ...recognition, views: 7 } },
      ],
      [
        "a pass at a size it was not shown at",
        { ...report, recognition: { ...recognition, pixelsAcross: 321 } },
      ],
      ["a width edited to 1 mm", { ...report, minimumWidthMm: 1 }],
      ["a width edited up by a millimetre", { ...report, minimumWidthMm: (report.minimumWidthMm ?? 0) + 1 }],
      ["a width no manifest can declare", far(10_000)],
    ] as const) {
      expect(isCurrentReport(broken), label).toBe(false);
    }
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

/**
 * A design where one move carries `copied` of its `unique + copied` places: a part of it repeated
 * elsewhere on it, under both of the lines that refuse a design outright.
 */
function partlyCopied(unique: number, copied: number): TargetFeature[] {
  let seed = 11;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    return seed;
  };
  const features: TargetFeature[] = [];
  for (let i = 0; i < unique; i++) {
    const descriptor = new Uint32Array(8);
    for (let w = 0; w < 8; w++) descriptor[w] = (next() ^ (next() << 16)) >>> 0;
    features.push({
      x: 20 + (i % 12) * 24,
      y: 20 + Math.floor(i / 12) * 24,
      strength: 1,
      angle: 0.3,
      scale: 1,
      descriptor,
    });
  }
  for (let i = 0; i < copied; i++) {
    const original = features[i] as TargetFeature;
    features.push({ ...original, x: original.x + 320 });
  }
  return features;
}

/** Four turns found with plenty agreeing; in the wrong place when pointed off the centre, if asked to be. */
const pointedLooks =
  (wrongWhenAimed: boolean, asked: Array<{ x: number; y: number } | undefined> = []) =>
  (_pixels: number, aim?: { x: number; y: number }): View[] => {
    asked.push(aim);
    return Array.from({ length: 4 }, () => ({
      found: true,
      inliers: 58,
      misplaced: aim !== undefined && wrongWhenAimed,
    }));
  };

const pointedReport = async (
  features: TargetFeature[],
  looks: (pixels: number, aim?: { x: number; y: number }) => View[],
  smaller?: TargetFeature[],
) =>
  buildReport({
    image: { width: 640, height: 640 },
    levels: [1, 0.79, 0.63, 0.5].map((scale) => ({ scale, corners: lattice(40, 640) })),
    scanDistanceMm: 190,
    recognises: looks,
    features,
    ...(smaller === undefined ? {} : { smaller }),
  });

/**
 * Thirty places of a design described at a third of its size, which the target does not hold,
 * and the same thirty on a copy at a third of the size, described at full size, which it does.
 * The two pair only through those two sizes.
 */
function copiedAtAThird(): { onTarget: TargetFeature[]; smaller: TargetFeature[] } {
  let seed = 23;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    return seed;
  };
  const onTarget: TargetFeature[] = [];
  const smaller: TargetFeature[] = [];
  for (let i = 0; i < 30; i++) {
    const descriptor = new Uint32Array(8);
    for (let w = 0; w < 8; w++) descriptor[w] = (next() ^ (next() << 16)) >>> 0;
    const x = 40 + (i % 6) * 48;
    const y = 40 + Math.floor(i / 6) * 48;
    smaller.push({ x, y, strength: 1, angle: 0.3, scale: 0.32, descriptor });
    onTarget.push({ x: 420 + x * 0.32, y: 420 + y * 0.32, strength: 1, angle: 0.3, scale: 1, descriptor });
  }
  return { onTarget, smaller };
}

describe("a design with a copy the lines do not refuse", () => {
  it("points the recogniser at both ends of a move carrying enough places, and refuses one it puts in the wrong place there", async () => {
    // A copy at another size carries a fraction of its places, under both lines, and a camera
    // pointed at it settled on the other copy while every centred look was right.
    const features = partlyCopied(120, 15);
    const asked: Array<{ x: number; y: number } | undefined> = [];
    const report = await pointedReport(features, pointedLooks(true, asked));
    expect(report.repetition?.places).toBeGreaterThanOrEqual(AIMED_FROM);
    expect(report.pass).toBe(false);
    expect(report.minimumWidthMm).toBeNull();
    expect(report.reasons.join(" ")).toContain("pointed at the part of the artwork");
    expect(report.repetition?.aimed?.misplaced).toBeGreaterThan(0);
    expect(describeRepetition(report)).toContain(
      `put it in the wrong place in ${report.repetition?.aimed?.misplaced} of ${report.repetition?.aimed?.views} looks`,
    );
    // Pointed where the move takes its places from or where it puts them: the middle of the
    // fifteen copied places, or of their copies 320 pixels across.
    const middle = (points: TargetFeature[]) => ({
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    });
    const ends = [middle(features.slice(0, 15)), middle(features.slice(120))];
    const aims = asked.filter((aim) => aim !== undefined) as Array<{ x: number; y: number }>;
    expect(aims.length).toBeGreaterThan(0);
    for (const aim of aims) {
      expect(ends.some((end) => Math.hypot(aim.x - end.x, aim.y - end.y) < 1)).toBe(true);
    }
    expect(isCurrentReport(JSON.parse(JSON.stringify(report)))).toBe(true);
  });

  it("measures the sizes below the target's with its own, so a copy at a third of the size is pointed at", async () => {
    // The target's sizes are within a factor of two of each other, so a copy at a third pairs with
    // nothing in them, and was called ready for press without a look at it.
    const unique = partlyCopied(120, 0);
    const { onTarget, smaller } = copiedAtAThird();
    const unmeasured = await pointedReport([...unique, ...onTarget], pointedLooks(true));
    expect(unmeasured.pass).toBe(true);
    expect(unmeasured.repetition?.places).toBeLessThan(AIMED_FROM);
    // Wrong only when pointed at the copy, which sits right of x = 400.
    const looked: Array<{ pixels: number; aim?: { x: number; y: number } }> = [];
    const onTheCopy = (pixels: number, aim?: { x: number; y: number }): View[] => {
      looked.push(aim === undefined ? { pixels } : { pixels, aim });
      const misplaced = aim !== undefined && aim.x > 400;
      return Array.from({ length: 4 }, () => ({ found: true, inliers: 58, misplaced }));
    };
    const report = await pointedReport([...unique, ...onTarget], onTheCopy, smaller);
    expect(report.repetition?.places).toBeGreaterThanOrEqual(25);
    const scale = report.repetition?.move?.scale ?? 1;
    expect(Math.min(scale, 1 / scale)).toBeCloseTo(0.32, 2);
    expect(report.pass).toBe(false);
    expect(report.reasons.join(" ")).toContain("pointed at the part of the artwork");
    // The copy is looked at grown by the move, as a camera brought close to it sees it: at the
    // smallest size the target covers, the original at 320 pixels across and the copy at 1000.
    const atOriginal = looked.find((look) => look.aim !== undefined && look.aim.x < 400);
    const atCopy = looked.find((look) => look.aim !== undefined && look.aim.x > 400);
    expect(atOriginal?.pixels).toBe(320);
    expect(atCopy?.pixels).toBe(1000);
  });

  it("writes a refusal its own check reads, wherever the wrong look came", async () => {
    // Wrong at the first end looked at, at the third size: twenty looks, which is not the same
    // number at each end at each size, and the check of a stored report held every report to
    // that, so a fresh refusal read as one from an older build.
    let pointedAt = 0;
    const looks = (_pixels: number, aim?: { x: number; y: number }): View[] => {
      const misplaced = aim !== undefined && ++pointedAt === 5;
      return Array.from({ length: 4 }, () => ({ found: true, inliers: 58, misplaced }));
    };
    const report = await pointedReport(partlyCopied(120, 15), looks);
    expect(report.pass).toBe(false);
    expect(report.repetition?.aimed).toEqual({ sizes: 3, views: 20, misplaced: 4 });
    expect(isCurrentReport(JSON.parse(JSON.stringify(report)))).toBe(true);
    // And a refusal still may not claim more looks in the wrong place than it took.
    const stored = JSON.parse(JSON.stringify(report));
    stored.repetition.aimed.misplaced = 21;
    expect(isCurrentReport(stored)).toBe(false);
  });

  it("passes one the recogniser puts in the right place at both ends and every size, and says so", async () => {
    const asked: Array<{ x: number; y: number } | undefined> = [];
    const report = await pointedReport(partlyCopied(120, 15), pointedLooks(false, asked));
    expect(report.pass).toBe(true);
    // Both ends at each of the four sizes the target covers, four turns each.
    expect(report.repetition?.aimed).toEqual({ sizes: 4, views: 32, misplaced: 0 });
    const aims = asked.filter((aim) => aim !== undefined) as Array<{ x: number; y: number }>;
    expect(aims.some((aim) => aim.x < 320) && aims.some((aim) => aim.x > 320)).toBe(true);
    expect(describeRepetition(report)).toContain("put it in the right place in all 32 looks");
    expect(isCurrentReport(JSON.parse(JSON.stringify(report)))).toBe(true);
  });

  it("points it nowhere for a design whose move carries fewer places than that", async () => {
    const asked: Array<{ x: number; y: number } | undefined> = [];
    const report = await pointedReport(partlyCopied(120, AIMED_FROM - 4), pointedLooks(true, asked));
    expect(report.repetition?.places).toBeLessThan(AIMED_FROM);
    expect(report.pass).toBe(true);
    expect(report.repetition?.aimed).toBeNull();
    expect(asked.every((aim) => aim === undefined)).toBe(true);
  });

  it("holds a stored report to its looks at both ends", async () => {
    const report = JSON.parse(
      JSON.stringify(await pointedReport(partlyCopied(120, 15), pointedLooks(false))),
    );
    expect(isCurrentReport(report)).toBe(true);
    const repetition = report.repetition;
    for (const [label, broken] of [
      ["a pass that was never pointed", { ...report, repetition: { ...repetition, aimed: null } }],
      [
        "a pass put in the wrong place",
        { ...report, repetition: { ...repetition, aimed: { ...repetition.aimed, misplaced: 1 } } },
      ],
      [
        "looks not the same at each end",
        { ...report, repetition: { ...repetition, aimed: { ...repetition.aimed, views: 33 } } },
      ],
      [
        "looks at no size",
        { ...report, repetition: { ...repetition, aimed: { sizes: 0, views: 0, misplaced: 0 } } },
      ],
      [
        "four sizes and no looks",
        { ...report, repetition: { ...repetition, aimed: { sizes: 4, views: 0, misplaced: 0 } } },
      ],
      ["no ends", { ...report, repetition: { ...repetition, ends: undefined } }],
      ["ends with no move", { ...report, repetition: { ...repetition, move: null } }],
      [
        "a point that is not one",
        {
          ...report,
          repetition: { ...repetition, ends: { ...repetition.ends, to: { x: Number.NaN, y: 1 } } },
        },
      ],
    ] as const) {
      expect(isCurrentReport(broken), label).toBe(false);
    }
    // And looks recorded for a design that did not need them are a report this build never writes.
    const plain = JSON.parse(JSON.stringify(await pointedReport(partlyCopied(120, 4), pointedLooks(false))));
    expect(isCurrentReport(plain)).toBe(true);
    expect(
      isCurrentReport({
        ...plain,
        repetition: { ...plain.repetition, aimed: { sizes: 1, views: 8, misplaced: 0 } },
      }),
    ).toBe(false);
  });
});

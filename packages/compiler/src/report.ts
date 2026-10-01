import { type Corner, type DescribedCorner, measureDistinctiveness } from "@taggant/vision";

/** One size the artwork was described at, with the features found there. */
export interface Level {
  scale: number;
  corners: Corner[];
}

export interface ReportInput {
  image: { width: number; height: number };
  /** Every size the artwork was described at. */
  levels: Level[];
  /**
   * The described features at the artwork's own size, for judging whether they can be told
   * apart. Omitted only by callers that have corners without descriptions.
   */
  described?: DescribedCorner[];
  /** Distance in millimetres at which a person is expected to hold the camera. */
  scanDistanceMm: number;
  /**
   * Show the recogniser the artwork with this many pixels across it, and say what it found.
   *
   * Supplied by whoever has the pixels, which is the compiler; this module has corners and
   * nothing else. Without it a report cannot pass, because every way of deciding readiness
   * from the corners alone has been measured wrong.
   */
  recognises?: (pixelsAcross: number) => { found: boolean; inliers: number };
}

/** What the recogniser made of the artwork at the width a report gives. */
export interface Recognition {
  /** Pixels across the artwork that the stated width puts in front of the recogniser. */
  pixelsAcross: number;
  found: boolean;
  /** Matches that agreed with the pose it fitted. */
  inliers: number;
  /** How many have to agree before the width is called enough. */
  needed: number;
}

export interface Report {
  /** 0 to 100. Below 60 exactly when the artwork fails, so the two never disagree. */
  score: number;
  pass: boolean;
  featureCount: number;
  /** Areas of a 4 by 4 grid over the artwork that hold at least one feature. */
  areasWithFeatures: number;
  /**
   * Share of features with one look-alike elsewhere on the artwork that stands out from the
   * rest, from 0 to 1. Null when there was nothing to judge.
   *
   * A diagnostic, not a gate, and its name promises more than it measures. It counts the case
   * a matcher accepts wrongly, one rival clearly closer than the others, and by construction
   * it leaves out a feature with several identical rivals, because there none stands out. So
   * it reads lower the more times a design repeats: two copies of a label read 1.0 and three
   * read 0. It decided "ready for press" until a sheet of sixteen identical postcards passed
   * at 0.31 and was not found at the width it was given. Readiness is decided by `recognition`
   * now, which is what this was standing in for.
   */
  repetition: number | null;
  /**
   * The artwork put in front of the recogniser at exactly the width this report gives, and
   * what came back. This is what decides readiness: the width is a claim about what a camera
   * at the scan distance will see, and the only check of that claim is to show it to the
   * thing that has to see it.
   *
   * Null when nothing drove it, and a report like that does not pass.
   */
  recognition: Recognition | null;
  /** How many areas there are, so the count above reads without knowing the grid. */
  areas: number;
  /** Pixels across the artwork as it was analysed. The width below is derived from it. */
  analysisWidth: number;
  /**
   * Smallest size, as a fraction of the analysed artwork, at which it still holds up.
   * Most artwork reaches the bottom of the range the compiled target covers.
   */
  smallestUsableScale: number;
  /**
   * Smallest width, in millimetres, at which this artwork can be printed and still be
   * recognised at the given scan distance. Null when it does not pass at all.
   *
   * This is a resolution requirement, not a judgement of the design. It follows from the
   * camera's assumed resolving power, the scan distance, and the pixel width of the
   * smallest size the compiled target covers.
   */
  minimumWidthMm: number | null;
  /**
   * The distance the width above was worked out for.
   *
   * Carried with it, because the two are meaningless apart and were being paired by whoever
   * displayed them: the console showed a width computed for one distance beside a default
   * of 350 mm it had invented, so the sentence a printer reads named a distance the number
   * had nothing to do with.
   */
  scanDistanceMm: number;
  reasons: string[];
}

/**
 * How wide the picture is, in millimetres, one metre from the camera.
 *
 * ASSUMPTION, and the only one here. A 60 degree field across the picture spans
 * 2 * 1000 * tan(30) millimetres at a metre. Narrower optics span less and make every
 * minimum below smaller; a wider one makes them larger.
 *
 * It said "ordinary for a phone's rear camera", which is not a safe way to put it, because
 * a phone's rear camera does not have one field. It has a long axis and a short one, and
 * which of them lies across the picture depends on how the phone is held. Published lens
 * equivalents for main cameras are 24 to 26 mm, which is 74 to 69 degrees along the long
 * axis; the short axis is narrower by the sensor's aspect, which the browser does not tell
 * a page either. So the honest statement is that this number is one field where a device
 * has two, and which one it should be is not settled.
 *
 * **No device measurement stands behind it yet.** One reading was taken through
 * `site/measure/`, and it is not evidence: both of its inputs were left at their defaults,
 * so the field it reported was arithmetic over two numbers that measured nothing, and the
 * page it was taken on read the artwork's width from its top edge alone, which tilt
 * foreshortens by 12 per cent at 15 degrees. A figure derived from it briefly appeared here
 * and in the README as measured fact. It was not, and it is out.
 *
 * What is known without a device: the direction of the exposure is one way. A field wider
 * than this makes the true minimum larger than what is printed below, so a print made to
 * these widths is the one that fails, never the one that is needlessly big. `site/measure/`
 * exists to settle it, and until it does this constant stays where it is rather than moving
 * on desk evidence, because every published figure scales with it.
 */
export const FRAME_WIDTH_MM_AT_1M = 2 * 1000 * Math.tan((30 * Math.PI) / 180);

/**
 * How many pixels recognition gets across that picture.
 *
 * **Not the sensor's.** The runtime reduces every frame to this width before it recognises
 * anything, so the sensor's own resolution cancels out: a mark occupies the same fraction
 * of the frame whatever the sensor, and that fraction times this number is how many pixels
 * the matcher actually has to work with. Keep it in step with `processWidth` in the
 * runtime's camera.
 *
 * This was a sensor figure, 1.6 pixels per millimetre at a metre from a 1080p sensor, and
 * the minimum widths below were computed by dividing pixels the recogniser needs by pixels
 * the sensor has. Those are different currencies and the reduction between them was in
 * neither the arithmetic nor the comment, so every minimum was optimistic by the ratio of
 * the two, which for 1080p reduced to 480 is a factor of four. Measured against the example
 * artwork: the width the report called sufficient put 176 pixels across the mark where the
 * matcher needs about 300, so a print made to it would not have been found at all.
 */
export const RECOGNISED_PIXELS_ACROSS_FRAME = 480;

/**
 * Is a report read back off disk one this build produced?
 *
 * A stored report is not merely old data, it is data from the model that was wrong. Every
 * width written before this field existed was computed by dividing by the sensor's pixels
 * rather than the recogniser's, so it is about four times too small, and both things that
 * read a stored report acted on that: the console printed the width as advice, and the
 * bundler used it as the gate that refuses to publish a piece printed too small. A
 * four-times-lenient gate is worse than no gate, because it reads as one.
 *
 * The distance is the marker because it is the field the corrected model added, and
 * because a width without the distance it was computed for is not a number anyone can act
 * on anyway.
 */
export function carriesItsDistance(report: unknown): report is Report {
  if (typeof report !== "object" || report === null) return false;
  const distance = (report as { scanDistanceMm?: unknown }).scanDistanceMm;
  // A number a person could hold a camera at, not merely a number. Hand-edited target files
  // are the whole population this guard exists for, and `typeof x === "number"` believed
  // zero and negatives from one: the console rendered "to be read from -5 mm away".
  return typeof distance === "number" && Number.isFinite(distance) && distance >= 50 && distance <= 10_000;
}

/**
 * Is a report read back off disk one this build would stand behind?
 *
 * The fields a reader acts on, each checked rather than assumed. `carriesItsDistance` looked at
 * one of them and was typed as though it checked them all, so a hand-edited file holding a
 * plausible distance and no usable width was trusted as a whole report. And a report with no
 * `recognition` is from the build that inferred readiness from a repetition figure that fell as
 * a design repeated: it called a sheet of sixteen identical postcards ready for press. Its
 * verdict is not one to show a printer or to publish behind.
 */
export function isCurrentReport(report: unknown): report is Report {
  if (!carriesItsDistance(report)) return false;
  const fields = report as unknown as Record<string, unknown>;
  if (typeof fields.pass !== "boolean" || typeof fields.score !== "number") return false;
  const width = fields.minimumWidthMm;
  if (width !== null && !(typeof width === "number" && Number.isFinite(width) && width > 0)) return false;
  // A passing report names a width; a failing one names none. Anything else is not a report
  // this build writes.
  if ((fields.pass === true) !== (width !== null)) return false;
  const seen = fields.recognition as Record<string, unknown> | null | undefined;
  if (seen === undefined) return false;
  if (seen !== null) {
    if (
      typeof seen.inliers !== "number" ||
      typeof seen.needed !== "number" ||
      typeof seen.found !== "boolean"
    ) {
      return false;
    }
  }
  // Passing means the recogniser was asked and agreed.
  if (
    fields.pass === true &&
    (seen === null || seen.found !== true || (seen.inliers as number) < (seen.needed as number))
  ) {
    return false;
  }
  return true;
}

/**
 * The distance an older report was computed for, worked back out of it.
 *
 * The build that wrote these files divided by a sensor figure of 1.6 pixels per millimetre
 * at a metre, so its width was `ceil(pixelsNeeded * distance / 1600)` and the distance comes
 * straight back out. Against this repository's own example: 70 mm over 320 px gives exactly
 * 350, which is the distance it was compiled at.
 *
 * Worth doing rather than falling back to a default, because the default is closer than
 * anything an operator who chose 350 mm meant, and recompiling at it turns a piece the
 * publish gate should refuse into one that sails through. The rounding in the original
 * `ceil` is worth under `1600 / pixelsNeeded` millimetres and errs long, which puts the
 * recovered distance at or just past the real one, and further is the cautious direction.
 *
 * Null when the fields are not there or do not give a distance anyone could hold, and the
 * caller then has to say so rather than guess.
 */
export function distanceBehind(report: unknown): number | null {
  // A report that carries its distance was computed for it, and working one back out of the
  // width with the old build's arithmetic gives a confident wrong answer instead: 735 mm for a
  // report computed at 190, which is four times out because the arithmetic below is the old
  // model's and the width is the new one's.
  if (carriesItsDistance(report)) return report.scanDistanceMm;
  const fields = report as {
    minimumWidthMm?: unknown;
    smallestUsableScale?: unknown;
    analysisWidth?: unknown;
  };
  const width = fields?.minimumWidthMm;
  const scale = fields?.smallestUsableScale;
  const across = fields?.analysisWidth;
  if (typeof width !== "number" || typeof scale !== "number" || typeof across !== "number") return null;
  const pixelsNeeded = scale * across;
  if (!(pixelsNeeded > 0) || !(width > 0)) return null;
  const distance = Math.round((width * 1600) / pixelsNeeded);
  return distance >= 50 && distance <= 5000 ? distance : null;
}

/**
 * The widest a piece can be declared in a manifest, and so the widest answer worth giving.
 *
 * `physicalWidthMm` is capped at 5000 in `packages/manifest/schema/manifest-1.0.0.json`, and
 * the scan distance this accepts goes to ten metres, so the report could name a width no
 * manifest can carry: the example artwork read from ten metres asks for 7699 mm and was
 * called ready for press, which is a verdict nobody can act on. A piece declared at the
 * largest legal width is then refused by the bundler for being too narrow, which is the
 * first anyone hears of it.
 *
 * Not imported from the manifest package, because this one does not depend on it and a
 * dependency for one number is worse than a number with a test over it. There is a test that
 * reads the schema and fails if the two stop agreeing.
 */
export const WIDEST_DECLARABLE_MM = 5000;

const MIN_FEATURES = 60;
const MIN_AREAS = 8;
const GRID = 4;

/**
 * Points that must agree, in the worst of four turns of the print, before a width is called
 * enough.
 *
 * Twice the recogniser's own floor of ten. At the floor a pose is believed and no more, and the
 * frame this is measured on is the best case a phone will ever see: no lighting, no focus, no
 * angle, no paper. Four turns, because the count moves by a fifth as the print turns and a check
 * made only in the easiest pose passes artwork whose margin is gone at another.
 *
 * Measured: the worst of four turns at each size the compiled target covers, with the mark that
 * many pixels across in a 480 pixel frame.
 *
 *   piece                              320 px    400 px    500 px    640 px
 *   the example postcard                  58        85        83        15
 *   the same, softened                    60        77        89        42
 *   generated, 900 fine marks             97       105       103        36
 *   generated, 200 medium marks          115        74        49        13
 *   generated, 40 bold marks              24        28        21        11
 *   200 medium marks, printed twice       19        49        45        22
 *   the postcard printed 2 by 2            0         0        10        13
 *   the postcard printed 3 by 3            0         0         0         0
 *   the postcard printed 4 by 4                      0         0         0
 *   the postcard printed 5 by 5                                0         0
 *
 * No repeated sheet reaches more than 13 at any size. Everything else is found in every turn
 * and reaches at least 19 wherever the mark fits in the frame; at 640 pixels it does not, and
 * the counts fall for everything. The line sits above everything a sheet reaches and at or
 * below what every other piece reaches at the size it is accepted at.
 *
 * There is no empty gap above it, and that is worth knowing before moving it. Artwork with few
 * distinct marks lands a few points over the line, so whether it is confirmed at the first size
 * or the next can turn on a few points. That moves its width, which is the honest place for the
 * uncertainty, and not its verdict. The sheets are refused at every size by a wide margin.
 *
 * Calibrated on generated artwork and one example, in a simulation that is the best case; what
 * a real camera needs above the floor is what the print corpus and the field measurement are
 * for, and until they exist this is the line the measurements above support.
 *
 * This replaced a ceiling on `repetition`, which had a table of its own. Its first row read the
 * example postcard at 0.361, which the compiler does not produce: it reads 0.290. And the measure
 * fell as copies were added, so the 4 by 4 and 5 by 5 sheets passed under it and were not found
 * at the widths they were given.
 */
const AGREEING_POINTS_NEEDED = 20;

/**
 * Turn the features found at each size into the verdict a printer needs.
 *
 * The minimum width deserves a note, because getting it wrong costs a press run and the
 * first two attempts were wrong in different ways. It was once computed without reference
 * to the artwork at all, which made it the scan distance over ten for every file. It was
 * then derived from the spacing between neighbouring features, which on any densely
 * featured artwork just measures the detector's own minimum spacing, and where it did
 * vary it told printers that bold artwork needed a larger print than fine artwork, which
 * is backwards.
 *
 * Measured across designs from bold to very fine, every one survives to the bottom of the
 * size range the compiled target covers. That is the real answer: for a feature based
 * tracker this width is set by the camera and by the pixel range of the target, and the
 * artwork's part in it is close to a pass or a fail. So it is computed from the things
 * that set it, and the report carries both of them so the number can be checked.
 */
export function buildReport(input: ReportInput): Report {
  const { image, levels, scanDistanceMm } = input;
  if (!Number.isFinite(scanDistanceMm) || scanDistanceMm <= 0) {
    throw new RangeError(`scan distance must be a positive number of millimetres, got ${scanDistanceMm}`);
  }
  if (!(image.width > 0) || !(image.height > 0)) {
    throw new RangeError(`image must have a positive width and height, got ${image.width} x ${image.height}`);
  }
  for (const level of levels) {
    // Refused like the distance and the image are. A scale of zero, below zero or not a
    // number went straight into the width: zero printed "0 mm", minus one printed a negative
    // width, and NaN was written to the target file as `null`, which every gate in the
    // bundler then read as "nothing to compare" and let through.
    if (!(Number.isFinite(level.scale) && level.scale > 0 && level.scale <= 1)) {
      throw new RangeError(
        `a level's scale is a fraction of the analysed artwork, above 0 and at most 1, and this is ${level.scale}`,
      );
    }
  }

  const base = levels.find((level) => level.scale === 1)?.corners ?? levels[0]?.corners ?? [];
  const featureCount = base.length;
  const areasWithFeatures = areasTouched(base, image);

  // Null when there is nothing to judge, which is what the field says and what both places
  // that render it have a branch for. An empty list read as 0, so a checkerboard with no
  // usable features printed "0% of features have a look-alike, which is normal".
  const distinctiveness =
    input.described && input.described.length > 0 ? measureDistinctiveness(input.described) : null;
  const repetition = distinctiveness?.share ?? null;

  const reasons: string[] = [];
  if (featureCount < MIN_FEATURES) reasons.push("too few features to track reliably");
  else if (areasWithFeatures < MIN_AREAS) reasons.push("features are concentrated in part of the artwork");
  let pass = reasons.length === 0;

  // The smallest size that still holds up. A camera further away than this puts fewer
  // pixels across the mark than any size the target covers, and nothing will match.
  let smallestUsableScale = 1;
  for (const level of [...levels].sort((a, b) => b.scale - a.scale)) {
    if (!holdsUp(level.corners, image)) break;
    smallestUsableScale = level.scale;
  }

  // Pixels the recogniser has per millimetre of print, at this distance. The frame is a
  // fixed number of pixels wide and covers a width of print that grows with distance.
  const frameWidthMm = FRAME_WIDTH_MM_AT_1M * (scanDistanceMm / 1000);
  const pixelsPerMm = RECOGNISED_PIXELS_ACROSS_FRAME / frameWidthMm;
  const pixelsNeeded = smallestUsableScale * image.width;

  // There is deliberately no ceiling here, and there was one for a day, which was a mistake
  // worth leaving a note about. It refused artwork needing more pixels across itself than
  // the frame is wide, on the reasoning that the print would have to fill more than the
  // whole picture and no size could arrange that. The recogniser does not need the whole
  // mark in view. Driven against this repository's own example, at the frame width the
  // runtime uses:
  //
  //   506 px across the mark,  95% of its width in frame -> found, 116 inliers
  //   560 px across the mark,  86% of its width in frame -> found,  36 inliers
  //   640 px across the mark,  75% of its width in frame -> found, 123 inliers
  //   800 px across the mark,  60% of its width in frame -> not found
  //
  // So the width below stays a minimum and nothing else. Printing larger than it is never
  // the problem it looked like: a reader with a bigger piece in front of them stands back,
  // and standing back puts the same pixels across the same mark. What a large `pixelsNeeded`
  // really says is that the distance asked for is optimistic, and the width already says
  // that, in millimetres, which is the unit the person reading it works in.
  let minimumWidthMm = pass ? Math.ceil(pixelsNeeded / pixelsPerMm) : null;
  // A width no manifest can declare is not an answer. Said here rather than left to the
  // publish gate, because this is where "ready for press" is decided and a printer reading
  // that sentence has no reason to doubt it.
  if (minimumWidthMm !== null && minimumWidthMm > WIDEST_DECLARABLE_MM) {
    pass = false;
    minimumWidthMm = null;
    reasons.push(
      `it would have to be printed ${Math.ceil(pixelsNeeded / pixelsPerMm)} mm wide to be read from ${scanDistanceMm} mm, which is wider than any piece this format can describe. Read it from closer.`,
    );
  }

  // Readiness is decided by showing the artwork to the recogniser, not by inferring it from
  // the corners. The corners say which sizes the target covers; only the recogniser says
  // whether a mark of a given width is found. Every proxy for that has been measured wrong in
  // turn, the last a repetition figure that called a sheet of sixteen identical postcards
  // ready for press at a width where it is not found at all.
  //
  // So the width printed is the smallest the recogniser confirms. It starts where the corners
  // say, and when the recogniser does not agree there it moves up through the sizes the target
  // covers. Artwork the recogniser confirms at no size is not ready, whatever its corners say.
  let recognition: Recognition | null = null;
  if (pass && minimumWidthMm !== null) {
    if (input.recognises === undefined) {
      pass = false;
      reasons.push(
        "it was never put in front of the recogniser at the width it would be printed, so nothing says that width is enough",
      );
    } else {
      const sizes = [...new Set(levels.map((level) => level.scale))]
        .filter((scale) => scale >= smallestUsableScale)
        .sort((a, b) => a - b);
      let best: { recognition: Recognition; widthMm: number } | null = null;
      let confirmed: { scale: number; widthMm: number } | null = null;
      for (const scale of sizes) {
        const widthMm = Math.ceil((scale * image.width) / pixelsPerMm);
        // A width no manifest can declare is not one to confirm. Checked before the
        // recogniser runs, because a larger size is only ever wider.
        if (widthMm > WIDEST_DECLARABLE_MM) break;
        // The pixels this width puts across the mark, rounded the way the width was, so what
        // is checked is the number a printer acts on and not the one before rounding.
        const pixelsAcross = Math.round(widthMm * pixelsPerMm);
        const seen = input.recognises(pixelsAcross);
        const attempt: Recognition = {
          pixelsAcross,
          found: seen.found,
          inliers: seen.found ? seen.inliers : 0,
          needed: AGREEING_POINTS_NEEDED,
        };
        if (best === null || attempt.inliers > best.recognition.inliers)
          best = { recognition: attempt, widthMm };
        if (attempt.found && attempt.inliers >= AGREEING_POINTS_NEEDED) {
          recognition = attempt;
          confirmed = { scale, widthMm };
          break;
        }
      }
      if (confirmed !== null) {
        smallestUsableScale = confirmed.scale;
        minimumWidthMm = confirmed.widthMm;
      } else {
        pass = false;
        recognition = best?.recognition ?? null;
        reasons.push(
          best === null
            ? `no size the target covers can be printed narrower than ${WIDEST_DECLARABLE_MM} mm at this distance, so the recogniser could not be asked`
            : `the recogniser did not find it with ${AGREEING_POINTS_NEEDED} points agreeing at any size the target covers, and the most it found was ${best.recognition.inliers}, printed ${best.widthMm} mm wide and read from ${scanDistanceMm} mm. Artwork that repeats itself does this: the same detail in several places leaves the recogniser unable to settle on one`,
        );
      }
    }
    if (!pass) minimumWidthMm = null;
  }

  return {
    score: scoreOf(featureCount / MIN_FEATURES, areasWithFeatures / MIN_AREAS, pass),
    pass,
    scanDistanceMm,
    featureCount,
    areasWithFeatures,
    areas: GRID * GRID,
    repetition,
    recognition,
    analysisWidth: image.width,
    smallestUsableScale,
    minimumWidthMm,
    reasons,
  };
}

/**
 * The line that goes next to the number, so nobody reads it as a measurement of the design.
 *
 * It names the edge. The width is the artwork's extent from left to right as its file is
 * oriented, and the same postcard exported upright is 104 mm where on its side it is 147, so a
 * width with no edge invited a manifest declaring the other one: every gate passed and the
 * print came out 30 per cent under.
 *
 * The distance comes out of the report rather than in as an argument, for the same reason
 * it does in the console: a caller holding a width and a distance separately is a caller
 * who can pair a width with a distance it was never computed for, and one already had.
 */
export function describeWidth(report: Report): string {
  if (report.minimumWidthMm === null) return "not printable until the artwork passes";
  const pixels = Math.round(report.smallestUsableScale * report.analysisWidth);
  return `${report.minimumWidthMm} mm to be read from ${report.scanDistanceMm} mm away, being ${pixels} px across the artwork from left to right`;
}

function areasTouched(corners: Corner[], image: { width: number; height: number }): number {
  const cells = new Set<number>();
  for (const corner of corners) {
    // Clamped at both ends: buildReport is exported, so its caller's coordinates are not
    // this package's to trust, and an unclamped index puts the count above the grid size.
    const cx = clamp(Math.floor((corner.x / image.width) * GRID), 0, GRID - 1);
    const cy = clamp(Math.floor((corner.y / image.height) * GRID), 0, GRID - 1);
    cells.add(cy * GRID + cx);
  }
  return cells.size;
}

function holdsUp(corners: Corner[], image: { width: number; height: number }): boolean {
  return corners.length >= MIN_FEATURES && areasTouched(corners, image) >= MIN_AREAS;
}

function clamp(value: number, low: number, high: number): number {
  return value < low || Number.isNaN(value) ? low : value > high ? high : value;
}

/**
 * Score and verdict have to agree, so the score is built around the gates rather than
 * beside them: 60 is exactly the pass mark, everything below it is how far short the
 * artwork falls, and everything above is headroom.
 *
 * They were two independent formulas, which let a run print 35 out of 100 above the word
 * "ready" and 78 above "not ready". Whichever number a reader trusted, the other one
 * contradicted it.
 */
function scoreOf(featureRatio: number, areaRatio: number, pass: boolean): number {
  const worst = Math.min(featureRatio, areaRatio);
  if (!pass) return Math.max(0, Math.min(59, Math.round(59 * worst)));
  const headroom = Math.min(1, (featureRatio - 1) / 3) * 0.6 + Math.min(1, areaRatio - 1) * 0.4;
  return Math.min(100, 60 + Math.round(40 * headroom));
}

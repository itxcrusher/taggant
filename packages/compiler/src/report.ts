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
}

export interface Report {
  /** 0 to 100. Below 60 exactly when the artwork fails, so the two never disagree. */
  score: number;
  pass: boolean;
  featureCount: number;
  /** Areas of a 4 by 4 grid over the artwork that hold at least one feature. */
  areasWithFeatures: number;
  /**
   * Share of features that have a look-alike somewhere else on the artwork, from 0 to 1.
   * Null when there were no descriptions to judge. High means the artwork repeats, and a
   * pose can land on the wrong copy.
   */
  repetition: number | null;
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

const MIN_FEATURES = 60;
const MIN_AREAS = 8;
const GRID = 4;

/**
 * How much of the artwork may look like the rest of it.
 *
 * Above this a matcher has no way to know which copy of a repeated pattern it is looking
 * at, and the pose it produces can be a whole tile out while reporting plenty of agreeing
 * matches, so the runtime shows content confidently in the wrong place.
 *
 * Set from measurement rather than taste. Five pieces of artwork, each located in sixty
 * poses from zero to ninety degrees, with the error measured against the known mapping:
 *
 *   artwork                    repetition   poses placed more than 50 px out
 *   postcard                     0.361                0 of 60
 *   medium, 200 marks            0.398                0 of 60
 *   fine, 900 marks              0.463                0 of 60
 *   medium, printed twice        0.743                2 of 60
 *   postcard, printed twice      0.752                7 of 60
 *
 * Everything that places correctly sits at or below 0.46 and everything that mislocates
 * sits above 0.74, so the line goes between them with room on both sides.
 */
const MAX_REPETITION = 0.6;

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

  const base = levels.find((level) => level.scale === 1)?.corners ?? levels[0]?.corners ?? [];
  const featureCount = base.length;
  const areasWithFeatures = areasTouched(base, image);

  const distinctiveness = input.described ? measureDistinctiveness(input.described) : null;
  const repetition = distinctiveness?.share ?? null;

  const reasons: string[] = [];
  if (featureCount < MIN_FEATURES) reasons.push("too few features to track reliably");
  else if (areasWithFeatures < MIN_AREAS) reasons.push("features are concentrated in part of the artwork");
  if (repetition !== null && repetition > MAX_REPETITION) {
    reasons.push("the artwork repeats itself, so content could be placed on the wrong copy");
  }
  const pass = reasons.length === 0;

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
  const minimumWidthMm = pass ? Math.ceil(pixelsNeeded / pixelsPerMm) : null;

  return {
    score: scoreOf(featureCount / MIN_FEATURES, areasWithFeatures / MIN_AREAS, pass),
    pass,
    scanDistanceMm,
    featureCount,
    areasWithFeatures,
    areas: GRID * GRID,
    repetition,
    analysisWidth: image.width,
    smallestUsableScale,
    minimumWidthMm,
    reasons,
  };
}

/**
 * The line that goes next to the number, so nobody reads it as a measurement of the design.
 *
 * The distance comes out of the report rather than in as an argument, for the same reason
 * it does in the console: a caller holding a width and a distance separately is a caller
 * who can pair a width with a distance it was never computed for, and one already had.
 */
export function describeWidth(report: Report): string {
  if (report.minimumWidthMm === null) return "not printable until the artwork passes";
  const pixels = Math.round(report.smallestUsableScale * report.analysisWidth);
  return `${report.minimumWidthMm} mm to be read from ${report.scanDistanceMm} mm away, being ${pixels} px across the artwork`;
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

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
 * ASSUMPTION, and the only one here. A 60 degree horizontal field, which is ordinary for a
 * phone's rear camera, spans 2 * 1000 * tan(30) millimetres at a metre. Narrower optics
 * span less and make every minimum below smaller; a wide angle lens makes them larger.
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

  // Artwork that holds up only at or near its full size cannot be read at any distance.
  // The mark would have to be wider than the whole picture to put enough pixels across
  // itself, and no print size or working distance can arrange that. Printing a width here
  // would name a size that does not work, which is worse than saying it cannot be done.
  if (pixelsNeeded > RECOGNISED_PIXELS_ACROSS_FRAME) {
    pass = false;
    reasons.push(
      "detail survives only near full size, so the print would have to fill more than the whole picture to be read",
    );
  }
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

/** The line that goes next to the number, so nobody reads it as a measurement of the design. */
export function describeWidth(report: Report, scanDistanceMm: number): string {
  if (report.minimumWidthMm === null) return "not printable until the artwork passes";
  const pixels = Math.round(report.smallestUsableScale * report.analysisWidth);
  return `${report.minimumWidthMm} mm to be read from ${scanDistanceMm} mm away, being ${pixels} px across the artwork`;
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

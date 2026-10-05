import { type Corner, type Repetition, type TargetFeature, measureRepetition } from "@taggant/vision";

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
   * Every feature the target holds, described, at every size, for judging whether the design
   * maps onto itself. Supplied by whoever built them, which is the compiler. Without them, or
   * with none that can be read, a report cannot pass, because nothing says the design is not
   * printed twice.
   */
  features?: TargetFeature[];
  /**
   * The artwork described at sizes below any the target covers, which the target does not hold,
   * measured with the features above so that a copy of the design at less than half its size
   * pairs with the original.
   */
  smaller?: TargetFeature[];
  /** Distance in millimetres at which a person is expected to hold the camera. */
  scanDistanceMm: number;
  /**
   * Show the recogniser the artwork with this many pixels across it, once for each turn it is
   * shown at, and say what it made of each: pointed at the artwork's centre, or at the point
   * given, in the artwork's own pixels.
   *
   * Supplied by whoever has the pixels, which is the compiler; this module has corners and
   * nothing else. Without it a report cannot pass, because every way of deciding readiness
   * from the corners alone has been measured wrong.
   */
  recognises?: (pixelsAcross: number, aim?: { x: number; y: number }) => View[] | Promise<View[]>;
}

/** One look the recogniser took: the artwork at one width and one turn. */
export interface View {
  found: boolean;
  /** Matches that agreed with the pose it fitted; none when it was not found. */
  inliers: number;
  /**
   * Found, with the pose putting the artwork more than a tenth of its own width from where it
   * is: on another copy of a design that repeats, or nowhere near.
   */
  misplaced: boolean;
}

/**
 * The recogniser pointed at the two ends of the move that carries the most places, at every size
 * the target covers: where the move takes its places from, and where it puts them.
 */
export interface Aimed {
  /** Sizes the target covers that were looked at, smallest first, until one put it in the wrong place. */
  sizes: number;
  /**
   * Looks taken, until one put the artwork in the wrong place: when none did, the same number at
   * each end at each size.
   */
  views: number;
  /** Of those, the looks that put the artwork somewhere other than where it is. */
  misplaced: number;
}

/** How far the design maps onto itself, and what the recogniser made of it pointed there. */
export type MeasuredRepetition = Repetition & { aimed: Aimed | null };

/** What the recogniser made of the artwork at the size a report gives. */
export interface Recognition {
  /** Pixels across the artwork at that size; it was shown at this and at two widths either side. */
  pixelsAcross: number;
  /** Widths it was shown at, each at every turn. */
  widths: number;
  /** Widths at which every turn found it with at least `needed` points agreeing. */
  widthsAgreed: number;
  /** Looks it was given in all, a width at one turn being one look. */
  views: number;
  /** Looks that found it in the wrong place, at that size or one size smaller. */
  misplaced: number;
  /**
   * The middle of the widths' worst turns, a look that found nothing counting as none: every
   * turn at three of the five widths found at least this many points agreeing. It is the figure
   * the line of `needed` is held against, because three of five agreeing is exactly this
   * reaching the line. Not the worst turn at the middle width, which it was described as.
   */
  inliers: number;
  /** How many points every turn needs at a width before that width counts. */
  needed: number;
  /** Whether that size was confirmed: most widths agreed, and no look was in the wrong place. */
  found: boolean;
}

export interface Report {
  /** 0 to 100. Below 60 exactly when the artwork fails, so the two never disagree. */
  score: number;
  pass: boolean;
  featureCount: number;
  /** Areas of a 4 by 4 grid over the artwork that hold at least one feature. */
  areasWithFeatures: number;
  /**
   * How far the design maps onto itself: the most places on the artwork that one move of the
   * whole of it, other than leaving it where it is, carries onto look-alikes of themselves, out
   * of all the places holding a feature. A design crossing both lines in `REPEATS_FROM` repeats
   * itself and is refused before the recogniser is asked. Null only from a caller that supplied
   * no features, and a report like that does not pass.
   *
   * The field held a figure of another kind until this build, the share of features with one
   * look-alike that stood out, which fell as a design repeated: two copies of a label read 1.0
   * and three read 0. It decided readiness until a sheet of sixteen identical postcards passed,
   * and was then kept as a diagnostic beside a recogniser that settled repeated designs by
   * whether one look in twenty landed on the wrong copy, which it did at some export widths of
   * the same design and not at others.
   *
   * `aimed` is the recogniser pointed at both ends of that move, taken for a design whose move
   * carries `AIMED_FROM` places or more and is not refused outright; null when it was not taken.
   */
  repetition: MeasuredRepetition | null;
  /**
   * The artwork put in front of the recogniser at the size this report gives, and what came
   * back. This is what decides readiness: the width is a claim about what a camera at the scan
   * distance will see, and the only check of that claim is to show it to the thing that has to
   * see it. When nothing passed, the size that came closest.
   *
   * Null when nothing drove it, and a report like that does not pass.
   */
  recognition: Recognition | null;
  /** How many areas there are, so the count above reads without knowing the grid. */
  areas: number;
  /** Pixels across the artwork as it was analysed. The width below is derived from it. */
  analysisWidth: number;
  /**
   * Smallest size, as a fraction of the analysed artwork, at which it still holds up: the size
   * the recogniser confirmed, when the report passes. When it does not, this is only what the
   * corners say, and nothing should present it as a size the artwork can be printed at.
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
  return (
    typeof distance === "number" &&
    Number.isFinite(distance) &&
    distance >= SCAN_DISTANCE_MM.nearest &&
    distance <= SCAN_DISTANCE_MM.furthest
  );
}

/**
 * The scan distances anything here accepts, in millimetres: a phone held close, to a person
 * standing back from a large piece.
 *
 * One range for everything that takes a distance. The command line took up to ten metres and
 * the console up to five, so a target compiled at six metres was published as it stood by one
 * and could not be published by the other, which refused to compile it again there.
 */
export const SCAN_DISTANCE_MM = { nearest: 50, furthest: 10_000 } as const;

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
  const { pass, score, reasons } = fields;
  // Every field checked against what this build writes, not only the ones a reader acts on. It
  // checked the verdict, the width's type and the recognition's counts, and accepted a report
  // decided on one width, a pass scoring 10, a pass with three features, and a width edited to
  // 1 mm, which turned the bundler's comparison off for a piece that needs 147.
  if (typeof pass !== "boolean" || !isCount(score) || score > 100 || pass !== score >= 60) return false;
  // A passing report has nothing against it and a failing one says why. A report with no list
  // here took the console's page down with a TypeError.
  if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === "string")) return false;
  if (pass === reasons.length > 0) return false;
  const { featureCount, areasWithFeatures, areas, analysisWidth, smallestUsableScale } = fields;
  if (!isCount(featureCount) || !isCount(areasWithFeatures) || areas !== GRID * GRID) return false;
  if (areasWithFeatures > areas || !isCount(analysisWidth) || analysisWidth === 0) return false;
  if (typeof smallestUsableScale !== "number" || !(smallestUsableScale > 0 && smallestUsableScale <= 1))
    return false;
  const width = fields.minimumWidthMm;
  if (width !== null && !(typeof width === "number" && Number.isFinite(width) && width > 0)) return false;
  // A passing report names a width; a failing one names none.
  if (pass !== (width !== null)) return false;

  const seen = fields.recognition;
  if (seen === undefined || (seen !== null && !isRecord(seen))) return false;
  if (seen !== null) {
    // Every count a number a count can be. The widths fields are what tell a report from this
    // build from one decided on a single width, whose verdict flipped with a millimetre of
    // distance.
    const { pixelsAcross, widths, widthsAgreed, views, misplaced, inliers, needed, found } = seen;
    const counts = [pixelsAcross, widths, widthsAgreed, views, misplaced, inliers];
    if (!counts.every(isCount) || needed !== AGREEING_POINTS_NEEDED || typeof found !== "boolean")
      return false;
    if ((widthsAgreed as number) > (widths as number) || (widths as number) > WIDTHS_SHOWN.length)
      return false;
    if ((misplaced as number) > (views as number)) return false;
  }

  // Measured by every compile this build makes, so a report without it is from an earlier one:
  // the build whose verdict on a design printed twice turned on its export width.
  const repeated = fields.repetition;
  if (!isRecord(repeated) || !isCount(repeated.places) || !isCount(repeated.of)) return false;
  if (repeated.places > repeated.of) return false;
  const move = repeated.move;
  if (
    move !== null &&
    !(isRecord(move) && [move.across, move.down, move.turnDegrees, move.scale].every(isFiniteNumber))
  )
    return false;
  // Where the move's two ends are, present exactly when there is a move.
  const ends = repeated.ends;
  if (ends !== null && !(isRecord(ends) && isPoint(ends.from) && isPoint(ends.to))) return false;
  if ((move === null) !== (ends === null)) return false;
  // The recogniser pointed at those ends, at one size or more, until a look was in the wrong place.
  const aimed = repeated.aimed;
  if (
    aimed !== null &&
    !(
      isRecord(aimed) &&
      isCount(aimed.sizes) &&
      isCount(aimed.views) &&
      isCount(aimed.misplaced) &&
      aimed.sizes > 0 &&
      aimed.misplaced <= aimed.views
    )
  )
    return false;

  if (pass) {
    if (featureCount < MIN_FEATURES || areasWithFeatures < MIN_AREAS) return false;
    if (repeats(repeated as unknown as Repetition)) return false;
    // Measured over places that hold features: a pass measured over none was never measured.
    if (repeated.of === 0) return false;
    // Pointed at both ends of a move carrying enough places to need it, the same number of looks
    // at each end at each size, and put in the right place every time; not pointed at all for one
    // that carries fewer. Only a pass has every look: a refusal stops at the first wrong one,
    // which can be at either end of any size.
    const pointed = aimed as Aimed | null;
    if ((repeated.places as number) >= AIMED_FROM) {
      if (pointed === null || pointed.misplaced !== 0 || pointed.views === 0) return false;
      if (pointed.views % (2 * pointed.sizes) !== 0) return false;
    } else if (pointed !== null) {
      return false;
    }
    // Asked, and agreed: at most of its widths, in every turn, never in the wrong place, and at
    // the size the report names.
    if (seen === null || seen.found !== true) return false;
    const recognition = seen as unknown as Recognition;
    if (recognition.widths !== WIDTHS_SHOWN.length || recognition.widthsAgreed * 2 <= recognition.widths)
      return false;
    if (recognition.misplaced !== 0 || recognition.inliers < recognition.needed) return false;
    if (recognition.views < recognition.widths || recognition.views % recognition.widths !== 0) return false;
    if (recognition.pixelsAcross !== Math.round(smallestUsableScale * analysisWidth)) return false;
    // The width is not a separate fact: it is the confirmed size turned into millimetres at the
    // report's own distance, and recomputing it is what makes it a check rather than a reading.
    const scanDistanceMm = fields.scanDistanceMm as number;
    if (width !== printWidthMm(smallestUsableScale * analysisWidth, scanDistanceMm)) return false;
    if ((width as number) > WIDEST_DECLARABLE_MM) return false;
  }
  return true;
}

function isPoint(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The narrowest print, in millimetres, that puts this many pixels across the artwork in a frame
 * taken at this distance. One function for the report and for the check of a stored one, so the
 * two cannot round differently.
 */
function printWidthMm(pixelsAcross: number, scanDistanceMm: number): number {
  // Pixels the recogniser has per millimetre of print, at this distance. The frame is a fixed
  // number of pixels wide and covers a width of print that grows with distance.
  const frameWidthMm = FRAME_WIDTH_MM_AT_1M * (scanDistanceMm / 1000);
  return Math.ceil(pixelsAcross / (RECOGNISED_PIXELS_ACROSS_FRAME / frameWidthMm));
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
 * Points that must agree in a look before the look counts.
 *
 * Twice the recogniser's own floor of ten. At the floor a pose is believed and no more, and the
 * frame this is measured on is the best case a phone will ever see: no lighting, no focus, no
 * angle, no paper.
 */
const AGREEING_POINTS_NEEDED = 20;

/**
 * How far from where the artwork is a pose may put it, as a share of the artwork's width,
 * before it counts as found in the wrong place.
 *
 * Measured over 3 067 found views of 24 pieces: every pose of a design that does not repeat
 * itself was within 0.1 of the artwork's width at the sizes where it fits the frame, most of
 * them within 0.01, and every pose that put a repeated design on another copy of itself was 0.13
 * or more out, most of them 0.35 to 0.71. Imprecision and the wrong place are different
 * failures, and this tells them apart: a pose a few per cent out draws content a little off, and
 * one a third of the way across draws it on the wrong label.
 *
 * A look pointed at one part of the artwork, to check a copy, is judged at that point instead of
 * at the corners, against the same share of the artwork's width. The artwork is then larger than
 * the frame and its corners can be far outside it, where a pose a few pixels out at the middle of
 * the frame is a hundred out: judged there, a design with no copy was refused at two export widths
 * of ten. At the point, the pose that refused it was 4.5 pixels out against a line of 40, and
 * every copy tried from three tenths to three quarters of the design's size was still put in the
 * wrong place. The line itself was measured on centred looks.
 *
 * The same line decides which moves count when the design is checked for mapping onto itself.
 */
export const MISPLACED_BEYOND = 0.1;

/**
 * When a design repeats itself: one move of the whole artwork carries at least this many of its
 * places onto look-alikes, and at least this share of all of them.
 *
 * Set from what was measured either side of it, with the features of the sizes the target covers
 * and of the smaller sizes the compiler adds. Over 51 sheets of copies, the postcard printed
 * twice exported at seventeen widths, with gutters and margins of every size tried, in six
 * layouts, and a generated design twice, four times and beside itself turned half way round,
 * none came under 105 places or a share of 0.291. Over 138 pieces that repeat nothing, every
 * wallpaper on one machine with portrait and tall crops of each, and generated designs at seven
 * densities in three shapes, none came over 19 places, and of the 86 with sixty or more places
 * holding a feature, none came over a share of 0.114. Both lines sit in those gaps, and it takes
 * both: the most places a piece repeating nothing reached is one under the line, at a share of
 * 0.058. Without the smaller sizes the same pieces gave 101 and 0.268 against 11 and 0.104.
 *
 * Twenty places, because that is the line a look's points are held to: a move carrying fewer
 * has fewer look-alikes to put behind the wrong pose than a look needs to count. A fifth, because
 * a part of a design printed twice, a logo on a label, is not the design repeating: a square a
 * quarter of a design's area copied elsewhere on it measured 114 places at 0.147, and was put in
 * the right place in every one of 1200 looks at two sizes. What this leaves to the recogniser's
 * own looks is a design less than a fifth of which repeats, and a periodic texture, whose many
 * moves each carry a part of it: a brick wall measured 124 places at 0.124 and a grid 66 at 0.192.
 */
export const REPEATS_FROM = { places: AGREEING_POINTS_NEEDED, share: 0.2 } as const;

/**
 * From how many places carried by one move the recogniser is pointed at both ends of it, at every
 * size the target covers, before a design is called ready for press.
 *
 * The lines above refuse a design printed twice at one size, and a copy at another size sits
 * under them: it pairs only through the sizes whose ratio matches its own, so its move carries a
 * fraction of the smaller copy's places, and the postcard beside a copy of itself at 60 per cent
 * was called ready for press. A camera pointed at the small copy settles on the large one and
 * draws the content there. A part of a design copied at its own size can measure as much and is
 * not put in the wrong place, because the rest of the artwork outvotes it. The measure cannot
 * tell the two apart and the recogniser can, so for a move carrying this many places it is asked,
 * pointed where the move takes its places from and where it puts them. The smaller copy is
 * looked at grown by the move's change of size as well, which is the camera brought close
 * enough to it that it fills as much of the frame as the larger copy does from further back:
 * pointed at the plain sizes alone, nine of twelve such designs still passed.
 *
 * Measured on the postcard and a generated design beside copies of themselves, at the side, below
 * and turned: copies at three tenths to three quarters of the design's size carried 14 to 111
 * places, under both lines, and copies at a quarter and a fifth carried 5 to 10, which this does
 * not reach. Twelve, because the 35 per cent copy carried 14. Of the 138 pieces repeating nothing
 * above, five carry twelve or more, up to 19, and are asked too, which costs them seconds.
 */
export const AIMED_FROM = 12;

/** Whether a measured repetition crosses both lines in `REPEATS_FROM`. */
export function repeats(repetition: Repetition): boolean {
  return repetition.places >= REPEATS_FROM.places && repetition.places >= REPEATS_FROM.share * repetition.of;
}

/**
 * The widths the recogniser is shown at each size, as fractions of that size's own width.
 *
 * **One width was the defect.** The count of agreeing points is noisy from one pixel to the next:
 * a sheet of four generated designs at one size gave 21, 17 and 20 at 506, 507 and 508 pixels
 * across, and the width checked came from rounding the scan distance's arithmetic to whole
 * millimetres and back. So which side of the line a piece fell turned on that arithmetic: the
 * same sheet was ready at 190 mm and not at 191, and a sweep from 150 to 400 mm alternated every
 * few millimetres. Exported at half the size, the same sheet gave the other answer again.
 *
 * Now each size is judged over five widths, one per cent apart and fixed by the size alone, at
 * four turns each: twenty looks, none of which the distance can move. The distance only turns
 * the size that passes into millimetres. Over 96 sizes of 24 pieces, the rule over one width
 * changed its verdict at 10 when the width moved by one per cent, and this one, over five,
 * changed at none. Each look is a few hundred milliseconds, so twenty is what stability costs.
 */
const WIDTHS_SHOWN = [0.98, 0.99, 1, 1.01, 1.02] as const;

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
export async function buildReport(input: ReportInput): Promise<Report> {
  const { image, levels, scanDistanceMm } = input;
  // The same range the stored check holds a report to: a positive distance short of it wrote a
  // passing report that the bundler then refused as written by an older build.
  if (
    !Number.isFinite(scanDistanceMm) ||
    scanDistanceMm < SCAN_DISTANCE_MM.nearest ||
    scanDistanceMm > SCAN_DISTANCE_MM.furthest
  ) {
    throw new RangeError(
      `scan distance must be ${SCAN_DISTANCE_MM.nearest} to ${SCAN_DISTANCE_MM.furthest} mm, got ${scanDistanceMm}`,
    );
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
    // Every size is judged at five widths, and a pass is held to all five. A level this narrow
    // rounds two of them to one pixel count, and passed on three widths a stored report is then
    // refused for. The loader's smallest artwork is 256 pixels on its shorter edge, wide enough at
    // every size the target covers, so only a caller of this function can ask it.
    const across = new Set(WIDTHS_SHOWN.map((fraction) => Math.round(level.scale * image.width * fraction)));
    if (across.size < WIDTHS_SHOWN.length) {
      throw new RangeError(
        `a level ${Math.round(level.scale * image.width)} px across is too narrow to be shown at ${WIDTHS_SHOWN.length} different widths`,
      );
    }
  }

  const base = levels.find((level) => level.scale === 1)?.corners ?? levels[0]?.corners ?? [];
  const featureCount = base.length;
  const areasWithFeatures = areasTouched(base, image);

  // Measured whenever there are features to measure, so even a refused report says it.
  const repetition =
    input.features === undefined
      ? null
      : measureRepetition([...input.features, ...(input.smaller ?? [])], image, {
          farEnough: MISPLACED_BEYOND * image.width,
        });

  const reasons: string[] = [];
  if (featureCount < MIN_FEATURES) reasons.push("too few features to track reliably");
  else if (areasWithFeatures < MIN_AREAS) reasons.push("features are concentrated in part of the artwork");
  // Before the recogniser is asked, because the recogniser cannot settle it. A design printed
  // twice is found on the right copy in most looks and on the other in a few, and which few
  // depends on resampling noise: the postcard printed twice was refused at six of seventeen
  // export widths and ready for press at the other eleven, and a sheet of four with a gutter was
  // ready. What the looks were sampling is a property of the artwork, and it is measured here.
  if (repetition === null) {
    reasons.push(
      "it was never checked for repeating itself, so nothing says the content would be drawn on the right copy",
    );
  } else if (repetition.of === 0) {
    // No features, or none that could be read, are not a design that repeats nothing, and
    // measured as one they read as nothing to fear.
    reasons.push(
      (input.features?.length ?? 0) > 0
        ? "none of its features could be read to check whether it repeats itself, so nothing says the content would be drawn on the right copy"
        : "it was given no features to check for repeating itself, so nothing says the content would be drawn on the right copy",
    );
  } else if (repeats(repetition)) {
    reasons.push(repeatsItself(repetition));
  }
  let pass = reasons.length === 0;

  // The smallest size that still holds up. A camera further away than this puts fewer
  // pixels across the mark than any size the target covers, and nothing will match.
  let smallestUsableScale = 1;
  for (const level of [...levels].sort((a, b) => b.scale - a.scale)) {
    if (!holdsUp(level.corners, image)) break;
    smallestUsableScale = level.scale;
  }

  // There is deliberately no ceiling on how many pixels a size may put across the mark, and
  // there was one for a day, which was a mistake worth leaving a note about. It refused artwork
  // needing more pixels across itself than the frame is wide, on the reasoning that the print
  // would have to fill more than the whole picture and no size could arrange that. The
  // recogniser does not need the whole mark in view. Driven against this repository's own
  // example, at the frame width the runtime uses:
  //
  //   506 px across the mark,  95% of its width in frame -> found, 116 inliers
  //   560 px across the mark,  86% of its width in frame -> found,  36 inliers
  //   640 px across the mark,  75% of its width in frame -> found, 123 inliers
  //   800 px across the mark,  60% of its width in frame -> not found
  //
  // So the width stays a minimum and nothing else. Printing larger than it is never the problem
  // it looked like: a reader with a bigger piece in front of them stands back, and standing back
  // puts the same pixels across the same mark.
  let minimumWidthMm: number | null = null;

  // Readiness is decided by showing the artwork to the recogniser, not by inferring it from
  // the corners. The corners say whether there is enough to work with and which sizes the
  // target covers; only the recogniser says whether a mark of a given width is found. Every
  // proxy for that has been measured wrong in turn, the last a repetition figure that called a
  // sheet of sixteen identical postcards ready for press at a width where it is not found.
  //
  // So the width printed is the smallest the recogniser confirms, and the search starts at the
  // smallest size the target covers rather than where the corners say. Started from the
  // corners, bold artwork whose corners hold up only at full size was asked about at full size
  // alone, where the mark overflows the frame, and was refused for repeating itself when it
  // repeats nothing; the recogniser finds the same artwork at half that size.
  let recognition: Recognition | null = null;
  const sizes = [...new Set(levels.map((level) => level.scale))].sort((a, b) => a - b);
  if (pass) {
    if (input.recognises === undefined) {
      pass = false;
      reasons.push(
        "it was never put in front of the recogniser at the width it would be printed, so nothing says that width is enough",
      );
    } else {
      const outcome = await confirmSize({
        recognises: input.recognises,
        sizes,
        analysisWidth: image.width,
        scanDistanceMm,
      });
      recognition = outcome.recognition;
      if (outcome.confirmed !== null) {
        smallestUsableScale = outcome.confirmed.scale;
        minimumWidthMm = outcome.confirmed.widthMm;
      } else {
        pass = false;
        reasons.push(refusal(outcome, scanDistanceMm));
      }
    }
  }

  // A move carrying enough places to need it: the recogniser pointed at both of its ends, at every
  // size the target covers. Pointed at one copy of a design with a second copy at another size,
  // a camera settles on the other copy, and the centred looks above never point there.
  let aimed: Aimed | null = null;
  if (
    pass &&
    input.recognises !== undefined &&
    repetition !== null &&
    repetition.ends !== null &&
    repetition.places >= AIMED_FROM
  ) {
    const looked = await aimAt({
      recognises: input.recognises,
      ends: repetition.ends,
      scale: repetition.move?.scale ?? 1,
      sizes,
      analysisWidth: image.width,
    });
    aimed = { sizes: looked.sizes, views: looked.views, misplaced: looked.misplaced };
    if (looked.at !== null) {
      pass = false;
      minimumWidthMm = null;
      reasons.push(aimedRefusal(repetition, looked.at, scanDistanceMm, image));
    }
  }

  // A refusal by the recogniser scores by how far short of agreeing it fell. It scored by the
  // corners alone, so a sheet found nowhere read 59 of 100, one point under passing.
  const agreedShare =
    recognition === null || pass
      ? 1
      : recognition.widths === 0
        ? 0
        : (2 * recognition.widthsAgreed) / recognition.widths;

  return {
    score: Math.min(
      scoreOf(featureCount / MIN_FEATURES, areasWithFeatures / MIN_AREAS, pass),
      pass ? 100 : Math.round(59 * Math.min(1, agreedShare)),
    ),
    pass,
    scanDistanceMm,
    featureCount,
    areasWithFeatures,
    areas: GRID * GRID,
    repetition: repetition === null ? null : { ...repetition, aimed },
    recognition,
    analysisWidth: image.width,
    smallestUsableScale,
    minimumWidthMm,
    reasons,
  };
}

interface SizeOutcome {
  /** The size confirmed and its width, or null when none was. */
  confirmed: { scale: number; widthMm: number } | null;
  /** What was seen at the confirmed size, or at the size that came closest. */
  recognition: Recognition | null;
  /** The width of that closest size. */
  widthMm: number | null;
  /** Set when a pose put the artwork in the wrong place, at the size where it happened. */
  misplacedAt: { widthMm: number; misplaced: number; views: number } | null;
  /** Set when the smallest size the target covers is already wider than any manifest allows. */
  tooWideMm: number | null;
  /**
   * Set when the search stopped at a size wider than any manifest allows, with smaller sizes
   * already asked about and refused: the width that size would have needed.
   */
  stoppedAtMm: number | null;
}

/**
 * The smallest size the recogniser confirms, from the smallest the target covers upwards.
 *
 * A size is confirmed when, of its five widths, at least three are found in every one of the four
 * turns with twice the recogniser's floor agreeing, and no look at all puts the artwork in the
 * wrong place; and, when the target covers a size below it, no look at that size does either.
 *
 * Every turn at a width, because a person holds a label at whatever angle it comes to hand and
 * the count moves by a fifth as it turns, which is the rule this replaced, held at one width. Most
 * widths rather than all, because one width is a sample of noise. Counted over every look
 * instead, as half of the twenty, the line was easier than the rule it replaced: a sheet of four
 * postcards exported 4400 pixels wide was ready for press.
 *
 * The size below is for the reader who stands a little further off than planned, who sees the
 * print one size smaller. Being found there with too few points is harmless, because the reader
 * steps closer; being found in the wrong place is not, because the content is drawn there. This
 * was how a design printed twice was refused, and it was a lottery: one look in twelve to twenty
 * landed on the other copy, so whether twenty looks saw one turned on the export width. A design
 * that maps onto itself is refused before any of this now, from its features, and these looks
 * are the second line, for whatever that measure does not see.
 *
 * A size stops being looked at as soon as it cannot pass, so artwork that fails costs fewer
 * looks than artwork that passes; a passing size costs all twenty.
 */
async function confirmSize(given: {
  recognises: (pixelsAcross: number) => View[] | Promise<View[]>;
  sizes: number[];
  analysisWidth: number;
  scanDistanceMm: number;
}): Promise<SizeOutcome> {
  const { recognises, sizes, analysisWidth, scanDistanceMm } = given;
  // Looks already taken, by the width they were taken at, so the size below reuses what its own
  // turn already paid for.
  const taken = new Map<number, View[]>();
  const look = async (pixels: number): Promise<View[]> => {
    let views = taken.get(pixels);
    if (views === undefined) {
      views = await recognises(pixels);
      taken.set(pixels, views);
    }
    return views;
  };
  // Five different pixel counts at every size: a level too narrow for that is refused on the way
  // in, where on a narrow image two of the five once rounded to one count and the same looks
  // were counted twice ("4 of 5 widths agreed" was three widths, two of them twice).
  const widthsAt = (scale: number): number[] =>
    WIDTHS_SHOWN.map((fraction) => Math.round(scale * analysisWidth * fraction));
  const widthOf = (scale: number): number => printWidthMm(scale * analysisWidth, scanDistanceMm);

  const outcome: SizeOutcome = {
    confirmed: null,
    recognition: null,
    widthMm: null,
    misplacedAt: null,
    tooWideMm: null,
    stoppedAtMm: null,
  };
  for (const [index, scale] of sizes.entries()) {
    const widthMm = widthOf(scale);
    // A width no manifest can declare is not one to confirm, and a larger size is only wider.
    if (widthMm > WIDEST_DECLARABLE_MM) {
      if (index === 0) outcome.tooWideMm = widthMm;
      else outcome.stoppedAtMm = widthMm;
      break;
    }

    const atWidths: View[][] = [];
    const widths = widthsAt(scale);
    for (const pixels of widths) {
      atWidths.push(await look(pixels));
      // Stopped once the size cannot pass: a look in the wrong place, or so many widths short of
      // the line that most cannot agree.
      const short = atWidths.filter((looks) => !agrees(looks)).length;
      if (atWidths.flat().some((view) => view.misplaced) || short * 2 > widths.length) break;
    }
    const seen = summarise(atWidths, widths.length, Math.round(scale * analysisWidth));
    if (seen.misplaced > 0 && outcome.misplacedAt === null) {
      outcome.misplacedAt = { widthMm, misplaced: seen.misplaced, views: seen.views };
    }
    let passes = seen.found;
    if (passes && index > 0) {
      const below: View[] = [];
      for (const pixels of widthsAt(sizes[index - 1] as number)) {
        below.push(...(await look(pixels)));
        if (below.some((view) => view.misplaced)) break;
      }
      const misplacedBelow = below.filter((view) => view.misplaced).length;
      if (misplacedBelow > 0) {
        passes = false;
        seen.found = false;
        seen.misplaced = misplacedBelow;
        if (outcome.misplacedAt === null) {
          outcome.misplacedAt = {
            widthMm: widthOf(sizes[index - 1] as number),
            misplaced: misplacedBelow,
            views: below.length,
          };
        }
      }
    }
    if (
      outcome.recognition === null ||
      passes ||
      seen.widthsAgreed > outcome.recognition.widthsAgreed ||
      (seen.widthsAgreed === outcome.recognition.widthsAgreed && seen.inliers > outcome.recognition.inliers)
    ) {
      outcome.recognition = seen;
      outcome.widthMm = widthMm;
    }
    if (passes) {
      outcome.confirmed = { scale, widthMm };
      break;
    }
  }
  return outcome;
}

/** The fewest points any turn at one width found, a look that found nothing counting none. */
function worstTurn(looks: View[]): number {
  return looks.length === 0 ? 0 : Math.min(...looks.map((view) => (view.found ? view.inliers : 0)));
}

/** Whether every turn at one width found the artwork with enough points agreeing. */
function agrees(looks: View[]): boolean {
  return worstTurn(looks) >= AGREEING_POINTS_NEEDED;
}

/** The looks at one size, counted the way the report states them. */
function summarise(atWidths: View[][], widthsShown: number, pixelsAcross: number): Recognition {
  const widthsAgreed = atWidths.filter(agrees).length;
  const misplaced = atWidths.flat().filter((view) => view.misplaced).length;
  // The worst turns, the widths not looked at counting as none: a size cut short is reported as
  // what it was seen to be, not as what the rest of its widths might have been.
  const worst = [...atWidths.map(worstTurn), ...new Array(widthsShown - atWidths.length).fill(0)].sort(
    (a, b) => a - b,
  );
  return {
    pixelsAcross,
    widths: widthsShown,
    widthsAgreed,
    views: atWidths.flat().length,
    misplaced,
    inliers: worst[Math.floor(worst.length / 2)] ?? 0,
    needed: AGREEING_POINTS_NEEDED,
    found: widthsShown > 0 && misplaced === 0 && widthsAgreed * 2 > widthsShown,
  };
}

/** Why nothing was confirmed, in the terms of what was seen. */
function refusal(outcome: SizeOutcome, scanDistanceMm: number): string {
  if (outcome.tooWideMm !== null) {
    return `it would have to be printed ${outcome.tooWideMm} mm wide to be read from ${scanDistanceMm} mm, which is wider than any piece this format can describe. Read it from closer.`;
  }
  const seen = outcome.recognition;
  if (seen === null || outcome.widthMm === null) {
    return `no size the target covers can be printed narrower than ${WIDEST_DECLARABLE_MM} mm at this distance, so the recogniser could not be asked`;
  }
  if (outcome.misplacedAt !== null) {
    // The count is of the looks taken before looking stopped, and looking stops at the first
    // look in the wrong place, so it is not a rate and is not put as one: "1 of 4 looks" read as
    // a quarter of them.
    const at = outcome.misplacedAt;
    return `the recogniser put it in the wrong place at ${at.widthMm} mm wide, read from ${scanDistanceMm} mm, in ${at.misplaced} of the ${at.views} looks taken at that size before it stopped looking. Content drawn by a pose like that lands somewhere other than the print. A design that repeats part of itself does this, settling on the wrong copy of the part: compile one copy, or change it so its parts differ`;
  }
  if (outcome.stoppedAtMm !== null) {
    // The sizes that fit were refused and the next one does not fit, which is the distance's
    // doing as much as the artwork's: it read "too little distinct detail" for a sheet whose
    // next size up was never asked about, and was ready for press from a millimetre closer.
    return `the recogniser did not confirm any size narrower than ${WIDEST_DECLARABLE_MM} mm at this distance: the closest was ${seen.widthsAgreed} of ${seen.widths} widths, printed ${outcome.widthMm} mm wide, and the next size up would have to be printed ${outcome.stoppedAtMm} mm wide to be read from ${scanDistanceMm} mm, which is wider than any piece this format can describe. Read it from closer, and that size can be asked about`;
  }
  return `the recogniser did not find it in every turn with ${AGREEING_POINTS_NEEDED} points agreeing at most of its widths, at any size the target covers. The closest was ${seen.widthsAgreed} of ${seen.widths} widths, printed ${outcome.widthMm} mm wide and read from ${scanDistanceMm} mm. Artwork with too little distinct detail does this`;
}

interface AimedAt {
  scale: number;
  end: { x: number; y: number };
  misplaced: number;
  views: number;
}

/**
 * The recogniser pointed at each end of a move, at each size from the smallest up, until a look
 * puts the artwork in the wrong place.
 *
 * The end on the larger copy is looked at the sizes the target covers. The end on the smaller copy
 * is looked at those sizes grown by the move's change of size: a smaller copy is taken for the
 * larger one when it appears as large as one of the sizes the target describes, which is the whole
 * artwork seen that much larger, a reader holding the phone closer to the small copy. Looked at
 * only the target's own sizes, the postcard beside a copy of itself at 60 per cent was found in the
 * right place at both ends every time.
 */
async function aimAt(given: {
  recognises: (pixelsAcross: number, aim?: { x: number; y: number }) => View[] | Promise<View[]>;
  ends: { from: { x: number; y: number }; to: { x: number; y: number } };
  /** The move's change of size, from where it takes its places to where it puts them. */
  scale: number;
  sizes: number[];
  analysisWidth: number;
}): Promise<{ sizes: number; views: number; misplaced: number; at: AimedAt | null }> {
  const growing = given.scale >= 1;
  const larger = growing ? given.ends.to : given.ends.from;
  const smaller = growing ? given.ends.from : given.ends.to;
  const grow = growing ? given.scale : 1 / given.scale;
  let views = 0;
  let sizes = 0;
  for (const scale of given.sizes) {
    sizes++;
    for (const [end, factor] of [
      [larger, 1],
      [smaller, grow],
    ] as const) {
      const shown = scale * factor;
      const looks = await given.recognises(Math.round(shown * given.analysisWidth), end);
      views += looks.length;
      const misplaced = looks.filter((view) => view.misplaced).length;
      if (misplaced > 0)
        return { sizes, views, misplaced, at: { scale: shown, end, misplaced, views: looks.length } };
    }
  }
  return { sizes, views, misplaced: 0, at: null };
}

/** Why a design the recogniser put in the wrong place when pointed at its copy is refused. */
function aimedRefusal(
  repetition: Repetition,
  at: AimedAt,
  scanDistanceMm: number,
  image: { width: number; height: number },
): string {
  const widthMm = printWidthMm(at.scale * image.width, scanDistanceMm);
  const across = Math.round((at.end.x / image.width) * 100);
  const down = Math.round((at.end.y / image.height) * 100);
  return `pointed at the part of the artwork ${across} per cent across and ${down} per cent down, at the size of a print ${widthMm} mm wide read from ${scanDistanceMm} mm, the recogniser put it in the wrong place in ${at.misplaced} of ${at.views} looks. One move of the whole artwork, ${describeMove(repetition.move)}, carries ${repetition.places} of its ${repetition.of} places onto look-alikes of themselves, and a camera pointed there settles on that move and draws the content on the wrong copy. A design with a second copy of itself at another size, or turned, does this: compile one copy, or change it so its copies differ`;
}

/** Why a design that maps onto itself is refused, naming the move that does it. */
function repeatsItself(repetition: Repetition): string {
  return `it maps onto itself: one move of the whole artwork, ${describeMove(repetition.move)}, carries ${repetition.places} of its ${repetition.of} places onto look-alikes of themselves. The recogniser can settle on that move and draw the content on the wrong copy. Compile one copy of the design, or change it so its parts differ`;
}

function describeMove(move: Repetition["move"]): string {
  if (move === null) return "one that leaves it somewhere else";
  const parts: string[] = [];
  const shift = Math.hypot(move.across, move.down);
  if (shift >= 0.05) {
    const upOrDown = Math.abs(move.down) >= 0.05 ? (move.down > 0 ? "down" : "up") : "";
    const sideways = Math.abs(move.across) >= 0.05 ? (move.across > 0 ? "right" : "left") : "";
    parts.push(
      `shifting it ${Math.round(shift * 100)} per cent of its width ${[upOrDown, sideways].filter(Boolean).join(" and ")}`,
    );
  }
  if (Math.abs(move.turnDegrees) >= 5)
    parts.push(`turning it ${Math.round(Math.abs(move.turnDegrees))} degrees`);
  if (Math.abs(move.scale - 1) >= 0.05) parts.push(`scaling it to ${Math.round(move.scale * 100)} per cent`);
  return parts.length > 0 ? parts.join(" and ") : "one that leaves it somewhere else";
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
  // Not "until the artwork passes": a distance too great for the widest declarable piece is
  // refused here too, and the artwork is not what has to change.
  if (report.minimumWidthMm === null) return "not printable until it passes";
  // The figure the recogniser was shown, the middle of its widths at that size. It printed one
  // number and checked another, 506 against 508, because the check took the width after the
  // distance's rounding and this line took it before.
  const pixels =
    report.recognition?.pixelsAcross ?? Math.round(report.smallestUsableScale * report.analysisWidth);
  return `${report.minimumWidthMm} mm to be read from ${report.scanDistanceMm} mm away, putting at least ${pixels} px across the artwork from left to right`;
}

/**
 * How far the design maps onto itself, against the lines that refuse it, in the words the command
 * line and the console both print.
 */
export function describeRepetition(report: Report): string {
  const measured = report.repetition;
  if (measured === null) return "not measured";
  const lines = `the lines are ${REPEATS_FROM.places} places and ${Math.round(REPEATS_FROM.share * 100)} per cent of them`;
  const aimed = measured.aimed ?? null;
  const pointed =
    aimed === null
      ? ""
      : aimed.misplaced === 0
        ? `; pointed at both ends of that move at every size the target covers, the recogniser put it in the right place in all ${aimed.views} looks`
        : `; pointed at the ends of that move, the recogniser put it in the wrong place in ${aimed.misplaced} of ${aimed.views} looks`;
  return `${repeats(measured) ? "yes" : "no"}: the most one move carries onto look-alikes is ${measured.places} of its ${measured.of} places, and ${lines}${pointed}`;
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

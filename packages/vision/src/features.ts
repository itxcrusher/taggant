import type { GrayscaleImage } from "./image.js";

export interface Corner {
  x: number;
  y: number;
  /**
   * Smaller eigenvalue of the local structure tensor: how strongly the image changes in
   * its weakest direction at this point. Comparable within one image, and roughly
   * comparable across images, since it scales with the square of the gradient rather than
   * its fourth power.
   */
  strength: number;
}

export interface DetectOptions {
  maxCorners?: number;
  /** Minimum pixels between two accepted corners, so features are spread out. */
  minDistance?: number;
  /**
   * Fraction of a high percentile of the responses below which a corner counts as
   * noise. A percentile rather than the maximum, so one very high contrast element cannot
   * raise the bar for the whole image.
   */
  qualityLevel?: number;
  /** Side of the square the budget is spread over, when the budget binds at all. */
  cellSize?: number;
}

/**
 * Below this a patch is flat to within the noise of a scan or a camera.
 *
 * The response is a sum of squared central differences over a three by three window, so
 * this is roughly a gradient of five grey levels in both directions: smaller than
 * anything a press can hold, and smaller than the noise in a phone camera frame.
 */
const MIN_RESPONSE = 200;

/**
 * Shi and Tomasi corner detection, selected locally.
 *
 * Two decisions here are about print rather than about corners.
 *
 * The measure is the smaller eigenvalue of the structure tensor rather than the Harris
 * response. Harris scales as the fourth power of the local gradient, so on a pack with a
 * barcode the barcode's response is thousands of times everything else, and any threshold
 * expressed as a fraction of the strongest response erases the rest of the artwork.
 *
 * The quality threshold is a fraction of a high percentile of the responses rather than of
 * the single strongest, for the same reason: one barcode cannot move a percentile the way
 * it moves a maximum, so the bar stays where the artwork puts it.
 *
 * Corners are then taken strongest first, which is stable: the same artwork photographed
 * from a slightly different position yields the same corners in the same order, and
 * matching depends on that. Only when there are more corners than the budget does
 * selection switch to taking the best from each cell in turn, because a strength ordered
 * walk with a budget spends it wherever the image is busiest, in raster order, and reports
 * the rest of the artwork as featureless.
 */
export function detectCorners(image: GrayscaleImage, options: DetectOptions = {}): Corner[] {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`image dimensions must be non-negative integers, got ${width} x ${height}`);
  }
  if (image.data.length < width * height) {
    throw new RangeError(
      `image data holds ${image.data.length} pixels, but ${width} x ${height} needs ${width * height}`,
    );
  }
  const maxCorners = positive(options.maxCorners ?? 500, "maxCorners");
  const minDistance = positive(options.minDistance ?? 8, "minDistance");
  const qualityLevel = fraction(options.qualityLevel ?? 0.02, "qualityLevel");
  const cellSize = positive(options.cellSize ?? 48, "cellSize");
  if (width < 3 || height < 3) return [];

  const response = respond(image);
  const candidates = localMaxima(response, width, height);
  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.strength - a.strength);
  const reference = candidates[Math.floor(candidates.length * 0.1)]?.strength ?? 0;
  const floor = Math.max(MIN_RESPONSE, reference * qualityLevel);

  // Spacing first, and in strength order, so the survivors are the same set however many
  // of them the budget will eventually allow.
  const spacing = new SpatialIndex(minDistance);
  const survivors: Corner[] = [];
  for (const candidate of candidates) {
    if (candidate.strength < floor) break;
    if (spacing.hasNeighbour(candidate.x, candidate.y)) continue;
    spacing.add(candidate.x, candidate.y);
    survivors.push(candidate);
  }

  const chosen = survivors.length <= maxCorners ? survivors : spread(survivors, width, cellSize, maxCorners);
  return chosen.map((corner) => refine(response, width, height, corner));
}

/**
 * Cut a set of corners down to a budget by taking the best from each part of the artwork
 * in turn, rather than the best overall.
 *
 * Taking the strongest overall looks right and is not: on artwork that is evenly textured
 * the strongest responses are ties, they are met in raster order, and the budget runs out
 * partway down the page. The report then says the features are concentrated in part of
 * the artwork, which is true of the tool's own budget and not of the artwork.
 */
function spread(corners: Corner[], width: number, cellSize: number, maxCorners: number): Corner[] {
  const columns = Math.max(1, Math.ceil(width / cellSize));
  const cells = new Map<number, Corner[]>();
  for (const corner of corners) {
    const key =
      Math.floor(corner.y / cellSize) * columns + Math.min(columns - 1, Math.floor(corner.x / cellSize));
    const cell = cells.get(key);
    if (cell) cell.push(corner);
    else cells.set(key, [corner]);
  }

  const chosen: Corner[] = [];
  const ranked = [...cells.values()];
  for (let rank = 0; chosen.length < maxCorners; rank++) {
    let placed = false;
    for (const cell of ranked) {
      const corner = cell[rank];
      if (!corner) continue;
      placed = true;
      chosen.push(corner);
      if (chosen.length >= maxCorners) break;
    }
    if (!placed) break;
  }
  chosen.sort((a, b) => b.strength - a.strength);
  return chosen;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
  }
  return value;
}

function fraction(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(`${name} must be at least 0 and below 1, got ${value}`);
  }
  return value;
}

/**
 * The smaller eigenvalue of the structure tensor at every pixel.
 *
 * Samples are clamped at the border rather than skipped, so a corner sitting on the trim
 * edge is measured over the same nine samples as one in the middle. Print artwork runs
 * detail to the trim edge all the time, and a corner scored lower for being there loses
 * to the middle of the page for no reason to do with the artwork.
 */
function respond(image: GrayscaleImage): Float32Array {
  const { width, height, data } = image;
  const response = new Float32Array(width * height);
  const at = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return data[cy * width + cx] ?? 0;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let wy = -1; wy <= 1; wy++) {
        for (let wx = -1; wx <= 1; wx++) {
          const px = x + wx;
          const py = y + wy;
          const gx = at(px + 1, py) - at(px - 1, py);
          const gy = at(px, py + 1) - at(px, py - 1);
          sxx += gx * gx;
          syy += gy * gy;
          sxy += gx * gy;
        }
      }
      const trace = sxx + syy;
      const gap = Math.sqrt(Math.max(0, (sxx - syy) * (sxx - syy) + 4 * sxy * sxy));
      response[y * width + x] = (trace - gap) / 2;
    }
  }
  return response;
}

/** Pixels that are the peak of their own three by three neighbourhood, and not flat. */
function localMaxima(response: Float32Array, width: number, height: number): Corner[] {
  const peaks: Corner[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const r = response[y * width + x] ?? 0;
      if (r < MIN_RESPONSE) continue;
      let peak = true;
      for (let wy = -1; wy <= 1 && peak; wy++) {
        for (let wx = -1; wx <= 1; wx++) {
          if (wx === 0 && wy === 0) continue;
          if ((response[(y + wy) * width + (x + wx)] ?? 0) > r) {
            peak = false;
            break;
          }
        }
      }
      if (peak) peaks.push({ x, y, strength: r });
    }
  }
  return peaks;
}

/** Buckets by spacing, so the spread check costs the same whatever has been accepted. */
class SpatialIndex {
  private readonly buckets = new Map<string, Array<[number, number]>>();
  private readonly minDistanceSquared: number;

  constructor(private readonly spacing: number) {
    this.minDistanceSquared = spacing * spacing;
  }

  hasNeighbour(x: number, y: number): boolean {
    const bx = Math.floor(x / this.spacing);
    const by = Math.floor(y / this.spacing);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.buckets.get(`${bx + dx},${by + dy}`);
        if (!bucket) continue;
        for (const [px, py] of bucket) {
          const ex = px - x;
          const ey = py - y;
          if (ex * ex + ey * ey < this.minDistanceSquared) return true;
        }
      }
    }
    return false;
  }

  add(x: number, y: number): void {
    const key = `${Math.floor(x / this.spacing)},${Math.floor(y / this.spacing)}`;
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push([x, y]);
    else this.buckets.set(key, [[x, y]]);
  }
}

/**
 * Move a corner to the peak of the response surface rather than the middle of the pixel
 * that happened to win.
 *
 * Whole pixel positions are the wrong unit here. The same physical corner seen from a
 * slightly different angle lands up to a pixel away, and a pose fitted from positions
 * that are each a pixel out is a pose that visibly floats.
 */
function refine(response: Float32Array, width: number, height: number, corner: Corner): Corner {
  const { x, y } = corner;
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return corner;
  const at = (px: number, py: number) => response[py * width + px] ?? 0;
  const centre = at(x, y);

  const left = at(x - 1, y);
  const right = at(x + 1, y);
  const horizontal = left - 2 * centre + right;
  const dx = Math.abs(horizontal) < 1e-12 ? 0 : (0.5 * (left - right)) / horizontal;

  const up = at(x, y - 1);
  const down = at(x, y + 1);
  const vertical = up - 2 * centre + down;
  const dy = Math.abs(vertical) < 1e-12 ? 0 : (0.5 * (up - down)) / vertical;

  // A shift of more than one pixel means the peak is not where the sampling says it is,
  // so the fit is not to be trusted and the whole pixel position stands.
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return corner;
  return { x: x + dx, y: y + dy, strength: corner.strength };
}

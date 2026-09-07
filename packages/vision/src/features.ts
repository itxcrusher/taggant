import type { GrayscaleImage } from "./image.js";

export interface Corner {
  x: number;
  y: number;
  /** Harris response. Comparable within one image, not across images. */
  strength: number;
}

export interface DetectOptions {
  maxCorners?: number;
  /** Minimum pixels between two accepted corners, so features are spread out. */
  minDistance?: number;
  /** Fraction of the strongest response below which a corner counts as noise. */
  qualityLevel?: number;
}

/**
 * Harris corner detection, with weaker corners suppressed by spacing rather than by a
 * fixed grid.
 *
 * Corners are what a tracker actually locks onto, so they are also what the print
 * readiness report is built from.
 */
export function detectCorners(image: GrayscaleImage, options: DetectOptions = {}): Corner[] {
  const maxCorners = options.maxCorners ?? 500;
  const minDistance = options.minDistance ?? 8;
  const qualityLevel = options.qualityLevel ?? 0.02;
  const { width, height, data } = image;
  const k = 0.04;
  const response = new Float32Array(width * height);
  let strongest = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let wy = -1; wy <= 1; wy++) {
        for (let wx = -1; wx <= 1; wx++) {
          const px = x + wx;
          const py = y + wy;
          if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) continue;
          const i = py * width + px;
          const gx = (data[i + 1] ?? 0) - (data[i - 1] ?? 0);
          const gy = (data[i + width] ?? 0) - (data[i - width] ?? 0);
          sxx += gx * gx;
          syy += gy * gy;
          sxy += gx * gy;
        }
      }
      const det = sxx * syy - sxy * sxy;
      const trace = sxx + syy;
      const r = det - k * trace * trace;
      response[y * width + x] = r;
      if (r > strongest) strongest = r;
    }
  }

  if (strongest <= 0) return [];
  const threshold = strongest * qualityLevel;

  const candidates: Corner[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const r = response[y * width + x] ?? 0;
      if (r >= threshold) candidates.push({ x, y, strength: r });
    }
  }
  candidates.sort((a, b) => b.strength - a.strength);

  const accepted: Corner[] = [];
  const minDistanceSquared = minDistance * minDistance;
  for (const candidate of candidates) {
    if (accepted.length >= maxCorners) break;
    let tooClose = false;
    for (const kept of accepted) {
      const dx = kept.x - candidate.x;
      const dy = kept.y - candidate.y;
      if (dx * dx + dy * dy < minDistanceSquared) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) accepted.push(refine(response, width, height, candidate));
  }
  return accepted;
}

/**
 * Move a corner to the peak of the response surface rather than the middle of the pixel
 * that happened to win.
 *
 * Whole pixel positions are the wrong unit here. The same physical corner seen from a
 * slightly different angle lands up to a pixel away, and a pose fitted from positions
 * that are each a pixel out is a pose that visibly floats. A parabola through the
 * response either side of the peak costs almost nothing and removes most of that error.
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

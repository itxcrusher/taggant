/** Single channel, 8 bit, row major. The one image shape every stage of the system agrees on. */
export interface GrayscaleImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Bilinear sample, clamped at the edges.
 *
 * Descriptors are read at rotated, fractional positions, so nearest neighbour sampling
 * would make the same corner describe differently depending on the angle it was seen at,
 * which is the one thing a descriptor must not do.
 */
export function sample(image: GrayscaleImage, x: number, y: number): number {
  const { width, height, data } = image;
  if (width < 1 || height < 1) return 0;
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const p00 = data[y0 * width + x0] ?? 0;
  const p10 = data[y0 * width + x1] ?? 0;
  const p01 = data[y1 * width + x0] ?? 0;
  const p11 = data[y1 * width + x1] ?? 0;
  return p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
}

/**
 * One pass of a separable binomial blur.
 *
 * Applied to every image before its features are measured, on both sides of the system.
 * A camera frame is always softer than the file that was printed, and a descriptor taken
 * from a sharp original does not match one taken from a soft photograph of it. Smoothing
 * both brings them to comparable ground, and it is also what keeps derivatives from being
 * dominated by single pixel noise.
 */
export function smooth(image: GrayscaleImage): GrayscaleImage {
  const { width, height, data } = image;
  if (width < 3 || height < 3) return image;
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = data[row + Math.max(0, x - 1)] ?? 0;
      const right = data[row + Math.min(width - 1, x + 1)] ?? 0;
      horizontal[row + x] = ((data[row + x] ?? 0) * 2 + left + right) >> 2;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      out[row + x] =
        ((horizontal[row + x] ?? 0) * 2 + (horizontal[up + x] ?? 0) + (horizontal[down + x] ?? 0)) >> 2;
    }
  }
  return { width, height, data: out };
}

/**
 * Resample an image to a fraction of its size, low passing first.
 *
 * Used to build a target at several scales, so a print photographed from further away
 * than it was compiled at still has a level it can match against. Decimating without
 * blurring first turns fine detail into aliasing, which produces corners that exist in
 * the level and not in the artwork.
 */
export function resample(image: GrayscaleImage, scale: number): GrayscaleImage {
  if (!(scale > 0)) throw new RangeError(`scale must be a positive number, got ${scale}`);
  if (scale === 1) return image;
  let source = image;
  for (let pass = 0; pass < Math.round(1 / scale) - 1; pass++) source = smooth(source);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = Math.round(sample(source, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5));
    }
  }
  return { width, height, data };
}

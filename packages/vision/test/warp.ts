import { type Homography, applyHomography } from "../src/homography.js";
import { type GrayscaleImage, sample } from "../src/image.js";

/** Invert a three by three, so an output pixel can be traced back to where it came from. */
export function invert(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, i, j] = [
    h[0] ?? 0,
    h[1] ?? 0,
    h[2] ?? 0,
    h[3] ?? 0,
    h[4] ?? 0,
    h[5] ?? 0,
    h[6] ?? 0,
    h[7] ?? 0,
    h[8] ?? 0,
  ];
  const determinant = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(determinant) < 1e-14) return null;
  const inverse = Float64Array.from([
    e * j - f * i,
    c * i - b * j,
    b * f - c * e,
    f * g - d * j,
    a * j - c * g,
    c * d - a * f,
    d * i - e * g,
    b * g - a * i,
    a * e - b * d,
  ]);
  for (let k = 0; k < 9; k++) inverse[k] = (inverse[k] ?? 0) / determinant;
  return inverse;
}

/**
 * Render a view of an image as seen through a known homography, filling the background
 * with a flat value.
 *
 * Every output pixel is traced back through the inverse and sampled, which is what makes
 * the mapping exact: the test knows precisely where the artwork ended up, so a recovered
 * pose can be measured against the truth rather than eyeballed.
 */
export function warp(
  source: GrayscaleImage,
  h: Homography,
  width: number,
  height: number,
  background = 128,
): GrayscaleImage {
  const inverse = invert(h);
  const data = new Uint8Array(width * height).fill(background);
  if (!inverse) return { width, height, data };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [sx, sy] = applyHomography(inverse, x + 0.5, y + 0.5);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      data[y * width + x] = Math.round(sample(source, sx, sy));
    }
  }
  return { width, height, data };
}

/** Compose a mapping from the usual parts, in the order a print is actually held. */
export function transform(options: {
  scale?: number;
  rotationDeg?: number;
  translateX?: number;
  translateY?: number;
  perspectiveX?: number;
  perspectiveY?: number;
}): Homography {
  const scale = options.scale ?? 1;
  const angle = ((options.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle) * scale;
  const sin = Math.sin(angle) * scale;
  return Float64Array.from([
    cos,
    -sin,
    options.translateX ?? 0,
    sin,
    cos,
    options.translateY ?? 0,
    options.perspectiveX ?? 0,
    options.perspectiveY ?? 0,
    1,
  ]);
}

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
      // Map the centre of the output pixel, then step back to index space, which is what
      // sample takes. Without that half pixel the identity mapping blurs the image, and
      // every test built on it is harder than the camera it stands in for.
      const [sx, sy] = applyHomography(inverse, x + 0.5, y + 0.5);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      data[y * width + x] = Math.round(sample(source, sx - 0.5, sy - 0.5));
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

/**
 * A three by three blur, standing in for a camera that is not perfectly in focus.
 *
 * Every frame from a phone held at arm's length is softer than the file that was printed,
 * so a tracker tested only on sharp views is tested on a case that does not occur.
 */
export function blur(image: GrayscaleImage): GrayscaleImage {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  const at = (x: number, y: number) =>
    data[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))] ?? 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += at(x + dx, y + dy);
      out[y * width + x] = Math.round(sum / 9);
    }
  }
  return { width, height, data: out };
}

import sharp from "sharp";

export interface GrayscaleImage {
  width: number;
  height: number;
  /** One byte per pixel, row major. */
  data: Uint8Array;
}

export interface LoadOptions {
  /** Longest edge in pixels after downscaling. Larger costs time and buys nothing. */
  maxEdge?: number;
  /** Shortest edge the compiler will accept. Below this there is nothing to track. */
  minEdge?: number;
}

/**
 * Read artwork in any format sharp supports and return single-channel pixels.
 *
 * Print files arrive as TIFF and as rasters derived from PDF, so decoding happens here
 * rather than anywhere near a browser.
 */
export async function loadGrayscale(input: Buffer, options: LoadOptions = {}): Promise<GrayscaleImage> {
  const maxEdge = options.maxEdge ?? 1200;
  const minEdge = options.minEdge ?? 256;

  const meta = await sharp(input).metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;
  const shortestEdge = Math.min(sourceWidth, sourceHeight);
  if (shortestEdge < minEdge) {
    throw new Error(`artwork must be at least ${minEdge} px on its shortest edge, got ${shortestEdge}`);
  }

  const pipeline = sharp(input).grayscale();
  if (Math.max(sourceWidth, sourceHeight) > maxEdge) {
    pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

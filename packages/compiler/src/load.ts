import type { GrayscaleImage } from "@taggant/vision";
import sharp from "sharp";

export interface LoadOptions {
  /** Longest edge in pixels after downscaling. Larger costs time and buys nothing. */
  maxEdge?: number;
  /** Shortest edge the compiler will accept. Below this there is nothing to track. */
  minEdge?: number;
  /**
   * Substrate the artwork is composited onto, as any colour sharp understands.
   *
   * Print files carry transparency, and what a press puts down is the artwork over the
   * stock, not the artwork over whatever happens to sit under the alpha channel.
   */
  substrate?: string;
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
  const substrate = options.substrate ?? "#ffffff";

  // rotate() with no angle applies the file's EXIF orientation, so every measurement
  // below is of the artwork as it will be seen. A file carrying an orientation tag is
  // shown turned by every viewer and every RIP, and a target compiled in the unrotated
  // raster is a quarter turn away from the print.
  const pipeline = sharp(input).rotate();
  const meta = await sharp(input).metadata();
  // Orientations five to eight put the image on its side, so the displayed size is the
  // stored size transposed.
  const turned = (meta.orientation ?? 1) >= 5;
  const sourceWidth = (turned ? meta.height : meta.width) ?? 0;
  const sourceHeight = (turned ? meta.width : meta.height) ?? 0;
  if (sourceWidth < 1 || sourceHeight < 1) throw new Error("artwork has no readable dimensions");

  const longestEdge = Math.max(sourceWidth, sourceHeight);
  const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1;
  // Checked against the size the analysis will actually run at, not the size that arrived.
  // A 4000 by 300 strip clears a 256 px gate and is then analysed at 1200 by 90.
  const shortestEdge = Math.floor(Math.min(sourceWidth, sourceHeight) * scale);
  if (shortestEdge < minEdge) {
    throw new Error(
      `artwork must be at least ${minEdge} px on its shortest edge once scaled for analysis, and this is ${shortestEdge} px`,
    );
  }

  // Composited onto the stock before anything is measured. Without this a fully
  // transparent file is graded on the colour hiding under its alpha channel, and art on a
  // transparent background gains edges at its boundary that will never reach paper.
  pipeline.flatten({ background: substrate }).grayscale();
  if (scale < 1) {
    pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

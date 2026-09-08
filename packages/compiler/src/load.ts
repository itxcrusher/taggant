import type { GrayscaleImage } from "@taggant/vision";
import sharp from "sharp";

export interface LoadOptions {
  /**
   * Longest edge, in pixels, that every piece of artwork is analysed at.
   *
   * Fixed rather than a ceiling, and this matters more than it looks. Everything the
   * compiler measures is in analysis pixels, so if this followed the file then the same
   * design exported at two sizes would produce two different targets and two different
   * minimum print widths. It did, and the swing was three to one, which rewarded exporting
   * small: send a smaller file, be told you may print smaller, and get a worse target for
   * it. A design is a design whatever the export dialogue was set to.
   *
   * The value is set by what a camera can deliver, not by what a file might hold. The
   * runtime recognises against a frame reduced to 480 px wide, and the smallest size in a
   * target is half its analysis raster, so analysing at much more than this describes
   * detail no runtime will ever be given. Analysing at 1024 made the smallest level 512 px
   * and nothing matched at all.
   */
  workingEdge?: number;
  /** Shortest edge the compiler will accept in the file itself. Below this there is nothing to track. */
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
  const workingEdge = options.workingEdge ?? 640;
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

  // Two gates, and both are needed. The first is on the file, because that is where the
  // detail either exists or does not, and scaling a small file up to the working size does
  // not put any into it.
  const shortestEdge = Math.min(sourceWidth, sourceHeight);
  if (shortestEdge < minEdge) {
    throw new Error(
      `artwork must be at least ${minEdge} px on its shortest edge, and this is ${shortestEdge} px`,
    );
  }

  // The second is on the size it will be analysed at, which for a long thin piece is not
  // the same thing. A 4000 by 300 strip clears the first gate and would be analysed 77 px
  // tall, describing a printed mark a few millimetres high.
  const analysedShortEdge = Math.round(
    (Math.min(sourceWidth, sourceHeight) * workingEdge) / Math.max(sourceWidth, sourceHeight),
  );
  if (analysedShortEdge < minEdge) {
    throw new Error(
      `artwork this long and thin cannot be analysed usefully: at a working size of ${workingEdge} px it is ${analysedShortEdge} px on its shortest edge, and ${minEdge} is the minimum`,
    );
  }

  // Composited onto the stock before anything is measured. Without this a fully
  // transparent file is graded on the colour hiding under its alpha channel, and art on a
  // transparent background gains edges at its boundary that will never reach paper.
  pipeline.flatten({ background: substrate }).grayscale();
  // Up as well as down, so the analysis raster is the same for every piece of artwork.
  pipeline.resize({ width: workingEdge, height: workingEdge, fit: "inside", withoutEnlargement: false });

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

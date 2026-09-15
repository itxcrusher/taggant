/**
 * One SVG to one PNG, in a process of its own.
 *
 * The renderer is a native library reading a document somebody else wrote, and two things
 * follow that no care in this repository changes. A filter can hold it for as long as the
 * document likes: a dilate of radius 500 units ran for four and a half minutes before the
 * library's own timeout, which is checked between steps rather than inside one, noticed at
 * three percent. And a document can crash it: a convolution matrix of order thirty took the
 * process down with an illegal instruction. In the process that publishes, the first is a
 * console that never answers and the second is a console that is gone. So the bundler
 * renders here instead, and holds a clock and a kill over this process from the other side.
 *
 * Bytes in on stdin. On success, the PNG on stdout and exit 0. On a declared size past the
 * ceiling, the size on stderr and exit 2. On any other failure, the renderer's first line on
 * stderr and exit 1. The arguments are the edge to render at and the ceiling on declared size.
 */
import sharp from "sharp";

async function main(): Promise<void> {
  const [edge = 2048, ceiling = 72 * 2048] = process.argv.slice(2).map(Number);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);

  try {
    // The document's own size is read first so that the render can be asked for at the
    // size it ships at, rather than at whatever the document declares: a poster drawn in
    // tenths of a millimetre renders at the same edge as a label drawn in tens of units.
    // Reading the size parses the file and allocates no pixels.
    const { width = 0, height = 0 } = await sharp(bytes, { limitInputPixels: false }).metadata();
    const longest = Math.max(width, height);
    if (longest > ceiling) {
      process.stderr.write(`${width} by ${height} units\n`);
      process.exit(2);
    }
    const density = Math.min(100_000, Math.max(1, (72 * edge) / longest));
    const png = await sharp(bytes, { density })
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    process.stdout.write(png);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}\n`,
    );
    process.exit(1);
  }
}

void main();

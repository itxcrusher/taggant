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
 * Bytes in on stdin. On success, the PNG on stdout and exit 0. Otherwise one line on stderr
 * saying why, and an exit code saying what kind of why: 1 is the renderer's own failure, 2 a
 * declared size past the ceiling, 3 a document that declares no size, 4 one that declares a
 * size of zero. The arguments are the edge to render at and the ceiling on declared size.
 */
import sharp from "sharp";

/**
 * Pixels per inch, for a length written in millimetres, points or inches.
 *
 * A browser converts a physical unit at 96, and so must this, or a document sized in
 * millimetres with no viewBox lands differently here than on a phone: at the renderer's
 * default of 72 a drawing 300 units wide in a 120 mm box filled 88% of it, where a browser
 * shows 66%. With a viewBox the unit does not matter, which is why the example never
 * showed it.
 */
const DPI = 96;

/**
 * What the root element says about its size, read before the renderer is asked.
 *
 * A document with no viewBox and no width and height has no size, and the renderer does
 * not refuse it: it lays the drawing out at one unit to a pixel inside a canvas sized for
 * the edge, and ships a raster that is 98% transparent with the drawing in one corner. A
 * document with a size of zero it reports as a corrupt header. Both are read off the root
 * tag here and refused by name. Nothing else in the document is looked at, and nothing
 * here decides what is safe; it decides only whether there is a size to render at.
 */
function declaredSize(bytes: Buffer): "sized" | "none" | "zero" | "unknown" {
  const head = bytes.subarray(0, 1024 * 1024).toString("utf8");
  const root = head.match(/<(?:[\w.-]+:)?svg((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/);
  if (root === null) return "unknown";
  const attributes = root[1] ?? "";
  const value = (name: string): string | null => {
    const found = attributes.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
    return found === null ? null : (found[1] ?? found[2] ?? "").trim();
  };
  const viewBox = value("viewBox");
  if (viewBox !== null) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return "unknown";
    return (parts[2] ?? 0) > 0 && (parts[3] ?? 0) > 0 ? "sized" : "zero";
  }
  const width = value("width");
  const height = value("height");
  if (width === null || height === null || width.endsWith("%") || height.endsWith("%")) return "none";
  const across = Number.parseFloat(width);
  const down = Number.parseFloat(height);
  if (Number.isNaN(across) || Number.isNaN(down)) return "unknown";
  return across > 0 && down > 0 ? "sized" : "zero";
}

/**
 * The reason on stderr and the code on the way out. `process.exitCode` rather than
 * `process.exit()`, because stderr on a Windows pipe is asynchronous and an exit call can
 * cut the reason off before the parent has read it.
 */
function fail(code: number, reason: string): void {
  process.stderr.write(`${reason}\n`);
  process.exitCode = code;
}

async function main(): Promise<void> {
  const [edge = 2048, ceiling = DPI * 2048] = process.argv.slice(2).map(Number);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);

  const size = declaredSize(bytes);
  if (size === "none") return fail(3, "no size declared");
  if (size === "zero") return fail(4, "a size of zero");

  try {
    // The document's own size is read first so that the render can be asked for at the
    // size it ships at, rather than at whatever the document declares: a poster drawn in
    // tenths of a millimetre renders at the same edge as a label drawn in tens of units.
    // Reading the size parses the file and allocates no pixels.
    const { width = 0, height = 0 } = await sharp(bytes, {
      density: DPI,
      limitInputPixels: false,
    }).metadata();
    const longest = Math.max(width, height);
    if (longest > ceiling) return fail(2, `${width} by ${height} px`);
    const density = Math.min(100_000, Math.max(1, (DPI * edge) / longest));
    const png = await sharp(bytes, { density })
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    process.stdout.write(png);
  } catch (error) {
    fail(1, error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
  }
}

void main();

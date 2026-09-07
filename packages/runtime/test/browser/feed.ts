import { writeFile } from "node:fs/promises";

export interface Frame {
  width: number;
  height: number;
  /** One byte per pixel, row major. */
  data: Uint8Array;
}

/**
 * Write a grayscale frame as a Y4M file Chromium will play as a camera.
 *
 * Launched with the fake capture flags, Chromium reads this file and hands it to
 * getUserMedia as a real device, which is what makes the whole path testable without a
 * phone: permission prompt, video element, canvas read, recognition, transform.
 *
 * Y4M is a header, then one FRAME marker and one planar 4:2:0 image per frame. The colour
 * planes are flat, because the tracker works on brightness and nothing else does.
 */
export async function writeFeed(path: string, frame: Frame, frames = 60): Promise<void> {
  const { width, height, data } = frame;
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError(`4:2:0 needs even dimensions, got ${width} x ${height}`);
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  const luma = Buffer.from(data);
  const marker = Buffer.from("FRAME\n", "ascii");
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420mpeg2\n`, "ascii");

  const parts: Buffer[] = [header];
  for (let i = 0; i < frames; i++) parts.push(marker, luma, chroma, chroma);
  await writeFile(path, Buffer.concat(parts));
}

/**
 * Irregular artwork, matching what the rest of the suite tracks against: directional at
 * every corner, and nothing like a checkerboard.
 */
export function artwork(width: number, height: number): Frame {
  const data = new Uint8Array(width * height).fill(210);
  let seed = 20260907;
  for (let i = 0; i < 220; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cx = seed % width;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const cy = seed % height;
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    const r = 5 + (seed % 14);
    const value = seed % 3 === 0 ? 25 : seed % 3 === 1 ? 90 : 160;
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= cx - r / 2) data[y * width + x] = value;
      }
    }
  }
  return { width, height, data };
}

/** Place the artwork inside a larger frame, as a camera pointed at a print would see it. */
export function inView(art: Frame, width: number, height: number, ox: number, oy: number): Frame {
  const data = new Uint8Array(width * height).fill(140);
  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const ty = y + oy;
      const tx = x + ox;
      if (ty < 0 || tx < 0 || ty >= height || tx >= width) continue;
      data[ty * width + tx] = art.data[y * art.width + x] ?? 0;
    }
  }
  return { width, height, data };
}

export interface Frame {
  width: number;
  height: number;
  /** One byte per pixel, row major. */
  data: Uint8Array;
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

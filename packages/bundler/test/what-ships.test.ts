import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LARGEST_DECLARED_EDGE, LARGEST_SVG_BYTES, RASTER_EDGE, prepareAsset } from "../src/assets.js";

/**
 * What the bundler decides about a file from its bytes, and what it says when it refuses.
 *
 * Every case here came from the adversarial pass over the rendering design
 * (`ADVERSARIAL_REVIEW_2026-09-15-raster.md`), and each is a thing an ordinary handed-over
 * asset does rather than something an attacker made: a phone's video, a licence comment
 * before the root element, an embedded photograph, a drawing sized in millimetres. The
 * refusals matter as much as the acceptances, because a refusal is what an author reads,
 * and three of these used to say something false about the file.
 *
 * `prepareAsset` rather than a whole publish: what is under test is the decision and the
 * render, both of which this drives for real, including the child process. A publish costs
 * a manifest, a compiled target and a copy of the runtime, and this file makes 25 of these.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG = (inner: string, attrs = 'viewBox="0 0 400 100"') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`);

/** An ISO base media file: a `ftyp` box carrying one brand, and nothing else. */
const isoMedia = (brand: string) =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x14]),
    Buffer.from("ftyp"),
    Buffer.from(brand, "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from(brand, "latin1"),
  ]);

describe("a file that says it is one thing and is another", () => {
  // Every brand that was not AVIF used to be called mp4, so a phone's .mov shipped at a
  // .mp4 address that no browser could decode, silently, and the guard test agreed with
  // the mistake because its own sniffer made it too. The console takes uploads and an
  // iPhone produces .mov, so this is reachable without anybody meaning harm.
  const brands: Array<[string, string, RegExp]> = [
    ["a QuickTime movie", "qt  ", /QuickTime/],
    ["a HEIF still", "heic", /HEIF/],
    ["another HEIF brand", "mif1", /HEIF/],
    ["a 3GPP file", "3gp4", /3GPP/],
    ["a brand nothing here knows", "zzzz", /brand \(zzzz\) this bundler does not know/],
  ];
  for (const [what, brand, says] of brands) {
    it(`refuses ${what} rather than renaming it .mp4`, async () => {
      await expect(prepareAsset("clip.mp4", isoMedia(brand))).rejects.toThrow(says);
    });
  }

  it("takes the MP4 and M4A brands a browser plays", async () => {
    expect((await prepareAsset("clip.mp4", isoMedia("isom"))).extension).toBe(".mp4");
    expect((await prepareAsset("clip.mp4", isoMedia("mp42"))).extension).toBe(".mp4");
    expect((await prepareAsset("tune.m4a", isoMedia("M4A "))).extension).toBe(".m4a");
    expect((await prepareAsset("still.avif", isoMedia("avif"))).extension).toBe(".avif");
  });

  it("says a gzipped SVG is compressed, rather than listing formats it is not", async () => {
    // .svgz is an SVG, and the old message sent the author looking for the wrong problem.
    const svgz = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from("anything")]);
    await expect(prepareAsset("overlay.svgz", svgz)).rejects.toThrow(/compressed with gzip/);
  });
});

describe("where the root element sits in the file", () => {
  it("finds it behind a licence comment longer than a page", async () => {
    // Icon sets and build pipelines prepend a licence comment, and the decision used to be
    // made on the first 4096 bytes only, so past that boundary a real SVG was called a
    // document and the author was told to export it as an SVG.
    const prologue = `<!--${"licence ".repeat(1000)}-->`;
    expect(prologue.length).toBeGreaterThan(4096);
    const { extension } = await prepareAsset("overlay.svg", Buffer.concat([Buffer.from(prologue), SVG("")]));
    expect(extension).toBe(".png");
  }, 60_000);

  it("finds it behind a DOCTYPE carrying an entity set", async () => {
    // The documented SVG 1.1 way of writing themed colours, and it runs past 4 KB easily.
    const entities = Array.from({ length: 200 }, (_, index) => `<!ENTITY colour${index} "#c33333">`).join("");
    const doctype = `<!DOCTYPE svg [${entities}]>`;
    expect(doctype.length).toBeGreaterThan(4096);
    const { extension } = await prepareAsset("overlay.svg", Buffer.concat([Buffer.from(doctype), SVG("")]));
    expect(extension).toBe(".png");
  }, 60_000);

  it("still calls an HTML document a document when it holds an svg element", async () => {
    // Whichever root comes first decides, or a wider window would be a way in rather than
    // a fix: a page with an inline drawing in it is a page.
    const page = Buffer.from(
      `<!DOCTYPE html><html><body>${"<p>text</p>".repeat(500)}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/><script>document.title="RAN"</script></body></html>`,
    );
    await expect(prepareAsset("page.html", page)).rejects.toThrow(/a document rather than a picture/);
  });
});

describe("what an SVG says about its own size", () => {
  it("refuses one that declares none, rather than shipping a blank raster", async () => {
    // It used to publish: the drawing laid out at one unit to a pixel in the corner of a
    // canvas sized for 2048, which is 98% transparent. The refusal existed but only fired
    // for an empty document, which is the one case whose bounding box is zero.
    await expect(
      prepareAsset("overlay.svg", SVG('<rect width="100" height="60" fill="#c33"/>', "")),
    ).rejects.toThrow(/declares no size/);
  });

  it("refuses one whose declared size is zero, and does not tell it to add what it has", async () => {
    await expect(prepareAsset("overlay.svg", SVG("", 'viewBox="0 0 0 0"'))).rejects.toThrow(
      /declares a size of zero/,
    );
    await expect(prepareAsset("overlay.svg", SVG("", 'width="0" height="0"'))).rejects.toThrow(
      /declares a size of zero/,
    );
  });

  it("refuses one declared larger than the renderer can be asked for, in pixels", async () => {
    const huge = SVG('<rect width="10" height="10"/>', 'viewBox="0 0 300000 100"');
    await expect(prepareAsset("overlay.svg", huge)).rejects.toThrow(
      new RegExp(`too large to render.*${LARGEST_DECLARED_EDGE} px`, "s"),
    );
  }, 60_000);

  it("names the XML parser's own limit when entities expand past it", async () => {
    // The parser reports its ceilings as a corrupt header, and the file is not corrupt.
    // A single run of text past ten million characters was one way to reach one of them,
    // which the size limit below now catches first; nested entities are the other, and a
    // few hundred bytes of them reach it, so that path stays open and is named here.
    const nested = [
      '<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">',
      '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">',
      '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">',
      '<!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">',
      '<!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;">',
      '<!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">',
    ].join("");
    const bomb = Buffer.concat([
      Buffer.from(`<!DOCTYPE svg [${nested}]>`),
      SVG('<text x="10" y="50">&f;</text>'),
    ]);
    expect(bomb.length).toBeLessThan(1024);
    await expect(prepareAsset("overlay.svg", bomb)).rejects.toThrow(/XML parser/);
  }, 60_000);

  it("refuses more SVG than a drawing ever is, and says where a photograph belongs", async () => {
    // Every other asset passes through, so a publish holds roughly the file. An SVG is
    // parsed, which is the one place a small input buys a lot of work, and the read and the
    // pipe together cost about three times the file. Eight megabytes of text is not a
    // drawing; it is an embedded photograph, which belongs in the bundle as its own asset.
    const bulk = SVG(`<!--${"x".repeat(LARGEST_SVG_BYTES)}--><rect width="400" height="100" fill="#c33"/>`);
    expect(bulk.length).toBeGreaterThan(LARGEST_SVG_BYTES);
    await expect(prepareAsset("overlay.svg", bulk)).rejects.toThrow(/the most this bundler will parse/);
  }, 60_000);

  /** Where the drawing lands in the raster: the box of pixels that are not transparent. */
  async function drawnBox(
    bytes: Buffer,
  ): Promise<{ width: number; height: number; right: number; bottom: number }> {
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if ((data[(y * info.width + x) * info.channels + 3] ?? 255) > 32) {
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
    return { width: info.width, height: info.height, right, bottom };
  }

  it("fills the raster whether its size is in user units or in millimetres", async () => {
    // A drawing 453.54 units across in a box declared 120 mm wide is the same drawing
    // either way: 120 mm is 453.54 px at the 96 to the inch a browser converts at. The
    // renderer's own default is 72, which laid this out at 88% of the raster with the rest
    // transparent, so a published overlay was 12% small and offset, and nothing said so.
    const drawing = '<rect width="453.54" height="90.71" fill="#c33"/>';
    const inMillimetres = await prepareAsset("mm.svg", SVG(drawing, 'width="120mm" height="24mm"'));
    const inUnits = await prepareAsset("px.svg", SVG(drawing, 'viewBox="0 0 453.54 90.71"'));
    expect(inMillimetres.bytes.subarray(0, 8)).toEqual(PNG);

    const mm = await drawnBox(inMillimetres.bytes);
    const px = await drawnBox(inUnits.bytes);
    expect(mm.width).toBe(RASTER_EDGE);
    expect(px.width).toBe(RASTER_EDGE);
    // Within a pixel of the edge, and within a pixel of each other.
    expect(RASTER_EDGE - mm.right).toBeLessThanOrEqual(2);
    expect(Math.abs(mm.right - px.right)).toBeLessThanOrEqual(2);
    expect(Math.abs(mm.bottom - px.bottom)).toBeLessThanOrEqual(2);
  }, 60_000);
});

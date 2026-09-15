import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { RENDER_TIMEOUT_MS } from "../src/assets.js";
import { bundle } from "../src/bundle.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../..");
const RUNTIME_DIST = join(here, "../../runtime/dist");

/**
 * A published bundle carries no document, so nothing in it can run or fetch.
 *
 * Two versions of this file guarded two versions of an SVG sanitiser, and each sanitiser
 * was broken by the next adversarial pass: five bypasses against pattern matching, seven
 * against a tokeniser and an allowlist, ten payloads executing or fetching in two browsers.
 * The bundler now renders every SVG to a PNG and refuses anything whose own bytes are not
 * an image, a video or an audio file. So this file no longer asks whether a sanitiser
 * caught something; it asks the only question that matters, which is whether anything a
 * browser would treat as a document ever lands in the folder.
 *
 * Every payload below is one the reviews produced against the earlier controls. Each has
 * one of two acceptable outcomes: it is refused, or it ships as a PNG whose bytes say PNG.
 * Neither outcome puts a document at an address.
 */
describe("a published bundle", () => {
  const scratches: string[] = [];
  afterAll(async () => {
    for (const dir of scratches.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const TARGET = {
    formatVersion: 2,
    id: "front",
    width: 640,
    height: 452,
    features: [{ x: 50, y: 50, strength: 1, angle: 0, scale: 1, descriptor: [0, 1, 2, 3, 4, 5, 6, 7] }],
    report: { minimumWidthMm: 100, pass: true, scanDistanceMm: 190 },
  };

  const manifestFor = (src: string) => ({
    schemaVersion: "1.0.0",
    id: "probe-case",
    title: "Probe",
    targets: [
      { id: "front", source: "artwork.png", physicalWidthMm: 148, content: [{ type: "image", src }] },
    ],
  });

  async function workspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "taggant-network-"));
    scratches.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "artwork.png"),
      await readFile(join(REPO, "examples/postcard/artwork.png")),
    );
    await writeFile(
      join(dir, "src", "overlay.svg"),
      await readFile(join(REPO, "examples/postcard/overlay.svg")),
    );
    return dir;
  }

  /** Publish one asset. Returns the shipped files, or the refusal. */
  async function publish(
    name: string,
    content: Buffer | string,
  ): Promise<{ shipped: string[]; outDir: string } | { refused: string }> {
    const dir = await workspace();
    await writeFile(join(dir, "src", name), content);
    const outDir = join(dir, "bundle");
    try {
      await bundle({
        manifest: manifestFor(name),
        targets: { front: TARGET },
        sourceDir: join(dir, "src"),
        outDir,
        runtimeDir: RUNTIME_DIST,
      });
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    }
    return { shipped: await readdir(join(outDir, "assets")), outDir };
  }

  /** What a file's own bytes say it is: the check a browser makes before the extension. */
  function signature(bytes: Buffer): string {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF") return "riff";
    if (bytes.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
    const head = bytes.subarray(0, 64).toString("latin1");
    if (/^\s*</.test(head) || head.startsWith("\xff\xfe") || head.startsWith("\xfe\xff")) return "DOCUMENT";
    return "other";
  }

  const SVG = (inner: string, attrs = "") =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 10 10" ${attrs}>${inner}</svg>`;

  /**
   * Every payload the two reviews produced. The label says which control it beat and how.
   * None may ship as a document; each either ships as a PNG or is refused by name.
   */
  const PAYLOADS: Array<[string, string, Buffer | string]> = [
    [
      "beacon.svg",
      "a remote image, the original defect",
      SVG('<image href="https://tracker.example.net/b.png" width="10" height="10"/>'),
    ],
    [
      "prefixed.svg",
      "namespace-prefixed script, beat the patterns",
      SVG('<svg:script>document.title="RAN"</svg:script><rect width="10" height="10"/>'),
    ],
    [
      "entities.svg",
      "entity-encoded slashes, beat the patterns",
      SVG('<image href="https:&#47;&#47;evil.example/b.png" width="10" height="10"/>'),
    ],
    [
      "noslash.svg",
      "a scheme with no slashes, beat the patterns",
      SVG('<image href="http:evil.example/b.png" width="10" height="10"/>'),
    ],
    [
      "u16.svg",
      "UTF-16, made the tokeniser blind",
      Buffer.from(
        `${String.fromCharCode(0xfeff)}${SVG('<script>document.title="U16"</script><rect width="10" height="10"/>')}`,
        "utf16le",
      ),
    ],
    [
      "u16be.svg",
      "UTF-16 big-endian",
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(SVG("<script>1</script>"), "utf16le").swap16()]),
    ],
    [
      "metaclose.svg",
      "self-closing metadata switched the scan off",
      SVG('<metadata/><script>document.title="MSC"</script><rect width="10" height="10"/>'),
    ],
    [
      "metainside.svg",
      "script inside metadata executes",
      SVG('<metadata><script>document.title="MIS"</script></metadata><rect width="10" height="10"/>'),
    ],
    [
      "desync.svg",
      "a closing bracket inside an attribute hid onload",
      SVG('<rect width="10" height="10"/>', 'data-note="a>" onload="document.title=\'DSY\'"'),
    ],
    [
      "cdata.svg",
      "a stylesheet inside CDATA was blanked",
      SVG(
        '<style><![CDATA[@import url("https://evil.example/c.css");]]></style><rect width="10" height="10"/>',
      ),
    ],
    [
      "lf.svg",
      "a newline entity inside the scheme",
      SVG('<image href="h&#10;ttps://evil.example/lf.png" width="10" height="10"/>'),
    ],
    [
      "doctype.svg",
      "an entity declared after a comment in the DOCTYPE",
      `<!DOCTYPE svg [<!--c--><!ENTITY e "<script>document.title='ENT'</script>">]>${SVG("&e;<rect width='10' height='10'/>")}`,
    ],
    [
      "pi.svg",
      "an xml-stylesheet processing instruction",
      `<?xml-stylesheet type="text/css" href="https://evil.example/pi.css"?>${SVG('<rect width="10" height="10"/>')}`,
    ],
    [
      "escaped.svg",
      "an escaped at-keyword",
      SVG('<style>@\\69 mport "https://evil.example/e.css";</style><rect width="10" height="10"/>'),
    ],
    [
      "redos.svg",
      "an unterminated tag that made the tokeniser quadratic",
      `${SVG("<text>hi</text>")}<rect${"a".repeat(40000)}`,
    ],
    [
      "inkscape.svg",
      "a default Inkscape export, wrongly refused before",
      SVG('<rect width="10" height="10" style="fill:#2b2bd0;stroke-width:0.264583"/>'),
    ],
    [
      "affinity.svg",
      "an Affinity Designer export, wrongly refused before",
      SVG('<path d="M0 0h10v10H0z" style="fill:rgb(235,87,87);fill-rule:evenodd;clip-rule:evenodd;"/>'),
    ],
    [
      "pad.htm",
      "HTML behind 1100 spaces under a document extension",
      `${" ".repeat(1100)}<!DOCTYPE html><html><body><script>document.title="HTM"</script></body></html>`,
    ],
    [
      "pad.shtml",
      "the same under .shtml",
      `${" ".repeat(1100)}<!DOCTYPE html><html><body><script>1</script></body></html>`,
    ],
    [
      "page.xhtml",
      "an XHTML document",
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><script>1</script></body></html>',
    ],
    [
      "fake.png",
      "HTML under a raster extension",
      "<!DOCTYPE html><html><body><script>1</script></body></html>",
    ],
  ];

  it("ships nothing a browser would treat as a document, whatever was handed to it", async () => {
    const outcomes: string[] = [];
    for (const [name, label, content] of PAYLOADS) {
      const started = Date.now();
      const result = await publish(name, content);
      const took = Date.now() - started;
      // Bounded by the render process's own clock plus a margin, and not by a figure for
      // how long a publish takes on a machine: that was five seconds, which a loaded
      // laptop exceeded on an ordinary drawing. The quadratic case the figure was first
      // written for was in a tokeniser that no longer exists. What can hold a publish now
      // is the renderer, the clock on its process is the guard, and this checks that the
      // clock is what bounds a publish rather than the payload.
      expect(took, `${label}: publishing took ${took} ms`).toBeLessThan(RENDER_TIMEOUT_MS + 10_000);
      if ("refused" in result) {
        outcomes.push(`refused   ${name.padEnd(14)} ${label}`);
        continue;
      }
      const documents: string[] = [];
      for (const file of result.shipped) {
        const bytes = await readFile(join(result.outDir, "assets", file));
        const kind = signature(bytes);
        if (kind === "DOCUMENT" || kind === "other") documents.push(`${file} (${kind})`);
        // And the name is honest: what the bytes are is what the extension says.
        if (kind === "png") expect(extname(file), `${label}: a PNG shipped as ${file}`).toBe(".png");
      }
      expect(documents, `${label}: a document reached the bundle: ${documents.join(", ")}`).toEqual([]);
      outcomes.push(`rendered  ${name.padEnd(14)} ${label}`);
    }
    // Printed so the run shows what happened to each, rather than only that nothing broke.
    console.log(outcomes.join("\n"));
  }, 240_000);

  it("renders the example overlay to a PNG that still holds the drawing", async () => {
    const result = await publish("overlay.svg", await readFile(join(REPO, "examples/postcard/overlay.svg")));
    if ("refused" in result) throw new Error(`the example overlay was refused: ${result.refused}`);
    const [file] = result.shipped.filter((name) => name.endsWith(".png"));
    expect(file, "the overlay did not ship as a PNG").toBeDefined();
    const bytes = await readFile(join(result.outDir, "assets", file ?? ""));
    expect(signature(bytes)).toBe("png");
    // Not a blank raster, and the drawing that was authored: a near-black panel at 0.88
    // opacity with rounded corners and two lines of light monospace text. So most pixels
    // are opaque and dark, some are light where the text is, and the corner is transparent
    // where the rounding is. (The first version of this assertion looked for a red
    // rectangle, for a file it had never opened, and failed against a correct render.)
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels, "the raster carries no alpha, so the rounding could not be transparent").toBe(4);
    let opaque = 0;
    let dark = 0;
    let light = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b, a] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
      if (a > 200) {
        opaque++;
        if (r < 60 && g < 60 && b < 60) dark++;
        if (r > 200 && g > 200) light++;
      }
    }
    const total = info.width * info.height;
    expect(opaque / total, "the panel did not render").toBeGreaterThan(0.95);
    expect(dark / opaque, "the panel is not dark, so this is not the drawing").toBeGreaterThan(0.85);
    expect(light, "no light pixels, so the text did not render").toBeGreaterThan(total * 0.002);
    const corner = data.subarray(2 * info.channels + 2 * info.width * info.channels);
    expect(corner[3], "the rounded corner is not transparent").toBeLessThan(50);
    expect(
      Math.max(info.width, info.height),
      "rendered smaller than a phone would show it",
    ).toBeGreaterThanOrEqual(1024);
  }, 60_000);

  it("renders the beacon with nothing where the remote image would have been", async () => {
    // The renderer has no network stack, and the buffer has no base location. So the image
    // element leaves no pixels: the only opaque region is the rectangle drawn beside it.
    const result = await publish(
      "beacon-rect.svg",
      SVG(
        '<image href="https://tracker.example.net/b.png" x="0" y="0" width="5" height="10"/><rect x="5" width="5" height="10" fill="#000"/>',
      ),
    );
    if ("refused" in result) throw new Error(`refused: ${result.refused}`);
    const [file] = result.shipped.filter((name) => name.endsWith(".png"));
    const { data, info } = await sharp(join(result.outDir, "assets", file ?? ""))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let leftOpaque = 0;
    let rightOpaque = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const alpha = data[(y * info.width + x) * info.channels + 3] ?? 255;
        if (alpha > 128) {
          if (x < info.width / 2) leftOpaque++;
          else rightOpaque++;
        }
      }
    }
    expect(leftOpaque, "pixels appeared where the remote image would be").toBe(0);
    expect(rightOpaque, "the drawn rectangle is missing").toBeGreaterThan((info.width * info.height) / 4);
  }, 60_000);

  it("renders nothing where a local file would have been, by every route the renderer has", async () => {
    // The console publishes what it is handed with the file system rights of whoever runs
    // it, and a bundle is public. So the question is not only whether an SVG can run but
    // whether it can make the renderer draw a local file into the picture, which would ship
    // that file to the world as pixels. Each payload's only visible content is what its
    // reference would bring in, drawn white on transparent, so one opaque pixel is a leak.
    // The data: include is the control: it proves the include route and text rendering
    // both work on this machine, so an empty render is the reference resolving to nothing
    // rather than the renderer drawing nothing at all.
    const file = `file:///${join(REPO, "examples/postcard/manifest.json").replace(/\\/g, "/")}`;
    const ns =
      'xmlns="http://www.w3.org/2000/svg" xmlns:xi="http://www.w3.org/2001/XInclude" xmlns:xlink="http://www.w3.org/1999/xlink"';
    const open = `<svg ${ns} viewBox="0 0 400 100">`;
    const text = (inner: string) =>
      `${open}<text x="10" y="50" fill="#fff" font-size="12">${inner}</text></svg>`;
    const nested = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xi="http://www.w3.org/2001/XInclude" viewBox="0 0 400 100"><text x="10" y="50" fill="#fff" font-size="12"><xi:include href="${file}" parse="text"/></text></svg>`,
    );
    const routes: [string, string][] = [
      ["an XInclude of the file as text", text(`<xi:include href="${file}" parse="text"/>`)],
      [
        "an XInclude by relative path",
        text('<xi:include href="../../examples/postcard/manifest.json" parse="text"/>'),
      ],
      ["an XInclude of the file as XML", `${open}<xi:include href="${file}" parse="xml"/></svg>`],
      ["an external entity", `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "${file}">]>${text("&xxe;")}`],
      ["a parameter entity", `<!DOCTYPE svg [<!ENTITY % p SYSTEM "${file}">%p;]>${text("")}`],
      ["an image element", `${open}<image href="${file}" width="400" height="100"/></svg>`],
      ["an image element by xlink", `${open}<image xlink:href="${file}" width="400" height="100"/></svg>`],
      ["a use element", `${open}<use href="${file}#x"/></svg>`],
      [
        "a filter image",
        `${open}<filter id="f"><feImage href="${file}"/></filter><rect width="400" height="100" filter="url(#f)"/></svg>`,
      ],
      [
        "an include inside a nested data: image",
        `${open}<image width="400" height="100" href="data:image/svg+xml;utf8,${nested}"/></svg>`,
      ],
    ];

    /** Opaque pixels in what shipped; none when the publish was refused. */
    const opaque = async (name: string, content: string): Promise<number> => {
      const result = await publish(name, content);
      if ("refused" in result) return 0;
      const [shipped] = result.shipped.filter((entry) => entry.endsWith(".png"));
      const { data, info } = await sharp(join(result.outDir, "assets", shipped ?? ""))
        .raw()
        .toBuffer({ resolveWithObject: true });
      let count = 0;
      for (let i = 3; i < data.length; i += info.channels) if ((data[i] ?? 0) > 32) count++;
      return count;
    };

    expect(
      await opaque("control.svg", text('<xi:include href="data:text/plain,INCLUDED" parse="text"/>')),
      "the control did not render, so an empty render would prove nothing",
    ).toBeGreaterThan(0);
    for (const [label, content] of routes) {
      expect(await opaque("route.svg", content), `${label} put pixels where the file would be`).toBe(0);
    }
  }, 180_000);

  it("refuses a fragment, because no shipped file has anything a fragment could point into", async () => {
    const dir = await workspace();
    await expect(
      bundle({
        manifest: manifestFor("overlay.svg#symbol"),
        targets: { front: TARGET },
        sourceDir: join(dir, "src"),
        outDir: join(dir, "bundle"),
        runtimeDir: RUNTIME_DIST,
      }),
    ).rejects.toThrow(/names a fragment/);
  }, 60_000);

  it("decides by the bytes, so a real PNG under a document extension ships as a PNG", async () => {
    const png = await readFile(join(REPO, "examples/postcard/artwork.png"));
    const result = await publish("art.htm", png);
    if ("refused" in result) throw new Error(`a real PNG was refused for its name: ${result.refused}`);
    expect(
      result.shipped.some((name) => name.endsWith(".png")),
      "shipped under the wrong extension",
    ).toBe(true);
  }, 60_000);

  it("carries an absolute address only where the author declared a fallback", async () => {
    // The one absolute address a bundle may hold. Everything else in every shipped text
    // file has to be relative or a namespace, and the runtime and the manifest are text.
    const dir = await workspace();
    const out = join(dir, "bundle");
    const manifest = { ...manifestFor("overlay.svg"), fallback: "https://example.org/where-this-goes" };
    await bundle({
      manifest,
      targets: { front: TARGET },
      sourceDir: join(dir, "src"),
      outDir: out,
      runtimeDir: RUNTIME_DIST,
    });
    const files: string[] = [];
    const walk = async (root: string): Promise<void> => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push(path);
      }
    };
    await walk(out);
    const unaccounted: string[] = [];
    for (const file of files) {
      const bytes = await readFile(file);
      const kind = signature(bytes);
      if (kind !== "other" && kind !== "DOCUMENT") continue; // a raster or video carries no address
      const text = bytes.toString("utf8");
      for (const found of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi)) {
        if (found[0].startsWith(manifest.fallback)) continue;
        const before = text.slice(Math.max(0, (found.index ?? 0) - 80), found.index);
        if (/xmlns(:[a-z0-9-]+)?\s*=\s*["']?$/i.test(before)) continue;
        unaccounted.push(`${file.slice(out.length + 1)}: ${found[0]}`);
      }
    }
    expect(unaccounted, `the bundle reaches for the network: ${unaccounted.join(", ")}`).toEqual([]);
  }, 60_000);
});

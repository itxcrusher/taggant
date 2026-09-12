# Postcard

One printed piece, one target, one thing shown on it. This is the whole path: artwork in, a compiled target out, and a page that finds that artwork through a camera.

## Run it

From the root of the repository:

```
pnpm install
pnpm -r build
node packages/compiler/dist/cli.js examples/postcard/artwork.png --id front --scan-distance 350 --out examples/postcard/front.target.json
npx --yes serve .
```

Open the address it prints, go to `examples/postcard/`, and allow the camera. A camera is only offered to a page on `localhost` or over HTTPS, so opening the file directly will not work.

Then point it at the artwork. Print `artwork.png` at 148 mm wide, or just show it on another screen: the tracker does not know the difference.

## What the compile says

```
  artwork.png
  size                  640 x 454 px
  tracking quality      100 / 100
  features              248, reaching 16 of 16 areas
  minimum print width   70 mm to be read from 350 mm away, being 320 px across the artwork
  repeated detail       29% of features have a look-alike, which is normal
  verdict               ready for press
```

The manifest declares this postcard as 148 mm wide and the compiler asks for at least 70 mm at a scan distance of 350 mm, so it has room. Compile it again at `--scan-distance 900` and the minimum rises, because a camera further away puts fewer pixels across the same mark.

That width is a resolution requirement, not a judgement of the artwork. It is the print size at which the camera, assumed to resolve 1.6 px/mm at a metre, still delivers the 320 px across the mark that the smallest size in the compiled target needs. The line says so rather than printing a bare number, because a bare number under a filename reads as a measurement of the design and gets carried into a press setup as one.

The size line reads 640 by 454 where the file is 592 by 420, because every piece of artwork is analysed at the same raster whatever size it was exported at. Otherwise the same design sent as a bigger file would be measured differently and told to print larger, which rewards exporting small.

`repeated detail` is the share of features that have a look-alike somewhere else on the piece. It matters because nothing else in the report notices a design that repeats, and a repeated design gives a tracker no way to know which copy it is looking at: the same artwork printed twice scores full marks on features and spread, and then places content a whole tile away.

## The files

| File | What it is |
|---|---|
| `manifest.json` | the experience: what the printed thing is, how wide it is, and what to show on it |
| `artwork.png` | the artwork, generated rather than photographed so it is reproducible |
| `overlay.svg` | what appears on the artwork |
| `index.html` | the page that runs it |
| `front.target.json` | produced by the compile step above, not checked in |

`physicalWidthMm` in the manifest is the real width of the printed piece. It is what turns a pose in pixels into a pose in millimetres, so it is worth measuring rather than guessing.

## If the camera will not open

The page says so and stays where it is. That is what this manifest does, because it has no `fallback`.

A manifest may name one, and then the runtime sends the viewer there instead: somebody scanned a printed thing and the camera is not going to open, so a page about the thing they scanned beats an apology. It is the right behaviour for something in the field and the wrong behaviour here, where being moved to another site is a confusing answer to reading an example. This manifest used to carry one pointing at `example.com`, which meant refusing the camera navigated away from the example and landed on a placeholder page with no explanation.

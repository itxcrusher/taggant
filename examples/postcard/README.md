# Postcard

One printed piece, one target, one thing shown on it. This is the whole path: artwork in, a compiled target out, and a page that finds that artwork through a camera.

## Run it

From the root of the repository:

```
pnpm install
pnpm -r build
node packages/compiler/dist/cli.js examples/postcard/artwork.png --id front --scan-distance 190 --out examples/postcard/front.target.json
npx --yes serve .
```

Open the address it prints, go to `examples/postcard/`, and allow the camera. Opening the file directly does not work, and it fails before the camera is ever asked for: a browser will not load a module from a `file://` origin, so the page cannot reach the code it needs. Serving it is also what makes a camera available at all, since one is only offered on `localhost` or over HTTPS.

Then point it at the artwork. Print `artwork.png` at 148 mm wide, or show it on another screen at that size, and hold the camera about 190 mm away: closer is fine, further stops working, which is what the width line above is telling you.

## What the compile says

```
  artwork.png
  size                  640 x 454 px
  tracking quality      100 / 100
  features              248, reaching 16 of 16 areas
  minimum print width   147 mm to be read from 190 mm away, being 320 px across the artwork from left to right
  recognised            at that width, 58 points agree in the worst of four turns, where 20 are needed
  verdict               ready for press
```

The manifest declares this postcard as 148 mm wide and the compiler asks for at least 147 mm to read it from 190 mm away, so it has a millimetre in hand and no more. Compile it again at `--scan-distance 350` and the minimum rises to 270 mm, because a camera further away puts fewer pixels across the same mark: an A6 postcard is not readable from arm's length by this, and the report says so rather than letting a press run find out.

That width is a resolution requirement, not a judgement of the artwork. It is the print size at which the mark still fills enough of the picture to put 320 pixels across itself, which is what the smallest size in the compiled target needs. Recognition works on a frame reduced to a fixed width, so what decides this is how much of the frame the print fills, and that is a matter of the field of view and the distance rather than of how many pixels the sensor has. The line says what it is derived from rather than printing a bare number, because a bare number under a filename reads as a measurement of the design and gets carried into a press setup as one.

The size line reads 640 by 454 where the file is 592 by 420, because every piece of artwork is analysed at the same raster whatever size it was exported at. Otherwise the same design sent as a bigger file would be measured differently and told to print larger, which rewards exporting small.

`recognised` is what decides the verdict. The compiler puts the artwork in front of the recogniser at the width above, turned four ways, and the width stands only if twenty points agree on where it is in the worst turn. For this postcard the fewest is 58. A design that repeats is the case it exists for: four copies of this postcard on one sheet have plenty of features spread over the whole piece, and in the worst turn the recogniser never gets more than 13 to agree at any size, because a feature with a twin that matches as well as it does is one a matcher has to discard.

## The files

| File | What it is |
|---|---|
| `manifest.json` | the experience: what the printed thing is, how wide it is, and what to show on it |
| `artwork.png` | the artwork, generated rather than photographed so it is reproducible |
| `overlay.svg` | what appears on the artwork |
| `index.html` | the page that runs it |
| `front.target.json` | produced by the compile step above, not checked in |

`physicalWidthMm` in the manifest is the real width of the printed artwork, measured left to right as its file is oriented: the same edge the compiler's minimum width is for. It is what turns a pose in pixels into a pose in millimetres, so it is worth measuring rather than guessing.

## If the camera will not open

The page says so and stays where it is. That is what this manifest does, because it has no `fallback`.

A manifest may name one, and then the runtime sends the viewer there instead: somebody scanned a printed thing and the camera is not going to open, so a page about the thing they scanned beats an apology. That is the right behaviour in the field and the wrong behaviour in an example, where being moved to another site is a confusing answer to reading one, so this manifest has no `fallback` and the page explains itself instead.

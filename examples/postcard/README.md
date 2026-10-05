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
  minimum print width   147 mm to be read from 190 mm away, putting at least 320 px across the artwork from left to right
  maps onto itself      no: the most one move carries onto look-alikes is 5 of its 548 places, and the lines are 20 places and 20 per cent of them
  recognised            at that size, every turn found it with 20 or more points agreeing at 5 of 5 widths, and with at least 50 at three of them, and no look put it in the wrong place
  verdict               ready for press
```

The manifest declares this postcard as 148 mm wide and the compiler asks for at least 147 mm to read it from 190 mm away, so it has a millimetre in hand and no more. Compile it again at `--scan-distance 350` and the minimum rises to 270 mm, because a camera further away puts fewer pixels across the same mark: an A6 postcard is not readable from arm's length by this, and the report says so rather than letting a press run find out.

That width is a resolution requirement, not a judgement of the artwork. It is the print size at which the mark still fills enough of the picture to put 320 pixels across itself, which is what the smallest size in the compiled target needs. Recognition works on a frame reduced to a fixed width, so what decides this is how much of the frame the print fills, and that is a matter of the field of view and the distance rather than of how many pixels the sensor has. The line says what it is derived from rather than printing a bare number, because a bare number under a filename reads as a measurement of the design and gets carried into a press setup as one.

The size line reads 640 by 454 where the file is 592 by 420, because every piece of artwork is analysed at the same raster whatever size it was exported at. Otherwise the same design sent as a bigger file would be measured differently and told to print larger, which rewards exporting small.

`maps onto itself` is asked first. The compiler looks for one move of the whole artwork, a shift with any turn or change of size, that carries its features onto features that look like them, and the most this postcard manages is 5 of its 548 places, a coincidence. Printed twice, one above the other, it is 230 of 624, more than a third of its places, by a shift of exactly one postcard down: a camera can settle on that shift and draw the content on the other copy, so the sheet is refused there, before the recogniser is asked anything. The line is twenty places and a fifth of them, and a sheet of copies sits far above both. Beside a copy of itself at 60 per cent of its size it is 61 of 458, under both lines, because a copy at another size pairs only at the sizes whose ratio is its own; that one is refused by pointing the recogniser at the small copy from close up, where it settles on the postcard.

`recognised` is what decides the width. The compiler shows the artwork to the recogniser at five widths around the size above, two per cent apart, each turned four ways, and the width stands only if at most of those widths every turn finds it with twenty points agreeing on where it is, and no look puts it anywhere else. For this postcard all five widths do, and at three of them every turn finds at least 50.

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

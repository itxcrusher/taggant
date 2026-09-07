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
  size                  592 x 420 px
  tracking quality      100 / 100
  features              261, reaching 16 of 16 areas
  minimum print width   83 mm
  verdict               ready for press
```

The manifest declares this postcard as 148 mm wide, and the compiler asks for at least 83 mm at a scan distance of 350 mm, so it has room. Compile it again at `--scan-distance 900` and the minimum rises, because a camera further away puts fewer pixels across the same mark.

## The files

| File | What it is |
|---|---|
| `manifest.json` | the experience: what the printed thing is, how wide it is, and what to show on it |
| `artwork.png` | the artwork, generated rather than photographed so it is reproducible |
| `overlay.svg` | what appears on the artwork |
| `index.html` | the page that runs it |
| `front.target.json` | produced by the compile step above, not checked in |

`physicalWidthMm` in the manifest is the real width of the printed piece. It is what turns a pose in pixels into a pose in millimetres, so it is worth measuring rather than guessing.

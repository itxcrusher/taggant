# taggant

Connect a printed object to a digital experience that outlives the platform serving it.

A taggant is a marker added to a material so that a later reader can identify it and verify it. This project does the same for printed things. Point a phone camera at a product pack, a label, a poster or a print, or scan the code on it, and the right content opens in the browser with nothing to install.

## Status

Early development. Four packages are usable, the rest are being built in the open. Nothing has been published to a registry and nothing is tagged, so interfaces change without notice.

## Judging artwork before it goes to press

A press run cannot be undone, so the question worth answering first is whether this artwork will track at the size and distance it will actually be used at. Both runs below are at the same scan distance, and both outputs are copied from the terminal.

```
$ node packages/compiler/dist/cli.js blots.png --scan-distance 400

  blots.png
  size                  640 x 480 px
  tracking quality      97 / 100
  features              214, reaching 16 of 16 areas
  minimum print width   103 mm
  verdict               ready for press

$ echo $?
0
```

Artwork that fails says why, and exits non-zero so a build can stop on it:

```
$ node packages/compiler/dist/cli.js wordmark.png --scan-distance 400

  wordmark.png
  size                  800 x 600 px
  tracking quality      12 / 100
  features              12, reaching 4 of 16 areas
  minimum print width   56 mm
  verdict               not ready
      too few features to track reliably

$ echo $?
2
```

Two things in there are worth reading carefully.

**Minimum print width is measured from the artwork, not from the flag.** It comes from how far apart the artwork's features sit relative to its size: fine, closely spaced detail has to be printed larger than bold, open artwork before a camera at the same distance can separate one feature from the next. That is why the failing wordmark asks for a smaller print than the passing artwork above it, and it is why the number changes when the artwork changes rather than only when the distance does. It also grows with scan distance, because a camera further away resolves fewer pixels across the same mark.

**Score and verdict cannot disagree.** 60 is the pass mark exactly. Below it, the score says how far short the artwork falls; above it, how much headroom it has.

The number the report cannot yet measure is the camera. Minimum print width assumes a resolving power of 1.6 pixels per millimetre at one metre, which is roughly a 1080p sensor over a 60 degree field. That is optimistic for a browser camera stream, where 720p is common. It is marked as an assumption in the source and is due to be replaced by a measurement across real devices.

## Packages

| Package | State | Purpose |
|---|---|---|
| `@taggant/manifest` | usable | the versioned experience format, its validator, and types generated from the schema |
| `@taggant/vision` | usable | detection, description, matching and pose: the part the compiler and the runtime must agree on exactly |
| `@taggant/compiler` | usable | artwork to compiled target, with a print readiness report, as a library and a command line |
| `@taggant/runtime` | usable | camera, recognition and placing content on the artwork, in the browser |
| `@taggant/bundler` | planned | an experience compiled to a self-contained static folder |
| `services/resolver` | planned | code lifecycle and GS1 Digital Link resolution |
| `apps/console` | planned | authoring for products, artwork versions, targets and codes |

`@taggant/vision` carries no dependencies. The detector, the descriptor, the matcher and the homography solver are all in this repository, which is what lets the compiler and the browser produce identical descriptors from the same artwork.

## How recognition works

Artwork is described at four sizes rather than one, because a descriptor only compares with another taken at roughly the same size, and a print photographed from further back is a smaller image of the same thing. Each feature is reported in the artwork's own coordinates whichever size it was found at, so the pose comes straight out of the fit.

A camera frame is described at two sizes for the same reason and one more: a frame that is slightly out of focus moves detail down the scale the way distance does. Descriptors are matched with a ratio test and a mutual best check, and the pose is fitted by RANSAC over a normalised direct linear transform, which expects a share of the matches to be confidently wrong.

Recognition is measured against known mappings rather than asserted. Artwork is warped by a homography the test chose, located, and the four corners of the artwork are checked against where that mapping puts them: under 4 px square on, under 6 px turned on its side, under 8 px held at an angle, and it is still found through two passes of blur.

## Showing something on a print

`examples/postcard` is the whole path in one directory: a hand written manifest, the artwork it names, and a page that opens the camera and puts content on that artwork when it finds it. Its README has the three commands.

```js
await mountExperience({
  manifest,
  targets: [target],
  container: document.querySelector("#scene"),
});
```

The container ends up holding the camera picture with one element per target over it, each carrying the pose as a CSS transform, so a frame where nothing is found costs one hidden attribute rather than a rebuild. Content is only taken away after several consecutive misses, because recognition is per frame and one frame without a find is ordinary. A refused camera is told apart from a missing one, and the manifest's fallback is followed when the camera will not open at all.

## Design commitments

These hold for every release and are the reason the project exists in this shape.

- A published experience is a static bundle. It carries its own runtime and assets, and it does not call this project's services to work.
- The manifest format is open, versioned and documented, so anything else can read or write it. A manifest is data: it cannot carry a script destination, and its asset paths stay inside the bundle.
- Image targets first. Handheld web AR has no camera pose on every platform, and printed artwork is the trigger that works everywhere.
- No proprietary runtime dependency that cannot be redistributed.
- When the resolver exists, its conformance will be proven against the published GS1 Digital Link test suite in continuous integration rather than asserted here.

## What has and has not been verified

The four packages are exercised by 122 tests, and the whole gate runs on every push.

The runtime is driven in a real browser rather than asserted: the test writes a video file of the artwork sitting in a larger frame, hands it to Chromium as a camera, and waits for the page to reach its tracking state, then checks that the content landed where the feed actually put the artwork. The example was driven the same way, and the overlay came back within a pixel of the truth.

**Not verified: any real camera, and any real print.** Everything above is synthetic. The device matrix is empty and stays empty until it can be filled in with measurements, and the assumed camera resolving power in the print readiness report is an assumption until then.

## Working on it

Requires Node 22 and pnpm 11, which is pinned in `package.json`.

```
pnpm install
pnpm -r typecheck && pnpm check && pnpm -r test && pnpm -r build
```

There is no published package, so the command line runs from the build: `node packages/compiler/dist/cli.js <artwork>`.

`dev` is the integration branch and is where work lands first. `main` is the stable branch; nothing has been released to it yet.

## Licence

MIT. See [LICENSE](LICENSE).

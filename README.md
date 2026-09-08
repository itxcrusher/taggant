# taggant

Connect a printed object to a digital experience that outlives the platform serving it.

A taggant is a marker added to a material so that a later reader can identify it and verify it. This project does the same for printed things. Point a phone camera at a product pack, a label, a poster or a print, or scan the code on it, and the right content opens in the browser with nothing to install.

## Status

Early development. Six packages are usable, the rest are being built in the open. Nothing has been published to a registry and nothing is tagged, so interfaces change without notice.

## Judging artwork before it goes to press

A press run cannot be undone, so the question worth answering first is whether this artwork will track at the size and distance it will actually be used at. Both runs below are at the same scan distance, and both outputs are copied from the terminal.

```
$ node packages/compiler/dist/cli.js blots.png --scan-distance 400

  blots.png
  size                  640 x 480 px
  tracking quality      86 / 100
  features              135, reaching 16 of 16 areas
  minimum print width   160 mm to be read from 400 mm away, being 640 px across the artwork
  verdict               ready for press

$ echo $?
0
```

Artwork that fails says why, and exits non-zero so a build can stop on it:

```
$ node packages/compiler/dist/cli.js wordmark.png --scan-distance 400

  wordmark.png
  size                  800 x 600 px
  tracking quality      20 / 100
  features              20, reaching 4 of 16 areas
  minimum print width   not printable until the artwork passes
  verdict               not ready
      too few features to track reliably

$ echo $?
2
```

Two things in there are worth reading carefully.

**Minimum print width says what it is derived from.** It is a resolution requirement, not a judgement of the design: the print has to be large enough that the camera, at that distance, still delivers the pixels across the mark that the smallest size in the compiled target needs. Artwork that holds up all the way down that range asks for less; the postcard in `examples/postcard` needs 296 px across and so 65 mm at 350 mm, while the artwork above holds up only at full size, needs 640 px, and asks for 160 mm. Artwork that does not pass gets no width at all, because no width would fix it.

The line is written out in full rather than as a bare figure in millimetres, because a bare figure under a filename reads as a measurement of the design and gets carried into a press setup as one.

**Score and verdict cannot disagree.** 60 is the pass mark exactly. Below it, the score says how far short the artwork falls; above it, how much headroom it has.

The number the report cannot yet measure is the camera. Minimum print width assumes a resolving power of 1.6 pixels per millimetre at one metre, which is roughly a 1080p sensor over a 60 degree field. That is optimistic for a browser camera stream, where 720p is common. It is marked as an assumption in the source and is due to be replaced by a measurement across real devices.

## Packages

| Package | State | Purpose |
|---|---|---|
| `@taggant/manifest` | usable | the versioned experience format, its validator, and types generated from the schema |
| `@taggant/vision` | usable | detection, description, matching and pose: the part the compiler and the runtime must agree on exactly |
| `@taggant/compiler` | usable | artwork to compiled target, with a print readiness report, as a library and a command line |
| `@taggant/runtime` | usable | camera, recognition and placing content on the artwork, in the browser |
| `@taggant/bundler` | usable | an experience published as a self-contained static folder |
| `services/resolver` | usable | GS1 Digital Link resolution, conformant against the published criteria |
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

Recognition runs in a worker, and drawing and recognition are separate loops. Finding artwork in a frame takes a couple of hundred milliseconds, which on the page's own thread is a couple of hundred milliseconds where the camera preview does not repaint and nothing the viewer touches responds. Drawing follows the display and runs every frame from the last known pose; recognition runs as often as it can finish and drops the frames that arrive meanwhile, because a queue would only build a backlog of poses for positions the print has already left. Where a browser will not give a worker, recognition falls back to the page's thread, since a runtime that stops working without one is worse than a runtime that runs slowly.

Measured in Chromium against the example, at 480 by 360: recognition went from 576 ms a call to 212 ms, and with it off the main thread the page paints at a median of 16.6 ms with no frame over 100 ms across 120. The test asserts both, because a green suite is what let the first number go unnoticed.

## Publishing something that outlives us

A printed thing can last decades. The service that served its experience does not have to.

```
$ node packages/bundler/dist/cli.js examples/postcard/manifest.json     --target front=front.target.json --out dist/postcard

  7 files written to dist/postcard
  overlay.svg -> assets/64b7fbcbc479e0c4.svg (428 bytes)

  Serve that folder over HTTPS or from localhost. It needs nothing else.
```

What comes out is a folder: an entry page, the manifest rewritten to point at what was copied, the compiled targets, the assets under names taken from their own content, and the runtime carried in rather than linked. Nothing in it reaches for the network.

That is a claim, so it is tested as one. A test serves the folder from a plain static server with nothing else running, drives it in a real browser against a synthetic camera, and waits for it to find the artwork. It fails on any request that leaves the origin and on any request the folder cannot answer. A second test reads every file the bundle ships and refuses an absolute address in any of them.

Content addressing is why republishing an experience whose video did not change does not invalidate that video, and why the same file is never stored twice. Paths in a manifest are resolved against the manifest's own directory and refused if they leave it: publishing runs with the rights of whoever publishes, and a manifest is a format other people write.

## Resolving a printed code

A code printed on a thing is a promise that scanning it will reach something. The resolver keeps that promise, and it does so the way the standard says to rather than the way that is convenient.

```
$ curl -sI 'http://localhost:8080/01/09520123456788?utm_source=pack' | grep -i '^location'
location: https://example.com/product?utm_source=pack

$ curl -sI -H 'Accept-Language: fr' 'http://localhost:8080/gtin/09520123456788' | grep -i '^location'
location: https://example.com/produit
```

The first request carries its own query string through to the destination, which is what lets a printed code carry a campaign parameter the resolver knows nothing about. The second asks in French, in the alphabetic path form the standard also allows, and gets the French page: the default holds unless the request says something that allows a better match.

Anything that would rather read than follow asks for the linkset, and gets every link about that identifier, including the ones attached further up its own hierarchy:

```
$ curl -s 'http://localhost:8080/01/09520123456788/10/ABC?linkType=linkset'
{
  "linkset": [
    {
      "anchor": "http://localhost:8080/01/09520123456788/10/ABC",
      "https://gs1.org/voc/certificationInfo": [
        { "href": "https://example.com/batch/ABC", "title": "Certification for batch ABC", "hreflang": ["en"] }
      ]
    },
    {
      "anchor": "http://localhost:8080/01/09520123456788",
      "https://gs1.org/voc/pip": [
        { "href": "https://example.com/product", "title": "Product information page", "hreflang": ["en"], "type": "text/html" }
      ]
    }
  ]
}
```

**Conformance is tested, not claimed.** Every test is named with the requirement it checks, quoted from the conformance criteria GS1 publishes alongside its resolver test suite, and each one drives a real resolver over HTTP. Forty one of them, and they fail a pull request. GS1's own suite is a browser tool with a PHP helper that runs against a deployed resolver, so it is not something a build can run; pointing it at a deployment is a separate exercise from proving the behaviour on every commit.

**Compressed Digital Link URIs are not supported.** That is a SHALL in the standard. It is declared in the resolver description file at `/.well-known/gs1resolver`, where a client would look for it, and there is a test asserting it is declared. A resolver that claims conformance it does not have is worse than one that says where it stops.

The link table is plain JSON keyed by canonical Digital Link paths, which is the continuity promise in the same form the bundler makes it. A redirect table that cannot be read out and rehosted somewhere else is not a promise.

## Design commitments

These hold for every release and are the reason the project exists in this shape.

- A published experience is a static bundle. It carries its own runtime and assets, and it does not call this project's services to work.
- The manifest format is open, versioned and documented, so anything else can read or write it. A manifest is data: it cannot carry a script destination, and its asset paths stay inside the bundle.
- Image targets first. Handheld web AR has no camera pose on every platform, and printed artwork is the trigger that works everywhere.
- No proprietary runtime dependency that cannot be redistributed.

## What has and has not been verified

The six packages are exercised by 190 tests, and the whole gate runs on every push.

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

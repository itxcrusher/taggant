# taggant

Connect a printed object to a digital experience that outlives the platform serving it.

A taggant is a marker added to a material so that a later reader can identify it and verify it. This project does the same for printed things. Point a phone camera at a product pack, a label, a poster or a print, or scan the code on it, and the right content opens in the browser with nothing to install.

## Status

Early development. Every part of the path is usable and being built in the open. Nothing has been published to a registry and nothing is tagged, so interfaces change without notice.

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

**Minimum print width says what it is derived from.** It is a resolution requirement, not a judgement of the design: the print has to be large enough that the camera, at that distance, still delivers the pixels across the mark that the smallest size in the compiled target needs. Artwork that holds up all the way down that range asks for less; the postcard in `examples/postcard` needs 320 px across and so 70 mm at 350 mm, while the artwork above holds up only at full size, needs 640 px, and asks for 160 mm. Artwork that does not pass gets no width at all, because no width would fix it.

The line is written out in full rather than as a bare figure in millimetres, because a bare figure under a filename reads as a measurement of the design and gets carried into a press setup as one.

**Score and verdict cannot disagree.** 60 is the pass mark exactly. Below it, the score says how far short the artwork falls; above it, how much headroom it has.

The number the report cannot yet measure is the camera. Minimum print width assumes a resolving power of 1.6 pixels per millimetre at one metre, which is roughly a 1080p sensor over a 60 degree field. That is optimistic for a browser camera stream, where 720p is common. It is marked as an assumption in the source and is due to be replaced by a measurement across real devices.

## Packages

| Package | State | Purpose |
|---|---|---|
| [`@taggant/manifest`](packages/manifest/README.md) | usable | the versioned experience format, its validator, and types generated from the schema |
| `@taggant/vision` | usable | detection, description, matching and pose: the part the compiler and the runtime must agree on exactly |
| `@taggant/compiler` | usable | artwork to compiled target, with a print readiness report, as a library and a command line |
| `@taggant/runtime` | usable | camera, recognition and placing content on the artwork, in the browser |
| `@taggant/bundler` | usable | an experience published as a self-contained static folder |
| `services/resolver` | usable | GS1 Digital Link resolution, conformant against the published criteria |
| `infra` | usable | containers for the whole path, driven on every push |
| `apps/console` | usable | authoring: artwork in, print verdict, published bundle, code pointed at it |

`@taggant/vision` carries no dependencies. The detector, the descriptor, the matcher and the homography solver are all in this repository, which is what lets the compiler and the browser produce identical descriptors from the same artwork.

## How recognition works

Artwork is described at four sizes rather than one, because a descriptor only compares with another taken at roughly the same size, and a print photographed from further back is a smaller image of the same thing. Each feature is reported in the artwork's own coordinates whichever size it was found at, so the pose comes straight out of the fit.

A camera frame is described at two sizes for the same reason and one more: a frame that is slightly out of focus moves detail down the scale the way distance does. Descriptors are matched with a ratio test and a mutual best check, and the pose is fitted by RANSAC over a normalised direct linear transform, which expects a share of the matches to be confidently wrong.

Recognition is measured against known mappings rather than asserted. Artwork is warped by a homography the test chose, located, and the four corners of the artwork are checked against where that mapping puts them: under 4 px square on, under 6 px turned on its side, under 8 px held at an angle, and it is still found through two passes of blur.

### Measuring whether a change to it helps

```
$ node packages/vision/bench/recognition.mjs

  3 images x 21 conditions = 63 trials
  found means a pose whose worst artwork corner is within 25 px of the truth

  scale 0.45             #################### 3/3
  rotated 135            #################### 3/3
  noise 30               #############....... 2/3
  worst case             #######............. 1/3
  ...
  found            60 of 63 (95.2%)
  wrong pose taken 0
  corner error     median 1.10 px, mean 1.28 px
```

Pass it a folder of artwork and it uses that as well. Ten real pieces are worth far more than the generated ones.

This exists because descriptor quality and recognition are not the same thing, and it is easy to improve the first and report it as the second. A change to the descriptor's sampling pattern once measured better on every quality figure taken, bit balance, dead bits, and the distance between distinct features, and moved recognition by four trials in 336. The matcher applies a ratio test, a mutual best check, a 72 bit ceiling and a ten inlier floor, and those absorb descriptor quality before it reaches a decision. Run this before and after any change to detection, description, matching or pose fitting, and compare the two numbers rather than one.

## Showing something on a print

`examples/postcard` is the whole path in one directory: a hand written manifest, the artwork it names, and a page that opens the camera and puts content on that artwork when it finds it. Its README has the three commands, and a test runs them and opens the page, because an example nobody drives is a claim rather than an example: driving it turned up a fallback pointing at a placeholder domain, which sent a reader off the page the moment they refused the camera.

```js
await mountExperience({
  manifest,
  targets: [target],
  container: document.querySelector("#scene"),
});
```

The container ends up holding the camera picture with one element per target over it, each carrying the pose as a CSS transform, so a frame where nothing is found costs one hidden attribute rather than a rebuild. Content is only taken away after several consecutive misses, because recognition is per frame and one frame without a find is ordinary. A refused camera is told apart from a missing one, and the manifest's fallback is followed when the camera will not open at all.

Recognition runs in a worker, and drawing and recognition are separate loops. Finding artwork in a frame costs tens of milliseconds on a desktop, several times over what a display gives you for a frame, and on the page's own thread that is time where the camera preview does not repaint and nothing the viewer touches responds. Drawing follows the display and runs every frame from the last known pose; recognition runs as often as it can finish and drops the frames that arrive meanwhile, because a queue would only build a backlog of poses for positions the print has already left. Where a browser will not give a worker, recognition falls back to the page's thread, since a runtime that stops working without one is worse than a runtime that runs slowly.

What a call costs is measured rather than asserted. `packages/runtime/bench/cost.mjs` drives the compiled example in Chromium at 480 by 360; on the desktop this was written on, two runs of 41 calls gave medians of 49 ms and 73 ms, with individual calls between 22 ms and 168 ms. Read the spread rather than the median: one call is several display frames long and varies by a factor of eight, which is the whole reason drawing does not wait for it. On a phone it is unmeasured, like everything else in the device matrix. What the tests assert is not the timing. They assert that recognition is on a worker, because the fallback to the page's thread is quiet, and that the page's own frame median stays under 40 ms while recognition runs, which the run this was written from printed as 16.7 ms over 90 frames. A count of frames over 100 ms was asserted alongside it and was removed: it failed when another test file started a browser beside it, which measures the machine and not this code.

## Publishing something that outlives us

A printed thing can last decades. The service that served its experience does not have to.

```
$ node packages/bundler/dist/cli.js examples/postcard/manifest.json     --target front=front.target.json --out dist/postcard

  8 files written to dist/postcard
  overlay.svg -> assets/64b7fbcbc479e0c4.svg (428 bytes)

  Serve that folder over HTTPS or from localhost. It needs nothing else.
```

What comes out is a folder: an entry page, the manifest rewritten to point at what was copied, the compiled targets, the assets under names taken from their own content, the runtime carried in rather than linked, and one marker file. The runtime is about 45 KB across three files that share one chunk, which matters because the person fetching it has just scanned something printed and is probably on a phone. The marker is what makes republishing safe: publishing empties a folder only when this tool wrote it, so pointing `--out` at the wrong directory is refused by name rather than acted on. Nothing in it reaches for the network.

That is a claim, so it is tested as one. A test serves the folder from a plain static server with nothing else running, drives it in a real browser against a synthetic camera, and waits for it to find the artwork. It fails on any request that leaves the origin and on any request the folder cannot answer. A second test reads every file the bundle ships and refuses an absolute address in any of them.

Content addressing is why republishing an experience whose video did not change does not invalidate that video, and why the same file is never stored twice. Paths in a manifest are resolved against the manifest's own directory and refused if they leave it: publishing runs with the rights of whoever publishes, and a manifest is a format other people write.

An SVG carrying a script element, an event handler, a `javascript:` link or a `foreignObject` is refused by name. An SVG is a document rather than a picture, and although the runtime loads content through an `img` element and would run none of it, the file also sits at its own address in the bundle, where a browser opening it directly would. A bundle is meant to be served by any static host, including one that sets no headers, so this cannot be left to the host. It is refused rather than stripped, because stripping publishes a drawing nobody drew.

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

**Conformance is tested, not claimed.** Every test is named with the requirement it checks, quoted from the conformance criteria GS1 publishes alongside its resolver test suite, and each one drives a real resolver over HTTP. They fail a pull request. GS1's own suite is a browser tool with a PHP helper that runs against a deployed resolver, so it is not something a build can run; pointing it at a deployment is a separate exercise from proving the behaviour on every commit.

**Compressed Digital Link URIs are not supported.** That is a SHALL in the standard. It is declared in the resolver description file at `/.well-known/gs1resolver`, where a client would look for it, and there is a test asserting it is declared. A resolver that claims conformance it does not have is worse than one that says where it stops.

The link table is plain JSON keyed by canonical Digital Link paths, which is the continuity promise in the same form the bundler makes it. A redirect table that cannot be read out and rehosted somewhere else is not a promise.

## Doing all of that without a terminal

The console is the same path with a page in front of it: artwork in, a print verdict, a published bundle, and a code pointed at it.

```
$ node apps/console/dist/cli.js ./workspace --port 4000

  taggant console on http://127.0.0.1:4000
  workspace   X:\tmp\taggant-demo\workspace (0 experiences)
  publishing  X:\tmp\taggant-demo\bundles
  link table  X:\tmp\taggant-demo\links.json
```

**It has no database.** An experience is a manifest plus the files it names, which is what the bundler already consumes, so the workspace is a directory with one folder per experience holding its manifest, its artwork, its media and its compiled targets. Publishing is the bundler pointed at that folder. A project whose argument is that a bundle and a link table can be lifted and rehosted somewhere else cannot keep its own authoring state somewhere the operator has to ask for it back.

**The schema is the gate on publishing, not on saving.** A manifest has to have a target, and a target has to have content, which is right for something that gets published and wrong for something being built up over an afternoon. So what is on disk is always the format and the page says what is still missing, in words rather than in JSON pointers, until the moment it can be published.

**It has no authentication, and it binds to the loopback address.** Everything it does, it does with the rights of whoever started it: it writes files, it runs the compiler, and it replaces the link table every printed code depends on. Binding it anywhere else prints a warning, and it is not in the default container stack.

The one screen worth describing is the verdict. It says whether the artwork is ready for press and how wide to print it, and the measurement behind that sentence is there underneath rather than instead of it. It also compares the width the artwork needs against the width the manifest says it will be printed at, and says so when the second is smaller than the first, which is the mistake that a press run makes permanent.


## Running it

Two containers and nothing else:

```
docker compose -f infra/compose.yaml up --build
```

The resolver answers Digital Link requests from a mounted table. A plain static host serves published bundles and knows nothing about Digital Links, GS1, or this project. A scan reaches the first and is sent to the second.

The console is a third, and it is not one of the two because it is the only one that writes. It starts on request:

```
docker compose -f infra/compose.yaml --profile authoring up --build
```

Its port is published on the loopback address only, which is the whole of the protection rather than a precaution alongside one. The three of them share two directories and no interfaces: the console publishes into the folder the static host serves, and writes the table the resolver reads. Nothing calls anything.

The resolver's image is two stages, so what ships is the built service and a Node runtime: no package manager, no build tooling, no source. It runs as a user that is not root, read only, with no new privileges and every capability dropped, and answers a healthcheck from inside itself. Its link table is mounted rather than baked in, because the table is the one thing that changes without the code changing. An edit to it takes effect within a couple of seconds and without a restart, and a table saved half written leaves the last good one answering while `/readyz` reports 503 and says why, because dropping every link on the floor because somebody was mid-save is worse than serving the previous table for a few seconds.

That is a poll of the file rather than a watch on it, which is worth a sentence because the obvious version does not work. A watch bound to a path stops firing for good once the file is replaced by a rename, which is how anything that writes a file safely writes it, including this project's own console; and a bind mount frequently delivers no file events into a container at all. Both were measured against this stack, and both end the same way: the operator edits the table, the resolver keeps serving the old one, and nothing anywhere says so.

**The stack is driven on every push.** Continuous integration builds the image, publishes a real bundle into it, and runs sixteen checks over the whole path: a scan redirects rather than answering itself, carries the request's own query through, points at the static host rather than at the resolver, and says where the linkset is even while redirecting; the bundle is served and carries its runtime, its worker, its vision build and its manifest; the resolver counts what it answered; and a code nothing is assigned to is a 404 rather than a guess.

Then it stops the resolver and checks the bundle still serves. That is the continuity claim, and it is the difference between making it and testing it.

## What a scan is

Everyone who sells this kind of system counts scans and almost nobody says what one is, which is how two reports of the same week disagree by a factor of three. The definition is written down in `services/resolver/src/events.ts` and pinned by tests.

An answer about an identifier is a scan. A redirect is one, and so is a linkset. A HEAD is one, because clients follow links with it and excluding it undercounts silently. An identifier nothing is linked to is one, recorded as unresolved, and it is the most useful number here: it is how a code that was printed but never assigned gets found. A request that could not be read as a Digital Link is not a scan, because it never named an identifier.

Nothing identifying a person is recorded: no address, no user agent, no cookie. The language is kept, because it decides which link is chosen and a report that cannot explain its own redirects is not much of a report.

Events go out as one JSON object per line. `/metrics` carries the same counts in the text format Prometheus and its imitators read. `/healthz` says the process is up; `/readyz` says it has a table worth asking about, and answers 503 until it does.

## Design commitments

These hold for every release and are the reason the project exists in this shape.

- A published experience is a static bundle. It carries its own runtime and assets, and it does not call this project's services to work.
- The manifest format is open, versioned and [documented](packages/manifest/README.md), so anything else can read or write it. A manifest is data: it cannot carry a script destination, and its asset paths stay inside the bundle.
- Image targets first. Handheld web AR has no camera pose on every platform, and printed artwork is the trigger that works everywhere.
- No proprietary runtime dependency that cannot be redistributed.

## What has and has not been verified

The seven workspace projects are exercised by 341 tests, which is the number CI runs; a machine that cannot start all three browser engines runs fewer, and says which it skipped. The whole gate runs on every push, alongside a second job that stands the containers up and drives the path through them: once against a bundle published before they started, and once through the console from nothing at all.

The runtime is driven in a real browser rather than asserted: the artwork is drawn into a canvas sitting in a larger frame, that canvas is handed to the page as its camera, and the test waits for the page to reach its tracking state, then checks that the content landed where the frame actually put the artwork. A published bundle is driven the same way and in every engine, from a static folder with nothing else running, on artwork put through the real compiler first, which is the only place the two halves of the system meet. That is the artifact a viewer actually gets, so it is the one worth opening in more than one browser: the test watches every request the page makes, fails on anything that 404s or leaves the origin, and requires the content to land where the frame put the artwork, at the size it was tracked at, with something actually in it, and with the recognition off the page's thread. Feeding it a frame the artwork is not in fails it, which is how that was established to be a check on recognition rather than on the page loading; that was run by hand, and no standing test keeps it true.

What each engine covers is not the same, and saying so precisely is the point of this section.

Recognition happens in a module worker, and where a browser will not give one the runtime answers on the page's thread instead and says nothing about it, which on a phone shows up as the page freezing rather than as an error. That is driven through the runtime's own recogniser in all three engines, not through a copy of how it starts a worker: the test hands it a compiled target and a frame with the artwork at a known position, and checks where the artwork's corners come back. All three put them within a pixel of the right place, and all three report that the work happened off the page's thread. Safari was the reason to doubt this, module workers having arrived there late. Not serving the worker fails all three, which is how that assertion was established to be load-bearing rather than decorative; that too was run by hand.

The camera is asked for in every engine too, and no test asks any engine for a real one: `navigator.mediaDevices` is replaced before any page script runs, with a camera that returns a canvas the artwork has been drawn into, so there is nothing to fall through to. The launch flags and browser preferences that used to stand in for this are gone, because they do not replace anything: a flag or a preference that stops applying leaves a test passing while it films whoever ran it. A test checks that none of them comes back, and it names the file and the reason when one does.

**On the Linux runner the gate runs on, all three engines take the whole path**, in the runtime and again in a published bundle: a stream is obtained, the worker the runtime resolves for itself starts, recognition happens, and the content lands where the frame put the artwork. Nothing decides in advance which engines those will be. Whether an engine can use a canvas as a camera is not something a test can read off whether the two APIs exist, and a trial of its own turned out to be stricter than the runtime and to call an engine incapable that was not; so the stream is handed over as it is, the page settles on tracking or on an error, and the test reads which, with Chromium required to reach tracking so a regression in the runtime cannot be mistaken for an engine that cannot. On Windows, Playwright's WebKit build has no capture API at all, so there the same test checks the other branch: a camera the runtime cannot open has to be reported as an error state the page can show, rather than sitting on Starting for ever. What each engine did is printed on every run and attached to it.

Those per-engine lines are printed on every run and attached to it, because a run that fails on a runner and passes on a laptop is the one worth reading, and a green tick on its own cannot be told from a green tick over less. Frame pacing is measured in the same place, on the same canvas camera, because a runtime that finds the artwork and then stops painting is not working either.

Descriptors are compared across engines, because the compiler runs in Node and the runtime runs in a browser and the whole thing rests on them agreeing. That test runs the same artwork through Node and through every engine Playwright can start, which on a machine with all of them installed is Chromium, Firefox and WebKit, and requires every descriptor to match in each. It is not an argument from the source being shared: it once failed, over one unit in the last place of `Math.atan2`. On the last run, Chromium and WebKit each measured 63 of 356 feature angles differently from Node and produced identical descriptors anyway, which is what the angle quantisation is for; Firefox agreed outright. Those counts are printed rather than asserted, because they belong to the engine builds rather than to this project. Both sides load the same built file, so a package that was not rebuilt cannot present itself as an engine disagreement, and CI names the engines it requires so a browser that installs and then will not start fails the job instead of being skipped with a warning. A machine where none of them starts fails the file rather than passing it having compared Node against itself.

**Not verified: any real camera, and any real print.** Everything above is synthetic. The device matrix is empty and stays empty until it can be filled in with measurements, and the assumed camera resolving power in the print readiness report is an assumption until then.

## The project page

`site/` is a single page describing what this is, for people who have not cloned it. It is one file with no build step: open `site/index.html`, or serve the folder.

The numbers it shows under the lamp are this repository's own: they are what `packages/compiler` reports for `examples/postcard/artwork.png` at a 350 mm reading distance, and they are meant to be checked against it rather than admired.

Publishing it is a manual job on purpose. Turn on GitHub Pages with Actions as the source, then run the `pages` workflow from the Actions tab. It is not wired to `push`, because a repository with Pages turned off would fail that job on every commit and a red build that means nothing is worse than none. A manually run workflow is only offered on the default branch, so it appears there once this has landed on `main`.

## Working on it

Requires Node 22 and pnpm 11, which is pinned in `package.json`.

```
pnpm install
pnpm -r typecheck && pnpm check && pnpm -r build && pnpm -r test
```

There is no published package, so the command line runs from the build: `node packages/compiler/dist/cli.js <artwork>`.

`dev` is the integration branch and is where work lands first. `main` is the stable branch; nothing has been released to it yet.

## Licence

MIT. See [LICENSE](LICENSE).

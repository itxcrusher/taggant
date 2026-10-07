# taggant

Connect a printed object to a digital experience that outlives the platform serving it.

A taggant is a marker added to a material so that a later reader can identify it and verify it. This project does the same for printed things. Point a phone camera at a product pack, a label, a poster or a print, or scan the code on it, and the right content opens in the browser with nothing to install.

## Status

Early development. Every part of the path is usable and being built in the open. Nothing has been published to a registry and nothing is tagged, so interfaces change without notice.

## Judging artwork before it goes to press

A press run cannot be undone, so the question worth answering first is whether this artwork will track at the size and distance it will actually be used at. Both runs below are at the same scan distance, against files in this repository, and both outputs are copied from the terminal. Something checks that they still are.

```
$ node packages/compiler/dist/cli.js examples/postcard/artwork.png --scan-distance 190

  artwork.png
  size                  640 x 454 px
  tracking quality      100 / 100
  features              248, reaching 16 of 16 areas
  minimum print width   147 mm to be read from 190 mm away, putting at least 320 px across the artwork from left to right
  maps onto itself      no: the most one move carries onto look-alikes is 5 of its 548 places, and the lines are 20 places and 20 per cent of them
  recognised            at that size, every turn found it with 20 or more points agreeing at 5 of 5 widths, and with at least 50 at three of them, and no look put it in the wrong place
  verdict               ready for press

$ echo $?
0
```

Artwork that fails says why, and exits non-zero so a build can stop on it:

```
$ node packages/compiler/dist/cli.js examples/wordmark.png --scan-distance 190

  wordmark.png
  size                  640 x 480 px
  tracking quality      54 / 100
  features              55, reaching 8 of 16 areas
  minimum print width   not printable until it passes
  maps onto itself      no: the most one move carries onto look-alikes is 12 of its 153 places, and the lines are 20 places and 20 per cent of them
  recognised            not asked, for the reason below
  verdict               not ready
      too few features to track reliably

$ echo $?
2
```

Five things in there are worth reading carefully.

**Minimum print width says what it is derived from.** It is a resolution requirement, not a judgement of the design: the print has to fill enough of the picture, at that distance, to put enough pixels across the mark for the recogniser to find it, and the compiled target covers sizes from half the analysed width up to all of it. Artwork the recogniser finds at the smallest of those asks for least; the postcard in `examples/postcard` is found at 320 px across and so needs 147 mm at 190 mm. Artwork that does not pass gets no width at all, and the reason under the verdict says what would change that: the artwork, for most refusals, and the distance for one that would need a piece wider than a manifest can declare, which reads it from closer. Artwork the recogniser finds only near its own size gets a large width rather than a refusal: the recogniser does not need the whole mark in view, and a piece printed larger than the picture is read from further back, which puts the same pixels across the same mark.

**A design that repeats itself is refused before anything else is asked.** The same detail in two places is two features a matcher cannot tell apart, so a camera can settle on the wrong copy and draw the content on the wrong label. The compiler pairs every feature with the ones that look like it elsewhere on the artwork, at the sizes the target covers and at four smaller ones it describes the artwork at for this alone, and finds the one move of the whole artwork, a shift with any turn or change of size, that carries the most of them onto their look-alikes. A move that carries twenty places or more, and at least a fifth of all the places holding a feature, is a design repeating itself, and the line in the output names the move. Over 123 sheets of copies of the example postcard and of a generated design, at the export widths, gutters, margins and layouts tried, none carried under 105 places, or under 27 per cent of its places; over 198 pieces that repeat nothing, photographs and generated designs, none carried over 21 places, and where a piece had sixty or more places holding a feature, none carried over 12 per cent of them. Both lines are needed: that design at 21 places is past the first and is not refused, because it is at 4 per cent of its places. A small part of a design printed twice, a logo on a label, is not refused for it while the rest of the design carries most of its places: a fifth of the postcard's area copied elsewhere on it carries 11 to 15 per cent of its places over the eight placements tried, a quarter of a generated design's carries a seventh and was put in the right place in every one of 1200 looks, and an emblem drawn twice on a label whose words are set once carried 5 per cent. A label that is mostly words can be refused when one of them, or a line, is set twice, though the recogniser puts it in the right place: a brand word set twice in large type measured 0.25 to 0.26 at three exports, and in plain type 0.20 to 0.21 at two, each refused by the lines, while a probe that pointed the recogniser at both copies anyway found every look in the right place. Whether it is turns on how much of the label the repeated text is: other labels with a word or a line set twice measured 0.04 to 0.12, and were ready. A quarter of the postcard's area copied carries 13 to 21 per cent, and one of the eight placements crosses the line and is refused as repeating. The measure moves by a few hundredths with the size a design is exported at, so a design within that of a line can be refused at one export and pass at another: a label with one word set twice measured between 0.17 and 0.20 of its places over fifteen exports and was refused at one, though every look at it was in the right place. The line is not moved up to spare such a label, because designs near it can also be ones the recogniser misplaces: with the top 35 per cent of a generated design repeated at its bottom, the design measured 0.198, just under the line, and pointed at the repeat the recogniser put it in the wrong place in one look of 32, which refused it; with 40 per cent and more repeated it measured 0.26 and above, and is refused without a look, where looks would catch it only sometimes. Further under the line a large part is not refused by the lines at all, and the looks catch it only sometimes: with the top 30 per cent of the generated design repeated at its bottom, it measured 0.16 to 0.17 at four exports, and was refused at two of them and ready at the other two.

**A copy at another size is checked by pointing the recogniser at it.** A copy at a different size pairs with the original only at the sizes whose ratio is its own, so its move carries a fraction of its places and the lines need not catch it: the postcard beside a copy of itself at 60 per cent carries 61 of 458, past twenty places and well under a fifth of them. A camera brought close to the small copy sees what it would see of the original from further back, and settles on the original. So when the move carrying the most places carries twelve or more, the recogniser is pointed at both of its ends, the larger end at every size the target covers and the smaller end as much closer as the move's change of size, which is the camera brought close; one look in the wrong place refuses the design. A pointed look is in the wrong place when the artwork it found is off at the point it was pointed at, or is found at a size off by a factor of more than 1.15, turned more than 20 degrees, or mirrored: a camera settled on a copy near the middle of what it copies can be close to right at that one point and still see the copy's size. A copy at a third of the design's size or less holds few features, and its move, which only the smaller sizes the compiler adds can make, carries few places, so the move carrying the most among those is pointed at as well, from four places: of 198 pieces that repeat nothing, nine have such a move that reaches four, and the four of those otherwise ready for press were put in the right place in every look. Every copy tried of the postcard and of a generated design from three tenths to three quarters of its size, beside it, below it and turned beside it, was refused, by these looks where the lines had not refused it first, and so, in eighteen layouts each, was every copy of the postcard at 27 to 36 per cent of its size and of the generated design at 25 to 36, and every one of 24 at 27 to 36 per cent beside or below the postcard on a sheet with a white border of up to 300 px. A copy on the design itself is caught the same way: of 108, the postcard and the generated design each with a copy at a quarter to three quarters of its size at nine places on it, five are ready for press, two at a quarter of the postcard's size whose move carries two places and is not pointed at, and three at three quarters of the size where every look pointed at the copy found the artwork in the right place; of twelve copies turned on the postcard's middle, one is ready, at three fifths of its size turned 45 degrees, its looks the same. A mirrored copy is not paired at all, its details not matching the original's in mirror image, so nothing is pointed at it: the six tried, three tenths to three fifths of the postcard's size beside it and on its middle, are ready for press. Smaller copies get through: of eighteen layouts each, the postcard's copy at a quarter of its size passed in seven, at 22 per cent in fifteen and at a fifth in all eighteen, and the generated design's at 22 per cent in three and at a fifth in nine, the move only the smaller sizes make carrying fewer than four places in all but one of them, and in the layouts probed a camera brought close to such a copy was put on the original. Being pointed at is not the same as the copy being looked at: with a copy at 22 per cent above the postcard and 16 px from it, the move pointed at, four places at a scale of 0.357, had both its ends on the postcard, so no look went near the copy. And only those two moves are pointed at, so a design with a part repeated at its own size and also a copy at a size the target covers is pointed at whichever carries more.

**The width is only printed once the recogniser agrees with it.** The compiler puts the artwork in front of the recogniser at five widths around that size, one per cent apart, each turned four ways, and counts the points that agree on where it is. At most of those widths every turn has to find it with twenty agreeing, twice what the recogniser needs before it believes a pose at all, and no look may put it anywhere other than where it is; when the target covers a smaller size, no look there may either, because that is what a reader standing a little further off sees. The figure in the line is the middle of the five widths' worst turns: every turn at three of them found at least that many. The search starts at the smallest size the compiled target covers and stops at the first that passes, and artwork confirmed at no size is not ready, whatever its features and spread say. Five widths rather than one because the count moves from one pixel to the next: judged at a single width, chosen by the scan distance's arithmetic, a sheet of four identical designs was ready at 190 mm and not at 191. Looks in the wrong place were how a repeated design used to be refused, and they could not do it reliably: a design printed twice lands on the wrong copy in a few looks in a thousand at the size it passes, so whether twenty looks saw one turned on the export width, and the postcard printed twice was refused at six of seventeen widths and ready at the rest. They stay, for what the repetition check does not see. The simulation is the geometry and nothing else, with no lighting, focus, angle or paper, so it is the best case a phone will see, which is why the line is twice the floor rather than the floor. One exception: its frame is landscape, 480 by 360, and a phone held upright hands over a taller one, so a piece taller than it is wide is cropped more here than an upright reader would crop it, and its verdict is the verdict for a reader holding the phone sideways. Each look takes tens of milliseconds, 26 to 47 on an idle machine and two to four times that on a busy one, so a compile of the example takes a little over a second, and one pointed at a copy two to three and a half: twenty looks at the size that passes, more for artwork that is refused, and 32 or 64 more where a copy is pointed at.

The line is written out in full rather than as a bare figure in millimetres, because a bare figure under a filename reads as a measurement of the design and gets carried into a press setup as one.

**Score and verdict cannot disagree.** 60 is the pass mark exactly. Below it, the score says how far short the artwork falls; above it, how much headroom it has.

The number the report cannot yet measure is the field of view. Minimum print width assumes 60 degrees across the picture; a narrower lens makes every minimum smaller and a wider one makes them larger. A phone does not have one field, it has a long axis and a short one, and which lies across the picture depends on how the phone is held, so this is one number standing in for two and no device measurement stands behind it yet. The exposure is one-directional: a field wider than the assumption makes the true minimum larger than the printed one, so a print made to these widths is the one that fails. It is marked as an assumption in the source, and <https://itxcrusher.github.io/taggant/measure/> is the page that replaces it with a measurement from a real device.

What the sensor resolves does not enter into it, which is worth saying because it is not obvious. Recognition runs on a frame reduced to a fixed width, so a mark occupies the same fraction of that frame whatever the sensor behind it, and the pixels the matcher gets are that fraction times the reduced width. This was got wrong: the minimum was computed by dividing pixels the matcher needs by pixels a 1080p sensor has, which are different currencies with a reduction between them that appeared in neither the arithmetic nor the comment. Every width it printed was about four times too small, and a print made to one would not have been found at all.

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

`examples/postcard` is the whole path in one directory: a hand written manifest, the artwork it names, and a page that opens the camera and puts content on that artwork when it finds it. Its README has the four commands, and the compile step is run as a command by a test that then opens the page in a browser, because an example nobody opens is a claim rather than an example.

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
  overlay.svg -> assets/076e843f4723dc1c.png (47447 bytes)

  Serve that folder over HTTPS or from localhost. It needs nothing else.
```

What comes out is a folder: an entry page, the manifest rewritten to point at what was copied, the compiled targets, the assets under names taken from their own content, the runtime carried in rather than linked, and one marker file. The runtime is about 48 KB across three files that share one chunk, which matters because the person fetching it has just scanned something printed and is probably on a phone. The marker is what makes republishing safe: publishing empties a folder only when this tool wrote it, so pointing `--out` at the wrong directory is refused by name rather than acted on. Nothing in it fetches anything from the network. The one absolute address a bundle may hold is the `fallback` the manifest declares, which is a place to send a reader whose camera will not open rather than a resource the page loads, and it is there because the author wrote it.

That is a claim, so it is tested as one. A test serves the folder from a plain static server with nothing else running, drives it in a real browser against a synthetic camera, and waits for it to find the artwork. It fails on any request that leaves the origin and on any request the folder cannot answer. A second test reads every file the bundle ships and refuses an absolute address in any of them.

Publishing is also where the print verdict is held to. A target is published only if the runtime can read it and it holds features, and only with a print readiness report this build stands behind, that passed, and that is its own: the piece has to be declared at least as wide as the report's minimum width at the report's distance, and the report carries the fingerprint of the target it was written for, so a target carrying another design's report, or a report from an earlier build, is refused by name and the target asked to be compiled again. The tie is a check and not a signature: a report edited by hand until every figure, the fingerprint included, matches its target publishes, so a target file is only as trustworthy as whoever wrote it. Nor is a target tied to the artwork it was compiled from: a target file put by hand in another's place, compiled from other artwork and carrying its own report, is taken as that target's compile, and if its report passed, it is shown ready for press and published, though a camera pointed at the printed artwork finds nothing.

Content addressing is why republishing an experience whose video did not change does not invalidate that video, and why the same file is never stored twice. Paths in a manifest are resolved against the manifest's own directory and refused if they leave it: publishing runs with the rights of whoever publishes, and a manifest is a format other people write.

An SVG never ships as an SVG. It is rendered to a PNG at publish, and what lands in the bundle is pixels of the drawing. An SVG is a document rather than a picture: the runtime loads content through an `img` element and would run none of it, but the file also sits at its own address in the bundle, where a browser opening it directly runs whatever it says, and a bundle is meant to be served by any static host, including one that sets no headers. Two earlier versions of this bundler read the SVG and refused what looked dangerous in it, and twelve bypasses were found between them, from a namespace prefix on a script element to a UTF-16 encoding that made the whole file invisible to the check, and the second version still refused ordinary Inkscape and Illustrator exports. Rendering has none of that shape: the renderer has no script engine and no network stack and is handed a buffer with nowhere to resolve a reference to, and pixels cannot run or fetch. What it costs is that an overlay is a raster, rendered at 2048 px on its long side, which is several times what a phone shows. The renderer runs in a process of its own under a twenty-second clock, because a document can hold it for minutes with one filter and can crash it outright with another, and a publish has to answer either way. Text in an SVG is set in whatever font the publishing machine resolves the name to, so a file with lettering in it can land under a different name when published from a different machine; lettering kept as outlines renders the same everywhere, which is how the example overlay is drawn.

Every other asset is identified from its own bytes rather than its name, and passes through only if its signature is one of the image, video or audio formats the bundler publishes. Its extension in the bundle comes from those bytes too, so what a host serves it as and what a browser reads it as always agree. HTML under any extension, UTF-16 text, a gzipped file, a video container whose brand a browser would not play, and anything unrecognised are each refused by name, saying which. A bundle that asks somebody else's host for part of itself is not a bundle that outlives the service it came from, which is the whole claim, and a test feeds every hostile payload found against the earlier controls through a real publish and requires that nothing reaching the folder is served or sniffed as a document.

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

The table is checked when it is read, not when a code is scanned. A key not in its canonical form, a link without an href, a link type or a title, a link holding a field this format does not have, an href that is not an http or https address, or holds a space or a control character, a link type that is neither a GS1 term, a word after `gs1:` or `https://gs1.org/voc/`, nor an absolute URI outside that namespace in the characters a URI may hold, two defaults of one type, a title holding a control character, languages that are not a list of language tags, a media type that is not one, and a default that is not true or false are each refused in a sentence naming the entry; an optional field written as `null` is refused as the wrong type rather than read as left out. The resolver does not start on a table holding one of them; saved into the table of a running one, it leaves the last good table answering while `/readyz` reports 503 and says why. A table saved with a byte-order mark in front is read as though it had none. The resolver answers with the address a browser reads in an href, which is the one its redirect sends, so the linkset and the log carry that address too: `https://Example.com:443/a/../b` is published as `https://example.com/b`, a letter outside ASCII in a path or a zero-width space as its escape, and a host written in another script as the ASCII name it is looked up by. The table keeps the spelling it was written with.

## Doing all of that without a terminal

The console is the same path with a page in front of it: artwork in, a print verdict, a published bundle, and a code pointed at it.

```
$ node apps/console/dist/cli.js ./workspace --port 4000

  taggant console on http://127.0.0.1:4000
  workspace   X:\tmp\taggant-demo\workspace (0 experiences)
  publishing  X:\tmp\taggant-demo\bundles
  link table  X:\tmp\taggant-demo\links.json
```

**It has no database.** An experience is a manifest plus the files it names, which is what the bundler already consumes, so the workspace is a directory with one folder per experience holding its manifest, its artwork, its media and its compiled targets. Publishing is the bundler pointed at that folder, after compiling again any target that the runtime cannot read, that carries no report, or whose report this build does not stand behind or does not describe it: at the distance that report was compiled for, read from it or, where it no longer says, worked back out of its width, by this build's arithmetic where the report carries a recognition or a fingerprint and by the older build's where it carries neither, and at 150 mm where it gives none, and the notice says which it compiled and at what distance. A project whose argument is that a bundle and a link table can be lifted and rehosted somewhere else cannot keep its own authoring state somewhere the operator has to ask for it back.

**The schema is the gate on publishing, not on saving.** A manifest has to have a target, and a target has to have content, which is right for something that gets published and wrong for something being built up over an afternoon. So what is on disk is always the format and the page says what is still missing, in words rather than in JSON pointers, until the moment it can be published.

**It has no authentication, and it binds to the loopback address.** Everything it does, it does with the rights of whoever started it: it writes files, it runs the compiler, and it replaces the link table every printed code depends on. Binding it anywhere else prints a warning, and it is not in the default container stack.

**One console at a time per workspace and per link table.** Every file the console keeps, a manifest, an upload, a compiled target or the link table, is written beside itself and renamed into place, and writes to one experience or one table are queued behind each other, so there is no window in which one is half written. None of that survives a second console in another process: both read the file, both decide what the next version of it is, and one of the two edits is gone with both operators told it was saved. So a console takes a lock when it starts, one in the workspace and one beside the link table, and refuses to open either one another console holds, naming the process and the lock file. A running console touches its locks every five seconds, and checks them before every write it makes: a console whose lock another has taken says so and writes nothing more. A lock naming a process that is running on this machine is never taken, however long since it was touched, because a console stopped with Ctrl+Z, held by a debugger or busy for a moment stops touching its lock without stopping. A lock touched in the last twenty seconds is refused. Anything else, from another machine, a container, or a console that stopped without cleaning up, is watched for seven and a half seconds and taken over only if nothing touches it, with the takeover printed, so a running console whose clock disagrees with this one keeps its lock; a lock naming the very process and host that is starting, which is what a container restarted after an unclean stop finds, is watched the same way. Paths are compared as the filesystem names them, so a table reached through a short name, a junction or a link is still one table. The publish folder has no lock, because the static host serves everything in it: a published experience is replaced by renames, so two publishes of one experience that reach the swap together leave one version live and whole, and the operator whose publish lost is told so. Two that finish one after the other are both published, and the later one is live.

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

An answer about an identifier is a scan. A redirect is one, and so is a linkset. A HEAD is one, because clients follow links with it and excluding it undercounts silently. A request the table has no link to answer with is one, recorded as unresolved: an identifier nothing is linked to, a link type its links do not have, or no default when no type was asked for. Of those, an identifier with nothing linked to it or further up its hierarchy is how a code that was printed but never assigned gets found. The count is of requests, which anyone can send, so it says which codes to look at rather than how many people looked. A request that could not be read as a Digital Link is not a scan, because it never named an identifier.

Nothing about whoever scanned is recorded: no address, no user agent, no cookie. The identifier is the code's own, though, and a code can name a person, as `SECURITY.md` says, so a log of scans holds whatever its codes name. The language is kept, because it decides which link is chosen and a report that cannot explain its own redirects is not much of a report.

Events go out as one JSON object per line. `/metrics` carries the same counts in the text format Prometheus and its imitators read. `/healthz` says the process is up; `/readyz` says it has a table worth asking about, and answers 503 until it does.

## Design commitments

These hold for every release and are the reason the project exists in this shape.

- A published experience is a static bundle. It carries its own runtime and assets, and it does not call this project's services to work.
- The manifest format is open, versioned and [documented](packages/manifest/README.md), so anything else can read or write it. A manifest is data: it cannot carry a script destination, and its asset paths stay inside the bundle.
- Image targets first. Handheld web AR has no camera pose on every platform, and printed artwork is the trigger that works everywhere.
- No proprietary runtime dependency that cannot be redistributed.

## What has and has not been verified

The seven workspace projects are exercised by 627 tests, which is the number CI runs; a machine that cannot start all three browser engines runs fewer, and says which it skipped. One of them asserts a different thing on Windows and macOS than on Linux, because those two fold letter case in file names and Linux does not, and the right answer differs. Two more run only on Windows, which refuses to replace a file another program has open and drops a trailing dot from a new file's name; elsewhere they are reported as skipped. Worth knowing if a figure here is ever checked on two machines. The whole gate runs on every push, alongside a second job that stands the containers up and drives the path through them: once against a bundle published before they started, and once through the console from nothing at all. It is not a fast gate: `pnpm test` took 16 minutes on the laptop this was written on, with another job sharing the machine, and the compiler's package was 8 of those, because its tests compile real artwork, and every compile shows the recogniser at least twenty looks, 0.5 to 0.9 s of work on an idle machine, and a design pointed at 32 or 64 more, another 1.3 to 2.3 s. The bundler's took two and a half: three browser engines opening a published bundle and the measurement page, sixty or so SVG renders each in a separate process, and the recognition bench, run because the README quotes its output. The resolver's took two, and the rest is mostly the test runner's own startup, about half a minute a package. Each of those is a property chosen on purpose rather than an accident to be tuned away. `pnpm --filter @taggant/<name> test` runs one package while you work.

The runtime is driven in a real browser rather than asserted: the artwork is drawn into a canvas sitting in a larger frame, that canvas is handed to the page as its camera, and the test waits for the page to reach its tracking state, then checks that the content landed where the frame actually put the artwork. A published bundle is driven the same way and in every engine, from a static folder with nothing else running, on artwork put through the real compiler first, which is the only place the two halves of the system meet. That is the artifact a viewer actually gets, so it is the one worth opening in more than one browser: the test watches every request the page makes, fails on anything that 404s or leaves the origin, and requires the content to land where the frame put the artwork, at the size it was tracked at, with something actually in it, and with the recognition off the page's thread. Feeding it a frame the artwork is not in fails it, which is how that was established to be a check on recognition rather than on the page loading; that was run by hand, and no standing test keeps it true.

What each engine covers is not the same, and saying so precisely is the point of this section.

Recognition happens in a module worker, and where a browser will not give one the runtime answers on the page's thread instead and says nothing about it, which on a phone shows up as the page freezing rather than as an error. That is driven through the runtime's own recogniser in all three engines, not through a copy of how it starts a worker: the test hands it a compiled target and a frame with the artwork at a known position, and checks where the artwork's corners come back. All three put them within a pixel of the right place, and all three report that the work happened off the page's thread. Safari was the reason to doubt this, module workers having arrived there late. Not serving the worker fails all three, which is how that assertion was established to be load-bearing rather than decorative; that too was run by hand.

The camera is asked for in every engine too, and no test asks any engine for a real one: `navigator.mediaDevices` is replaced before any page script runs, with a camera that returns a canvas the artwork has been drawn into, so there is nothing to fall through to. The launch flags and browser preferences that used to stand in for this are gone, because they do not replace anything: a flag or a preference that stops applying leaves a test passing while it films whoever ran it. A test checks that none of them comes back, and it names the file and the reason when one does.

**On the Linux runner the gate runs on, all three engines take the whole path**, in the runtime and again in a published bundle: a stream is obtained, the worker the runtime resolves for itself starts, recognition happens, and the content lands where the frame put the artwork. Nothing decides in advance which engines those will be. Whether an engine can use a canvas as a camera is not something a test can read off whether the two APIs exist, and a trial of its own turned out to be stricter than the runtime and to call an engine incapable that was not; so the stream is handed over as it is, the page settles on tracking or on an error, and the test reads which, with Chromium required to reach tracking so a regression in the runtime cannot be mistaken for an engine that cannot. On Windows, Playwright's WebKit build has no capture API at all, so there the same test checks the other branch: a camera the runtime cannot open has to be reported as an error state the page can show, rather than sitting on Starting for ever. What each engine did is printed on every run and attached to it.

Those per-engine lines are printed on every run and attached to it, because a run that fails on a runner and passes on a laptop is the one worth reading, and a green tick on its own cannot be told from a green tick over less. Frame pacing is measured in the same place, on the same canvas camera, because a runtime that finds the artwork and then stops painting is not working either.

Descriptors are compared across engines, because the compiler runs in Node and the runtime runs in a browser and the whole thing rests on them agreeing. That test runs the same artwork through Node and through every engine Playwright can start, which on a machine with all of them installed is Chromium, Firefox and WebKit, and requires every descriptor to match in each. It is not an argument from the source being shared: it once failed, over one unit in the last place of `Math.atan2`. On the last run, Chromium and WebKit each measured 63 of 356 feature angles differently from Node and produced identical descriptors anyway, which is what the angle quantisation is for; Firefox agreed outright. Those counts are printed rather than asserted, because they belong to the engine builds rather than to this project. Both sides load the same built file, so a package that was not rebuilt cannot present itself as an engine disagreement, and CI names the engines it requires so a browser that installs and then will not start fails the job instead of being skipped with a warning. A machine where none of them starts fails the file rather than passing it having compared Node against itself.

**Not verified: any real camera, and any real print.** Everything above is synthetic. The device matrix is empty and stays empty until it can be filled in with measurements, and the assumed camera resolving power in the print readiness report is an assumption until then.

## The project page

`site/` is a single page describing what this is, for people who have not cloned it. It is one file with no build step: open `site/index.html`, or serve the folder, or read it at <https://itxcrusher.github.io/taggant/>.

The numbers it shows under the lamp are this repository's own: they are what `packages/compiler` reports for `examples/postcard/artwork.png` at a 190 mm reading distance, and they are meant to be checked against it rather than admired.

It is published at **<https://itxcrusher.github.io/taggant/>**, and publishing it is a manual job on purpose: run the `pages` workflow from the Actions tab. It is not wired to `push`, because a page that is one file with no build step does not need rebuilding on every commit, and a job that can fail for reasons nothing in the repository controls is a red build that means nothing.

## Working on it

Requires Node 22 and pnpm 11, which is pinned in `package.json`.

```
pnpm install
pnpm -r typecheck && pnpm check && pnpm -r build && pnpm -r test
```

There is no published package, so the command line runs from the build: `node packages/compiler/dist/cli.js <artwork>`.

`dev` is the integration branch and is where work lands first. `main` is the stable branch; nothing has been released to it yet.

Two environment variables decide what a run is not allowed to skip, and both are empty unless set:

| | |
|---|---|
| `TAGGANT_REQUIRE_ENGINES` | browser engines that must start. A run without one of them fails rather than quietly covering fewer. |
| `TAGGANT_REQUIRE_CAMERA` | engines that must get all the way from a camera to content on the artwork, rather than reporting that they could not open one. |

CI sets both to `chromium,firefox,webkit`, which is what earns the claims above. They are separate because they are different properties and the second one belongs to the platform: the same WebKit build has a working capture API on Linux and none at all on Windows, so `chromium,firefox,webkit` for the first and `chromium,firefox` for the second is the honest setting there. Chromium is held to the camera path everywhere regardless.
## Licence

MIT. See [LICENSE](LICENSE), declared in every package's own manifest as well. What the packages depend on, and under which licences, is in [THIRD-PARTY-LICENCES.md](THIRD-PARTY-LICENCES.md), compared against the installed tree by a test. How to report a vulnerability, what each shipped part is and is not responsible for, and what each one collects, keeps and sends, which is a camera frame that is never stored and one log line per scan holding no address, is in [SECURITY.md](SECURITY.md).

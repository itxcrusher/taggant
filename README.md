# taggant

Connect a printed object to a digital experience that outlives the platform serving it.

A taggant is a marker added to a material so that a later reader can identify it and verify it. This project does the same for printed things. Point a phone camera at a product pack, a label, a poster or a print, or scan the code on it, and the right content opens in the browser with nothing to install.

## Status

Early development. Two packages are usable, the rest are being built in the open. Interfaces change without notice until a first tagged release.

## Judging artwork before it goes to press

```
$ npx taggant-compile pack-front.tif --scan-distance 400

  pack-front.tif
  size                  900 x 650 px
  tracking quality      100 / 100
  features              500, covering 100% of the artwork
  minimum print width   40 mm
  verdict               ready for press
```

A press run cannot be undone, so the question worth answering is whether this artwork will track at the size and distance it will actually be used. Artwork that fails says why, and exits non-zero so a build can stop on it:

```
  flat.png
  tracking quality      11 / 100
  features              4, covering 25% of the artwork
  minimum print width   90 mm
  verdict               not ready
      too few features to track reliably
      features are concentrated in part of the artwork
```

The minimum print width grows with the scan distance, because a camera further away resolves fewer pixels across the same mark.

## Packages

| Package | State | Purpose |
|---|---|---|
| `@taggant/manifest` | usable | the versioned experience format, its validator, and types generated from the schema |
| `@taggant/compiler` | usable | artwork to compiled target, with a print readiness report, as a library and a command line |
| `@taggant/runtime` | next | camera, recognition, tracking and rendering in the browser |
| `@taggant/bundler` | planned | an experience compiled to a self-contained static folder |
| `services/resolver` | planned | code lifecycle and GS1 Digital Link resolution |
| `apps/console` | planned | authoring for products, artwork versions, targets and codes |

## Design commitments

These hold for every release and are the reason the project exists in this shape.

- A published experience is a static bundle. It carries its own runtime and assets, and it does not call this project's services to work.
- The manifest format is open, versioned and documented, so anything else can read or write it.
- Resolver conformance is proven against the published GS1 Digital Link test suite in continuous integration, not asserted in prose.
- Image targets first. Handheld web AR has no camera pose on every platform, and printed artwork is the trigger that works everywhere.
- No proprietary runtime dependency that cannot be redistributed.

## Working on it

Requires Node 22 and pnpm 11.

```
pnpm install
pnpm -r typecheck && pnpm check && pnpm -r test && pnpm -r build
```

`main` holds released, stable work. `dev` is the integration branch and is where work lands first.

## Licence

MIT. See [LICENSE](LICENSE).

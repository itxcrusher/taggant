# taggant

Connect a printed object to a digital experience that outlives the platform serving it.

A taggant is a marker added to a material so that a later reader can identify it and verify it. This project does the same for printed things. Point a phone camera at a product pack, a label, a poster or a print, or scan the code on it, and the right content opens in the browser with nothing to install.

## Status

Early development. Nothing is released yet, and the packages described below are being built in the open. Interfaces will change without notice until a first tagged release.

## What it does

- **Recognises printed artwork through the camera** and renders content anchored to it: video, 3D models, images and image sequences.
- **Resolves printed codes** through an implementation of the GS1 Digital Link standard, so one code on a product can serve different content over the product's life without reprinting.
- **Judges artwork before it goes to press**, reporting how well a design will track, the minimum size it can be printed at for a given scan distance, and whether it collides with others in the same catalogue.
- **Publishes self-contained bundles.** Every published experience is a static bundle that runs on any HTTPS host with every service in this project switched off.
- **Runs on your own infrastructure.** The deployment is part of the project, not an afterthought.

## Scope

| Package | Purpose |
|---|---|
| `packages/manifest` | the versioned, documented format describing what a physical thing points at, with schema, validator and types |
| `packages/target-compiler` | turns print artwork into a tracking target and a quality and print-size report, as a library and a command line tool |
| `packages/runtime` | the browser runtime: camera handling, recognition, tracking, rendering and content behaviour |
| `services/resolver` | code lifecycle and GS1 Digital Link resolution, with fallback destinations and scan events |
| `apps/console` | authoring and management for products, artwork versions, targets, experiences and codes |
| `infra` | containers, infrastructure as code, pipelines and observability |

## Design commitments

These hold for every release and are the reason the project exists in this shape.

- A published experience is a static bundle. It carries its own runtime and assets, and it does not call this project's services to work.
- The manifest format is open, versioned and documented, so anything else can read or write it.
- Resolver conformance is proven against the published GS1 Digital Link test suite in continuous integration, not asserted in prose.
- Image targets first. Handheld web AR has no camera pose on every platform, and printed artwork is the trigger that works everywhere.
- No proprietary runtime dependency that cannot be redistributed.

## Requirements

Node.js 22 or later. Additional requirements per package are documented alongside each one as it lands.

## Branches

`main` holds released, stable work. `dev` is the integration branch and is where work lands first.

## Licence

MIT. See [LICENSE](LICENSE).

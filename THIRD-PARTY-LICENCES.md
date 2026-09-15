# Third-party licences

What this repository depends on to run, by package, with each dependency's licence. Development-only tooling (the test runner, the type checker, the formatter, the browsers Playwright drives) is not listed: it does not ship and does not run for anyone but a contributor.

A test compares this file against the installed tree and fails when a dependency is added, removed or changes licence without the file changing (`packages/bundler/test/third-party-licences.test.ts`).

## What ships inside a published bundle

Nothing from outside this repository. The runtime a bundle carries is built from `packages/runtime` and `packages/vision`, and neither has a dependency outside the workspace. A test reads every file a bundle ships and refuses an address on another host; that is the same property from the other side.

## What runs where

| Package | Depends on | Licence | Where it runs |
|---|---|---|---|
| `@taggant/vision` | nothing | | in the browser, inside a bundle, and in the compiler |
| `@taggant/runtime` | workspace packages only | | in the browser, inside a bundle |
| `@taggant/resolver` | nothing | | as a service, in a container or on a host |
| `@taggant/manifest` | `ajv` 8.17.1 | MIT | wherever a manifest is validated: the compiler, the bundler and the console. Not the runtime, which reads a manifest the bundler already validated |
| | `ajv-formats` 3.0.1 | MIT | with `ajv` |
| `@taggant/compiler` | `sharp` 0.33.5 | Apache-2.0 | on the machine that compiles artwork, and nowhere else. Decodes and rescales print files |
| `@taggant/bundler` | workspace packages only | | on the machine that publishes |
| `@taggant/console` | workspace packages only | | on the operator's machine or in their container |

## Everything `sharp` and `ajv` bring with them

Transitive dependencies of the two above, as installed. Versions are the ones in the lockfile.

| Dependency | Licence | Brought in by |
|---|---|---|
| `ajv` 8.17.1 | MIT | manifest |
| `ajv-formats` 3.0.1 | MIT | manifest |
| `fast-deep-equal` 3.1.3 | MIT | ajv |
| `fast-uri` 3.1.7 | BSD-3-Clause | ajv |
| `json-schema-traverse` 1.0.0 | MIT | ajv |
| `require-from-string` 2.0.2 | MIT | ajv |
| `sharp` 0.33.5 | Apache-2.0 | compiler |
| `@img/sharp-win32-x64` 0.33.5 | Apache-2.0 AND LGPL-3.0-or-later | sharp, on Windows; the equivalent platform package elsewhere |
| `color` 4.2.3 | MIT | sharp |
| `color-convert` 2.0.1 | MIT | color |
| `color-name` 1.1.4 | MIT | color-convert |
| `color-string` 1.9.1 | MIT | color |
| `simple-swizzle` 0.2.4 | MIT | color-string |
| `is-arrayish` 0.3.4 | MIT | simple-swizzle |
| `detect-libc` 2.1.2 | Apache-2.0 | sharp |
| `semver` 7.8.5 | ISC | sharp |

## The one licence worth a sentence

`sharp` links `libvips`, which is LGPL-3.0-or-later, through a prebuilt platform package. The LGPL applies to the library, is satisfied by dynamic linking, and reaches nothing in this repository. It runs only on the machine compiling artwork and ships to no reader. Nothing here modifies `libvips`.

## This repository

MIT, in [LICENSE](LICENSE), and declared as `"license": "MIT"` in every package's own manifest so that a registry or a scanner reading the metadata sees the same answer as a person reading the file.

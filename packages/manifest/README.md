# The experience manifest

A manifest describes one published experience: the physical thing it belongs to, the artwork a camera recognises, and what is shown once that artwork is found. It is the contract every other part of this project speaks. The compiler produces targets it names, the runtime renders it, the bundler publishes it, and the console edits it.

It is a plain JSON file. Nothing in it refers to a hosting service, and everything that affects rendering has a defined default, so a short manifest is short and a complete one is explicit.

## The shortest one that is valid

```json
{
  "schemaVersion": "1.0.0",
  "id": "botanica-500",
  "targets": [
    {
      "id": "front-panel",
      "source": "artwork/front.png",
      "physicalWidthMm": 62,
      "content": [{ "type": "video", "src": "media/pour.mp4" }]
    }
  ]
}
```

A manifest must name at least one target, and a target must show at least one thing. Both are deliberate: a manifest with nothing to recognise describes nothing, and a target that recognises artwork and then shows nothing is not an experience. The console holds drafts that are neither while somebody is still building one, and the format is what has to hold at the point it is published.

## A complete one

`examples/postcard/manifest.json`, which is the file the example actually runs from:

```json
{
  "schemaVersion": "1.0.0",
  "id": "postcard",
  "title": "Postcard",
  "subject": { "kind": "print", "reference": "A6 postcard, front" },
  "targets": [
    {
      "id": "front",
      "source": "artwork.png",
      "physicalWidthMm": 148,
      "content": [
        {
          "type": "image",
          "src": "overlay.svg",
          "placement": { "scale": 0.5, "offsetY": -0.2 }
        }
      ]
    }
  ],
  "fallback": "https://example.com/postcard"
}
```

## The document

| Field | | What it is |
|---|---|---|
| `schemaVersion` | required | The version this file is written to. `"1.0.0"` is the only value today. A reader that does not know a version refuses the file rather than guessing at what changed between them. |
| `id` | required | Identifies the experience. It becomes the name of the folder a published bundle is written to, and so part of the address that folder is served from. Once a code carrying that address has been printed, the id is fixed. Lower case letters, digits and hyphens, three to sixty four characters. |
| `title` | | A name for people. Nothing renders it; it is what makes a list of manifests readable. |
| `subject` | | What physical thing the experience belongs to: `kind` is one of `product`, `print`, `artwork`, `other`, and `reference` is whatever the thing is called wherever it is already catalogued. **Nothing in this project reads it.** It is here so a manifest carries its own answer to what it is for, without a database alongside it to ask. |
| `targets` | required | The artwork a camera recognises. At least one. |
| `fallback` | | Where a scan goes when the experience cannot be shown at all, such as a browser that will not open a camera. Held to `http` and `https`: a manifest is authored data and must not be able to carry script into a browser. |

### A target

| Field | | What it is |
|---|---|---|
| `id` | required | Identifies the target within the experience. A compiled target file is matched to it by this name, so it is the one thing the compiler's output and this manifest have to agree on. Same shape as the experience id. |
| `source` | required | Path to the artwork this target was compiled from, relative to the manifest. Carried so the target can be built again from the thing it was made from, rather than from whoever remembers which file it was. |
| `physicalWidthMm` | required | How wide the artwork is on the finished piece, in millimetres. **This is the number the print readiness report is measured against.** The compiler says the smallest width the artwork can still be read at from a stated distance; a piece printed narrower than that will not be recognised, whatever else is right about it. |
| `content` | required | What is shown when the target is found. At least one. |

### A piece of content

| Field | | What it is |
|---|---|---|
| `type` | required | `image`, `video`, `model` or `audio`. **Only `image` and `video` are rendered today.** `model` and `audio` are part of the format and are not built; a runtime that meets one names it rather than dropping it in silence, because an author who asked for a model and sees nothing needs to know it is the build and not their file. |
| `src` | required | Path to the asset, relative to the manifest. Relative by design: a published experience is a self-contained folder, so an absolute URL would make it depend on a host that can go away. Parent directory steps and any scheme are refused, because the path is resolved against a bundle directory. |
| `placement` | default `{}` | Where it sits on the target. Left out, it covers the target exactly. |
| `autoplay` | default `true` | Whether a video starts on its own once the target is found. |
| `loop` | default `true` | Whether a video starts again when it reaches the end. |
| `muted` | default `true` | Muted because no browser will autoplay a video with sound. Set `autoplay` to `false` to let a viewer start it with sound themselves. |

### Placement

Everything here is relative to the target and nothing is in pixels. The target is a physical thing whose size in the frame changes every time the viewer moves, so a pixel would mean something different in every frame.

| Field | default | What it is |
|---|---|---|
| `scale` | `1` | Size as a fraction of the target. `1` covers the target exactly; `0.5` is half its width and half its height. |
| `offsetX` | `0` | How far across from the centre of the target, as a fraction of the target's width. `0.5` is half a target width to the right. |
| `offsetY` | `0` | How far down from the centre, as a fraction of the target's height. Positive is down. |
| `rotationDeg` | `0` | Rotation about the content's own centre, in degrees, clockwise, in the plane of the artwork. |

So the postcard's `{ "scale": 0.5, "offsetY": -0.2 }` puts an overlay half the size of the postcard, a fifth of the postcard's height above centre.

## Reading and writing one

```js
import { validateManifest, manifestSchema } from "@taggant/manifest";

const result = validateManifest(JSON.parse(text));
if (!result.ok) {
  for (const problem of result.errors) console.error(problem.path, problem.message);
} else {
  result.value; // every default filled in
}
```

Two things about that call. **Defaults are applied to the value it returns**, so every consumer sees the same complete shape rather than each deciding what `autoplay` means when it is absent. And **the input is never touched**: validation works on a copy, so reading a manifest does not rewrite the file somebody hand-wrote with a full set of defaults they did not type.

`manifestSchema` is the schema itself, exported so anything can validate a manifest without using this validator. It is JSON Schema 2020-12 and every field carries its own description, which is also where the generated TypeScript types get their documentation.

## What the format refuses, and why

- **No absolute asset URLs, no schemes, and no parent directory steps.** Assets are resolved against a bundle directory, and a self-contained bundle that reaches for a host somewhere else is not self-contained.
- **A fallback is `http` or `https` only.** It is a destination a browser navigates to, and a manifest is data somebody else may have written.
- **No unknown fields, anywhere.** The document, targets, content and placement are all closed. A misspelled field is a mistake worth hearing about rather than a value silently ignored.

## Versions

`schemaVersion` is a value, not a range. A file says which version it was written to, and a reader that does not know that version refuses it. When there is a second version there will be a migration path between them and this document will describe it. There is one version today, so there is nothing to migrate.

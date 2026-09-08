# Running it

Everything here runs locally. Nothing in this directory provisions anything, spends anything, or needs an account.

```
docker compose -f infra/compose.yaml up --build
```

That gives two containers:

| | |
|---|---|
| `resolver` on `:8080` | answers Digital Link requests from `infra/links/links.json` |
| `bundles` on `:8081` | a plain static host serving whatever is in `infra/bundles/` |

There is a third, and it is not started by default:

```
docker compose -f infra/compose.yaml --profile authoring up --build
```

| | |
|---|---|
| `console` on `127.0.0.1:4000` | authoring: artwork in, a print verdict, a published bundle, a code pointed at it |

On Linux it has to run as somebody who can write the directories this checkout owns, which the image's own user is not:

```
TAGGANT_UID=$(id -u) TAGGANT_GID=$(id -g)   docker compose -f infra/compose.yaml --profile authoring up --build
```

Without that, every other container is healthy, the console starts and serves pages, and writing the link table fails with a permission error. Windows and macOS hide it, because their bind mounts do not carry ownership at all, so it appears first on a Linux host or in continuous integration, which is where it did appear.

It is the only one that writes, and it has no authentication of any kind. Its port is published on the loopback address and that is the whole of the protection rather than one precaution among several: anyone who can reach it can write files, run the compiler, and replace the link table every printed code depends on. It publishes into `infra/bundles/` and writes `infra/links/links.json`, which is to say it talks to the other two by leaving files where they look, and not otherwise.

The separation is the point rather than an arrangement of convenience. A scan reaches the resolver, the resolver redirects to a published bundle, and the bundle is served by something that knows nothing about Digital Links, GS1, or this project. Stop the resolver and every bundle already published keeps working; only the routing of new scans stops.

## Putting something in it

With the console, that is the whole of it: open `http://127.0.0.1:4000`, give the experience an id, upload the artwork, compile it, add what it should show, publish, and register a code. What follows is the same thing from a terminal.

```
node packages/compiler/dist/cli.js examples/postcard/artwork.png \
  --id front --scan-distance 350 --out front.target.json

node packages/bundler/dist/cli.js examples/postcard/manifest.json \
  --target front=front.target.json --out infra/bundles/postcard
```

Then point a link at it, in `infra/links/links.json`:

```json
{
  "href": "http://localhost:8081/postcard/",
  "linkType": "gs1:pip",
  "title": "Postcard",
  "default": true
}
```

## What the containers do and do not have

The resolver runs as a user that is not root, read only, with no new privileges and every capability dropped. It carries no package manager, no build tooling and no source: the build stage has the workspace and the runtime stage has the output. Its link table is mounted rather than baked in.

The console runs as a user that is not root, with no new privileges and every capability dropped, and as the uid the command line gives it rather than the image's own. It is not read only, because writing is its job: the workspace it authors into, the folder it publishes to and the link table are all mounted, and none of them is in the image. It is larger than the resolver because it compiles artwork, and that means a native image library.

## Checking it

`smoke.mjs` drives a bundle that was published before the containers started: fifteen checks over the whole path a scan takes. `authoring-smoke.mjs` starts from nothing instead, and needs the authoring profile up: it has the console create an experience, compile real artwork inside the container, publish, and point a code at it, then checks that the static host serves the new bundle and the resolver answers the new code without being restarted or told.

That last check is why the file exists. The resolver used to notice a changed link table with a watch on the file, and a watch dies the moment the file is replaced by a rename, which is how the console writes and how most things that write a file safely write it; a bind mount also often delivers no file events into a container at all. Both were measured here. Everything else stayed green: readiness said ready, the table on disk was correct, and scans went on being answered from the table the process had at boot.

## What it tells you while it runs

One JSON object per line on standard output, which is the format every log collector reads without being configured. A scan looks like this:

```json
{"type":"scan","at":"2026-09-08T09:43:08.795Z","identifier":"/01/09520123456788","outcome":"redirect","target":"https://example.com/product?utm=pack","tookMs":7.9}
```

`/metrics` carries the same counts in the text format Prometheus and everything imitating it reads. `/healthz` says the process is up. `/readyz` says it has a table worth asking about and answers 503 until it does, which is the thing to wait on before sending traffic, because a resolver with no links answers every scan with a 404.

**What a scan is** is written down in `services/resolver/src/events.ts` and pinned by tests. Everyone selling this kind of system counts scans and almost nobody says what one is, which is how two reports of the same week disagree by a factor of three. Briefly: an answer about an identifier is a scan, including a linkset, and including an identifier nothing is linked to; a request that never named an identifier is not one, because there is nothing to count it against.

Nothing identifying a person is recorded: no address, no user agent, no cookie. The language is kept, because it decides which link is chosen and a report that cannot explain its own redirects is not much of a report.

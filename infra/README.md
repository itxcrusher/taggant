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

The separation is the point rather than an arrangement of convenience. A scan reaches the resolver, the resolver redirects to a published bundle, and the bundle is served by something that knows nothing about Digital Links, GS1, or this project. Stop the resolver and every bundle already published keeps working; only the routing of new scans stops.

## Putting something in it

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

## What it tells you while it runs

One JSON object per line on standard output, which is the format every log collector reads without being configured. A scan looks like this:

```json
{"type":"scan","at":"2026-09-08T09:43:08.795Z","identifier":"/01/09520123456788","outcome":"redirect","target":"https://example.com/product?utm=pack","tookMs":7.9}
```

`/metrics` carries the same counts in the text format Prometheus and everything imitating it reads. `/healthz` says the process is up. `/readyz` says it has a table worth asking about and answers 503 until it does, which is the thing to wait on before sending traffic, because a resolver with no links answers every scan with a 404.

**What a scan is** is written down in `services/resolver/src/events.ts` and pinned by tests. Everyone selling this kind of system counts scans and almost nobody says what one is, which is how two reports of the same week disagree by a factor of three. Briefly: an answer about an identifier is a scan, including a linkset, and including an identifier nothing is linked to; a request that never named an identifier is not one, because there is nothing to count it against.

Nothing identifying a person is recorded: no address, no user agent, no cookie. The language is kept, because it decides which link is chosen and a report that cannot explain its own redirects is not much of a report.

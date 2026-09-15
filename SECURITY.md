# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). It reaches the maintainer without a public issue. Say what you found, how to reproduce it, and which package. A reply within seven days; a fix or a stated reason within thirty.

Do not open a public issue for something exploitable until it has been fixed and published.

## What this project is responsible for

Three things ship to people who did not build them, and each has a stated boundary.

**A published bundle** is a folder of static files that any host serves as-is, including one that sets no headers. Every asset in it sits at its own address on the host's origin, so the bundler refuses anything a browser would run or fetch at that address: script elements, event handler attributes, `javascript:` links, `foreignObject`, and any reference to another host, checked by reading the document rather than by pattern (`packages/bundler/src/svg.ts`). HTML and XHTML assets are refused whole. Asset paths in a manifest are resolved against the manifest's own directory and refused if they leave it. The bytes the bundler checks are the bytes it writes. A test opens a published bundle in a real browser and fails on any request that leaves the origin (`packages/bundler/test/nothing-reaches-out.test.ts`).

**The resolver** answers GS1 Digital Link requests from a JSON table. It stores nothing: no database, no cookie, no address, no user agent. Scan events go to standard output as one line each, and counts on `/metrics` reset when the process does. Where a scan is sent comes only from the table. The one thing a request can influence is the subject URL in a linkset answer, which is `--origin` when set (the compose file sets it) and the `Host` header when not; with none set the resolver says so at start-up and tells the operator to set it before the service is reachable from anywhere.

**The console** binds to `127.0.0.1` by default and is meant to run on the operator's own machine or inside their own network. It has no accounts and no authentication, because it has no users other than the operator, and everything it does it does with the file-system rights of whoever started it. Given any other `--host` it prints a warning saying exactly that and then binds anyway, because binding it somewhere reachable is a decision and not one to make by leaving a flag at its default; the compose file binds it to `127.0.0.1:4000`. Uploads are content-addressed and the same SVG rules apply before anything is published.

## What it is not responsible for

- The host serving a bundle. A bundle is designed to be safe on a host that sets no headers, and a host that sets restrictive ones only helps.
- The camera. The runtime asks the browser for it and never records or transmits a frame; recognition runs in the page, on a worker, and nothing leaves the device.
- The link table's contents. The resolver redirects where the table says; whoever writes the table decides where scans go.

## The suite never opens a real camera

Every camera in the test suite is a canvas. `navigator.mediaDevices` is replaced on the instance and on `Navigator.prototype` before any page script runs, no browser is launched with a fake-device flag, and a test scans the tree for any such flag or permission grant (`packages/runtime/test/no-real-camera.test.ts`). A contributor's webcam does not turn on because they ran the tests.

## Dependencies

Listed with their licences in [THIRD-PARTY-LICENCES.md](THIRD-PARTY-LICENCES.md), and pinned by a test that compares that file against the installed tree. The runtime that ships inside a bundle carries no third-party code at all.

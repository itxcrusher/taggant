/**
 * The entry page for a bundle.
 *
 * Everything it references is relative and sits beside it. That is the whole point of a
 * bundle: it is served from a static host, which can be one inside a museum's own network
 * with nothing of this project running anywhere.
 *
 * Served, not opened. Double clicking the page off a USB stick does not work and cannot:
 * a browser refuses to load a module from a file:// origin, and the page sits saying
 * "Starting." with a CORS error in a console nobody has open. Any file server will do,
 * including one that comes with the operating system.
 *
 * The states are spelled out in the page rather than left to the runtime, because what a
 * person should be told when a camera is refused is a decision for whoever published the
 * experience, and this file is theirs to edit afterwards.
 */
export function entryPage(options: { title: string; targets: string[] }): string {
  const targets = JSON.stringify(options.targets);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      :root { color-scheme: dark; }
      html, body { margin: 0; height: 100%; background: #101014; color: #eff0fc; }
      body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      #scene { position: relative; width: 100vw; height: 100vh; }
      #status {
        position: fixed; left: 0; right: 0; bottom: 0; margin: 0; padding: 12px 16px;
        background: rgba(16, 16, 20, 0.9); border-top: 1px solid #2a2a34;
      }
      #scene[data-state="tracking"] + #status { color: #7fe0a8; }
      #scene[data-state="denied"] + #status,
      #scene[data-state="error"] + #status { color: #ff8f7a; }
    </style>
  </head>
  <body>
    <div id="scene"></div>
    <p id="status">Starting.</p>
    <script type="module">
      import { mountExperience } from "./runtime/index.js";
      import { fromTargetFile } from "./runtime/vision.js";

      const status = document.getElementById("status");
      const say = {
        idle: "Starting.",
        requesting: "Asking for the camera.",
        denied: "The camera was refused. Allow it for this page and reload.",
        error: "The camera could not be opened.",
        searching: "Point the camera at the printed artwork.",
        tracking: "Found it.",
      };

      // Anything that goes wrong before the experience mounts is told to the viewer.
      // Without this a file lost in a copy, which is the failure that actually happens,
      // leaves the page saying "Starting." forever with the reason only in the console.
      window.addEventListener("unhandledrejection", (event) => {
        status.textContent = "This experience could not be loaded: " + (event.reason?.message ?? event.reason);
      });

      const names = ${targets};
      // This manifest was validated when the bundle was written, and rewritten by the same
      // step that copied the files it names, so the page does not validate it again. The
      // validator is a Node dependency and shipping it would put one in the browser for no
      // gain.
      const load = async (path) => {
        const response = await fetch(path);
        if (!response.ok) throw new Error(path + " is missing from this bundle (" + response.status + ")");
        return response.json();
      };
      const [manifest, ...targetFiles] = await Promise.all([
        load("./manifest.json"),
        ...names.map((name) => load("./targets/" + name + ".json")),
      ]);

      window.taggantExperience = await mountExperience({
        manifest,
        targets: targetFiles.map(fromTargetFile),
        container: document.getElementById("scene"),
        options: {
          onStateChange: (state) => { status.textContent = say[state] ?? state; },
          onProblem: (message) => { status.textContent = message; },
        },
      });
    </script>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

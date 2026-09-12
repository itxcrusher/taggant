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
      const status = document.getElementById("status");
      const say = {
        idle: "Starting.",
        requesting: "Asking for the camera.",
        denied: "The camera was refused. Allow it for this page and reload.",
        error: "The camera could not be opened.",
        searching: "Point the camera at the printed artwork.",
        tracking: "Found it.",
      };

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
      // The manifest is read first and on its own, because its fallback is the only thing
      // that can help if anything after it fails.
      let fallback = null;
      let showing = null;
      const start = async () => {
        const manifest = await load("./manifest.json");
        if (typeof manifest.fallback === "string") fallback = manifest.fallback;
        // After the manifest, so that a runtime missing from a copied folder can still send
        // the viewer where the manifest says to send them. Importing it first meant the one
        // failure the fallback exists for was the one failure that could not reach it.
        const { mountExperience, fromTargetFile } = await import("./runtime/index.js");
        const targetFiles = await Promise.all(
          names.map((name) => load("./targets/" + name + ".json")),
        );
        window.taggantExperience = await mountExperience({
          manifest,
          targets: targetFiles.map(fromTargetFile),
          container: document.getElementById("scene"),
          options: {
            onStateChange: (state) => {
              // A problem outlives the state change that follows it. Every report the runtime
              // makes about the manifest or about recognition is immediately followed by a
              // state, and a state sentence written for a viewer would replace it in the same
              // task: the author was told that nothing is built for one of their targets and
              // then told to point a camera at it. Found artwork is the one thing that
              // supersedes it, because that is news worth having.
              if (state === "tracking") showing = null;
              status.textContent = showing ?? (say[state] ?? state);
            },
            onProblem: (message, kind) => {
              // Decided by what sort of problem it is, not by the state at the time. The
              // state was the wrong thing to look at: three of the runtime's five reports
              // happen before the state they belong to is set, so looking at it suppressed
              // manifest problems that should have shown and showed camera reasons that were
              // overwritten a moment later.
              //
              // A camera reason goes to the console, because this page has its own sentence
              // for that, written for whoever is holding the phone, and "would not start
              // playing within 10000 ms" is not it. Everything else is shown: the person
              // reading a manifest problem is usually the person who published it.
              if (kind === "camera") {
                console.warn(message);
                return;
              }
              showing = message;
              status.textContent = message;
            },
          },
        });
      };

      // Everything above runs inside this, rather than at the top of the module, and that
      // includes importing the runtime. A module that fails while it is being evaluated is
      // not something this page can catch: the listeners below are never reached, so the
      // viewer reads "Starting." for as long as they are willing to wait, with the reason
      // in a console they do not have, and the fallback is never followed. A static import
      // of the runtime module fails exactly that way, and a file lost while copying the
      // folder onto a host is the likeliest way for it to happen, so the import is inside
      // here too. A target this build cannot read was already caught; a missing runtime was
      // not, which was the difference between a comment and a check.
      //
      // The fallback is followed here for the same reason the runtime follows it when the
      // camera will not open. Somebody scanned a printed code; the manifest says where they
      // should go when the experience cannot be shown, and a bundle that cannot start is
      // exactly that case.
      const safe = (value) => {
        try {
          const url = new URL(value, location.href);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      };
      const failed = (reason) => {
        const message = reason?.message ?? String(reason);
        document.getElementById("scene").dataset.state = "error";
        status.textContent = "This experience could not be loaded: " + message;
        if (fallback && safe(fallback)) location.replace(fallback);
      };
      window.addEventListener("unhandledrejection", (event) => failed(event.reason));
      // And the other shape a failure arrives in, for anything that throws rather than
      // rejects. Registered before the startup below runs, which is the whole point.
      window.addEventListener("error", (event) => failed(event.error ?? event.message));
      start().catch(failed);
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

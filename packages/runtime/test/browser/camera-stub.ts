/**
 * A camera made of a canvas, installed before any page script runs.
 *
 * Every browser test that needs a camera uses this, and none of them asks an engine for a
 * real one. That is not a convenience. An earlier version of this work drove Firefox's
 * fake-device preference instead, and the only thing between the suite and a contributor's
 * webcam was a preference Firefox accepts whether or not it exists, beside a second one
 * removing the permission prompt. It opened a real camera once. `navigator.mediaDevices` is
 * replaced here, so there is no path to hardware in any preference or launch state.
 *
 * Because the canvas holds the artwork, the whole path runs rather than only its start: a
 * stream is obtained, the worker starts, recognition happens and content is placed.
 *
 * Pass it to `page.addInitScript(installCanvasCamera, base64OfAGrayscaleFrame)`. It is one
 * function, in one file, because two copies of it in two test files is how they drift.
 */
export function installCanvasCamera(encoded: string): void {
  const diagnostics = {
    called: 0,
    decoded: 0,
    captured: false,
    tracks: "",
    settings: "",
    redraws: 0,
    failure: "",
  };
  (window as unknown as { cameraDiagnostics: typeof diagnostics }).cameraDiagnostics = diagnostics;

  const capture = async (): Promise<MediaStream> => {
    diagnostics.called++;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      // Attached, because a detached canvas is a reasonable thing for an engine to decline
      // to composite, and this one has to produce frames. Kept out of the way rather than
      // hidden, since `display: none` is exactly what would stop it.
      canvas.style.position = "fixed";
      canvas.style.left = "-9999px";
      canvas.style.top = "0";
      document.documentElement.appendChild(canvas);

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no 2d context");

      const binary = atob(encoded);
      diagnostics.decoded = binary.length;
      const picture = context.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < binary.length; i++) {
        const grey = binary.charCodeAt(i);
        picture.data[i * 4] = grey;
        picture.data[i * 4 + 1] = grey;
        picture.data[i * 4 + 2] = grey;
        picture.data[i * 4 + 3] = 255;
      }
      context.putImageData(picture, 0, 0);

      const stream = canvas.captureStream(30);
      diagnostics.captured = true;
      const track = stream.getVideoTracks()[0];
      diagnostics.tracks = stream
        .getTracks()
        .map((one) => `${one.kind}:${one.readyState}`)
        .join(",");
      try {
        diagnostics.settings = JSON.stringify(track?.getSettings?.() ?? {});
      } catch {
        diagnostics.settings = "unavailable";
      }

      // Redrawn on a timer rather than on animation frames. A still canvas is allowed to
      // emit nothing, and animation frames are throttled or withheld from a page an engine
      // considers hidden, which a headless one may. `requestFrame` is asked for as well
      // where the engine offers it, because that is the direct way to make a canvas track
      // deliver one.
      const nudge = track as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
      setInterval(() => {
        diagnostics.redraws++;
        context.putImageData(picture, 0, 0);
        nudge?.requestFrame?.();
      }, 40);

      return stream;
    } catch (error) {
      diagnostics.failure = String(error).slice(0, 200);
      throw error;
    }
  };

  // Both halves are needed for a canvas to be a camera, and which engine has them belongs
  // to somebody else's build and differs by platform, so it is measured rather than written
  // down. Left undefined where it cannot work, which is what the engine would have offered
  // anyway, so the runtime meets the real thing rather than a pretend one.
  const usable =
    typeof MediaStream !== "undefined" &&
    typeof document.createElement("canvas").captureStream === "function";
  (window as unknown as { cameraStubbed: boolean }).cameraStubbed = usable;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: usable ? { getUserMedia: capture } : undefined,
  });
}

/** What the stub recorded, for a failure message that says where it stopped. */
export interface CameraDiagnostics {
  called: number;
  decoded: number;
  captured: boolean;
  tracks: string;
  settings: string;
  redraws: number;
  failure: string;
}

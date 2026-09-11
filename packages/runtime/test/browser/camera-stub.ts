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
 *
 * **Whether a canvas can be a camera is decided by trying it, not by looking for the two
 * APIs.** Both exist in WebKit on Linux and the stream they produce never becomes playable
 * there, which is a thing a test cannot learn from `typeof`. So the stream is fed to a
 * video element here first, and only a stream that yields a picture is handed over; one
 * that does not is refused the way a missing device is refused, which is the truth about
 * that engine and is what the runtime should be made to handle anyway.
 */
export function installCanvasCamera(encoded: string): void {
  const diagnostics = {
    /** Whether a canvas camera was proved to work in this engine, by doing it. */
    usable: false,
    called: 0,
    decoded: 0,
    captured: false,
    tracks: "",
    settings: "",
    trial: "",
    redraws: 0,
    failure: "",
  };
  (window as unknown as { cameraDiagnostics: typeof diagnostics }).cameraDiagnostics = diagnostics;

  /** Everything a still canvas needs to keep being a moving picture, in one place. */
  const paint = async (): Promise<{ stream: MediaStream; stop: () => void }> => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
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

    // Redrawn every animation frame. This is the arrangement that was measured working in
    // all three engines; a timer and a `requestFrame` were tried as belt and braces and
    // WebKit stopped producing a picture, so the braces came off again.
    let live = true;
    const again = () => {
      if (!live) return;
      diagnostics.redraws++;
      context.putImageData(picture, 0, 0);
      requestAnimationFrame(again);
    };
    requestAnimationFrame(again);

    // One frame before the stream is taken from the canvas. The arrangement that worked in
    // WebKit on Linux had a `fetch` between drawing and capturing and this one had nothing,
    // so the canvas may simply not have been composited yet when it was asked for a stream.
    // Harmless where it was not the problem.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const stream = canvas.captureStream(30);
    diagnostics.captured = true;
    return {
      stream,
      stop: () => {
        live = false;
        for (const track of stream.getTracks()) track.stop();
      },
    };
  };

  /** Does a stream from this canvas actually become a picture a video element can show? */
  const trial = async (): Promise<boolean> => {
    let made: { stream: MediaStream; stop: () => void } | undefined;
    try {
      made = await paint();
      const video = document.createElement("video");
      video.muted = true;
      video.setAttribute("playsinline", "");
      // Attached, off to one side, because the runtime's video is in the page and a trial
      // that is stricter than the thing it stands for reports engines as incapable when
      // they are not. `display: none` would be that stricter thing, so it is placement.
      video.style.position = "fixed";
      video.style.left = "-9999px";
      video.style.top = "0";
      video.style.width = "640px";
      video.style.height = "480px";
      video.dataset.cameraTrial = "";
      document.documentElement.appendChild(video);
      video.srcObject = made.stream;
      const playing = video.play().catch((error) => {
        diagnostics.trial = `play rejected: ${String(error).slice(0, 80)}`;
      });
      const gotSize = await Promise.race([
        (async () => {
          const until = Date.now() + 4000;
          while (Date.now() < until) {
            if (video.videoWidth > 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return false;
        })(),
        playing.then(() => new Promise<boolean>(() => undefined)),
      ]);
      if (!gotSize && !diagnostics.trial) diagnostics.trial = "no picture within 4000 ms";
      return gotSize === true;
    } catch (error) {
      diagnostics.trial = `threw: ${String(error).slice(0, 80)}`;
      return false;
    } finally {
      made?.stop();
      for (const spare of Array.from(document.querySelectorAll("video[data-camera-trial]"))) {
        spare.remove();
      }
    }
  };

  let decided: Promise<boolean> | undefined;
  const capture = async (): Promise<MediaStream> => {
    diagnostics.called++;
    decided ??= trial();
    diagnostics.usable = await decided;
    if (!diagnostics.usable) {
      // Refused the way a device that is not there is refused, so the runtime meets a real
      // shape of failure rather than a pretend one.
      throw Object.assign(new Error(`a canvas cannot be a camera in this engine: ${diagnostics.trial}`), {
        name: "NotFoundError",
      });
    }
    try {
      const made = await paint();
      const track = made.stream.getVideoTracks()[0];
      diagnostics.tracks = made.stream
        .getTracks()
        .map((one) => `${one.kind}:${one.readyState}`)
        .join(",");
      try {
        diagnostics.settings = JSON.stringify(track?.getSettings?.() ?? {});
      } catch {
        diagnostics.settings = "unavailable";
      }
      return made.stream;
    } catch (error) {
      diagnostics.failure = String(error).slice(0, 200);
      throw error;
    }
  };

  // The two APIs have to be there before any of the above can be tried at all. Whether they
  // work is decided above, by trying; this only decides whether there is anything to try.
  const present =
    typeof MediaStream !== "undefined" &&
    typeof document.createElement("canvas").captureStream === "function";
  (window as unknown as { cameraStubbed: boolean }).cameraStubbed = present;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    // Left undefined where there is nothing to try, which is what the engine would have
    // offered anyway, so the runtime meets the real thing rather than a pretend one.
    value: present ? { getUserMedia: capture } : undefined,
  });
}

/** What the stub recorded, for a failure message that says where it stopped. */
export interface CameraDiagnostics {
  usable: boolean;
  called: number;
  decoded: number;
  captured: boolean;
  tracks: string;
  settings: string;
  trial: string;
  redraws: number;
  failure: string;
}

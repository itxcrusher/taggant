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
 * Pass it to `page.addInitScript(installCanvasCamera, { encoded, width, height })`, where
 * `encoded` is a base64 grayscale frame of exactly those dimensions. It is one function, in
 * one file, because two copies of it in two test files is how they drift.
 *
 * **Whether a canvas can be a camera is not decided here.** Both APIs exist in WebKit on
 * Linux and the stream they produce may never become playable there, which is not a thing
 * `typeof` can say. This used to feed the stream to a video element of its own first and
 * hand over only one that yielded a picture, and that was worse: a trial with its own video
 * element, off to one side of the page, is stricter than the runtime's, which is in the
 * page and on screen, so it reported an engine as incapable where the runtime might not
 * have been. The stream is handed over as it is, the page settles on tracking or on an
 * error, and the test reads which. The runtime bounds its own wait, so a stream that never
 * plays is an error state rather than a page that hangs, which is what makes this safe.
 */
export function installCanvasCamera(feed: { encoded: string; width: number; height: number }): void {
  const { encoded, width, height } = feed;
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

  /** Everything a still canvas needs to keep being a moving picture, in one place. */
  const paint = async (): Promise<{ stream: MediaStream; stop: () => void }> => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no 2d context");

    const binary = atob(encoded);
    diagnostics.decoded = binary.length;
    // Said rather than drawn wrong. The size used to be fixed at 640 by 480 here, so a
    // caller with a larger frame got the first 307,200 of its bytes laid out as a smaller
    // picture: a scrambled image, recognised by nothing, and no error anywhere. The test
    // that hit it failed ninety seconds later as a timeout with nothing to read.
    if (binary.length !== width * height) {
      throw new Error(`the feed is ${binary.length} bytes and ${width} by ${height} needs ${width * height}`);
    }
    const picture = context.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < binary.length; i++) {
      const grey = binary.charCodeAt(i);
      picture.data[i * 4] = grey;
      picture.data[i * 4 + 1] = grey;
      picture.data[i * 4 + 2] = grey;
      picture.data[i * 4 + 3] = 255;
    }
    // Painted once into a canvas of its own, then copied. Putting the image data back every
    // animation frame writes three hundred thousand pixels on the page's own thread sixty
    // times a second, which is enough work to matter: it delayed the first answer out of the
    // recognition worker past the five seconds after which the runtime decides the worker is
    // broken and falls back to the page thread for good. The test that asserts it did not
    // fall back went from passing to failing on that alone. A copy is a copy.
    const source = document.createElement("canvas");
    source.width = width;
    source.height = height;
    const into = source.getContext("2d");
    if (!into) throw new Error("no 2d context for the source");
    into.putImageData(picture, 0, 0);
    context.drawImage(source, 0, 0);

    // Redrawn every animation frame, because a still canvas is allowed to emit nothing. This
    // is the arrangement measured working in all three engines; a timer and a `requestFrame`
    // were tried as belt and braces and WebKit stopped producing a picture.
    let live = true;
    const again = () => {
      if (!live) return;
      diagnostics.redraws++;
      context.drawImage(source, 0, 0);
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

  const capture = async (): Promise<MediaStream> => {
    diagnostics.called++;
    try {
      const made = await paint();
      const track = made.stream.getVideoTracks()[0];
      // Stop repainting when whoever took the stream stops it, rather than repainting a
      // canvas nobody is reading for as long as the page is open.
      track?.addEventListener("ended", made.stop);
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
  // work is not decided here; this only decides whether there is anything to hand over.
  const present =
    typeof MediaStream !== "undefined" &&
    typeof document.createElement("canvas").captureStream === "function";
  // Left undefined where there is nothing to hand over, which is what the engine would have
  // offered anyway, so the runtime meets the real thing rather than a pretend one.
  const replacement = present ? { getUserMedia: capture } : undefined;

  // Both the instance and the prototype. Shadowing the instance alone is not the guarantee
  // this file claims to give: the real `MediaDevices` stays reachable through the accessor
  // on `Navigator.prototype`, and one `delete navigator.mediaDevices` brings it straight
  // back. Nothing here does either, but "there is no path to hardware" has to be true
  // rather than nearly true, since it is what everything else rests on.
  try {
    Object.defineProperty(Navigator.prototype, "mediaDevices", {
      configurable: true,
      get: () => replacement,
    });
  } catch {
    // Engines without the accessor at all, which is what Playwright's WebKit is on Windows.
  }
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: replacement });
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

import type { GrayscaleImage } from "@taggant/vision";

export interface CameraOptions {
  /** How long to wait for a picture after the camera opens, before giving up on it. */
  readyTimeoutMs?: number;
  /**
   * Width the frames are tracked at.
   *
   * Not the width they are shown at. Recognition runs on every frame, and the cost is
   * roughly the pixel count, so this is the one number that decides whether the loop keeps
   * up. The pose is scaled back up before anything is drawn.
   */
  processWidth?: number;
  /** Which camera to ask for. The back one, on anything that has two. */
  facingMode?: "environment" | "user";
}

export type CameraFailure = "denied" | "unavailable" | "no-camera";

export class CameraError extends Error {
  constructor(
    readonly reason: CameraFailure,
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

/**
 * The camera, reduced to the two things the tracker needs: a picture the viewer sees, and
 * a small grayscale copy of it to work on.
 */
export class Camera {
  private stream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  /** Reused between frames. A fresh buffer several times a second is work for the collector. */
  private gray: Uint8Array | null = null;
  private ended = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly options: CameraOptions = {},
  ) {}

  async start(): Promise<void> {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      throw new CameraError("unavailable", "this browser cannot open a camera from a page");
    }
    try {
      this.stream = await media.getUserMedia({
        video: { facingMode: this.options.facingMode ?? "environment" },
        audio: false,
      });
    } catch (error) {
      // The distinction matters to the viewer: a refusal is theirs to undo, a missing
      // camera is not, and telling them the wrong one wastes their time.
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new CameraError("denied", "the camera was not allowed for this page");
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new CameraError("no-camera", "no camera was found on this device");
      }
      throw new CameraError(
        "unavailable",
        error instanceof Error ? error.message : "the camera could not be opened",
      );
    }

    // A camera can be taken away mid session: another app claims it, a phone is locked, a
    // device is unplugged. Without this the loop goes on recognising a frame that stopped
    // changing and the viewer is told to keep pointing at the artwork.
    for (const track of this.stream.getTracks()) {
      track.addEventListener("ended", () => {
        this.ended = true;
      });
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "");
    this.video.muted = true;
    await this.video.play();
    await this.ready();
  }

  /**
   * Resolve once the video has a size, which is when frames can be read from it.
   *
   * With a deadline, because a camera can open and then deliver nothing: another app
   * holding it, a virtual device with no source behind it. Waiting on `loadedmetadata`
   * with nothing behind it meant the promise from `mountExperience` never settled at all,
   * so the page sat on "asking for the camera" and the caller could not even say why.
   */
  private ready(): Promise<void> {
    if (this.video.videoWidth > 0) return Promise.resolve();
    const limit = this.options.readyTimeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.video.removeEventListener("loadedmetadata", done);
      };
      const done = () => {
        finish();
        resolve();
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          new CameraError(
            "unavailable",
            `the camera opened but sent no picture within ${limit} ms, which usually means another app is using it`,
          ),
        );
      }, limit);
      this.video.addEventListener("loadedmetadata", done);
    });
  }

  /** Whether the camera has gone away since it was opened. */
  get lost(): boolean {
    return this.ended;
  }

  stop(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Size the camera is actually delivering, which is not the size it is displayed at. */
  get sourceSize(): { width: number; height: number } {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  /**
   * The current frame, reduced and converted to grayscale.
   *
   * Rec. 601 luma weights, which is what the eye and every other part of this system mean
   * by brightness.
   */
  grab(): GrayscaleImage | null {
    const { videoWidth, videoHeight } = this.video;
    if (videoWidth < 1 || videoHeight < 1) return null;

    const processWidth = Math.min(this.options.processWidth ?? 480, videoWidth);
    const width = Math.max(1, Math.round(processWidth));
    const height = Math.max(1, Math.round((videoHeight / videoWidth) * width));

    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = this.canvas ?? document.createElement("canvas");
      this.canvas.width = width;
      this.canvas.height = height;
      this.context = this.canvas.getContext("2d", { willReadFrequently: true });
      this.gray = new Uint8Array(width * height);
    }
    const context = this.context;
    if (!context) return null;

    context.drawImage(this.video, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const gray = this.gray ?? new Uint8Array(width * height);
    this.gray = gray;
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      gray[i] = ((data[p] ?? 0) * 299 + (data[p + 1] ?? 0) * 587 + (data[p + 2] ?? 0) * 114) / 1000;
    }
    return { width, height, data: gray };
  }
}

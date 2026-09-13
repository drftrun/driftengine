import { supportedClipMimeType } from './clipMime.ts';
import { ExportTarget, clipBitrate, exportSizeFor } from './exportTarget.ts';
import type { LockableSurface } from './exportTarget.ts';
import type { FrameOverlay } from './frameOverlay.ts';
import type { FramePacingReport } from './framePacer.ts';

export const DEFAULT_CLIP_FPS = 30;

/**
 * Recording what is on a canvas — or on a prepared export target — to a file.
 *
 * A convenience on top of the replay, not the feature. The replay itself is
 * what makes a run worth posting; this saves the trouble of reaching for a
 * screen recorder — and where the browser cannot do it, saying so plainly beats
 * producing a file that will not play.
 *
 * Deliberately not a server-side render. That is the "proper" answer and it is
 * a backend, a queue, a storage bill and a moderation problem, for something
 * the browser already does.
 *
 * **The honest limit, and it belongs here rather than in a commit message:**
 * `MediaRecorder` timestamps every frame by wall clock, and that is measured
 * rather than assumed — a probe recording requested frames at gaps of 8.6 / 24.5 /
 * 8.1 / 28.6 ms and `ffprobe` read the MP4's own timestamps back as 8.8 / 24.2 /
 * 8.1 / 28.5 ms, `avg_frame_rate=7110000/120161`. Two things follow.
 *
 * An export has to run in real time: there is no in-browser way to render a clip
 * slower than real time and have the audio line up, short of shipping our own
 * muxer, which is a dependency and the standing rule says no. So the export can be
 * *paced* (see `ExportTarget`) and *measured*, but it cannot be given more time.
 *
 * And a constant-rate file is not on offer either. What is on offer is a file whose
 * frames are evenly spaced *and* hold moments the same distance apart, which is
 * what a viewer reads as smooth — so the schedule captures every n-th animation
 * frame and the content follows the wall clock. A device that cannot hold the
 * target rate then produces a slower clip rather than a juddering one, and the
 * measurement in `pacing` says which it was.
 */
export interface FrameRecorderOptions {
  /**
   * Record the canvas directly, at `fps`. Simple and appropriate for a debug
   * capture; for a clip anybody else will see, prefer `stream` from an
   * `ExportTarget`, which fixes the aspect, stamps the mark and paces the
   * frames.
   */
  readonly canvas?: HTMLCanvasElement;
  /** A prepared video stream, e.g. `ExportTarget.acquire()`. Wins over `canvas`. */
  readonly stream?: MediaStream;
  /** Mixed into the clip. Omit for a silent recording. */
  readonly audio?: MediaStream | null;
  /**
   * Frames per second wanted — a floor, not a promise.
   *
   * The schedule counts animation frames (see `FramePacer`), so what comes out is
   * the loop's own rate divided by a whole number. Asking for 60 on a 144 Hz panel
   * records 72; asking for it on a loop that can only deliver 40 records 40.
   */
  readonly fps?: number;
  /**
   * Bits per second for video. Defaults to a figure scaled from the frame's
   * pixel count and rate — a constant is generous at one size and starved at
   * another, and a starved encoder on high-motion footage looks like stutter.
   */
  readonly videoBitsPerSecond?: number;
  /**
   * Record at a fixed frame size rather than at whatever the canvas happens to
   * be, compositing the scene and an optional mark into it.
   *
   * This is what makes an export a *product* rather than a screen capture: the
   * frame is the requested shape whatever the window is, the mark is inside the
   * video where a DOM overlay could never be, and frames are handed over one at a
   * time so none is ever recorded twice.
   */
  readonly target?: {
    /** The canvas the scene is drawn into. */
    readonly source: HTMLCanvasElement;
    /** Whoever owns that canvas's drawing-buffer size — normally the renderer. */
    readonly surface: LockableSurface;
    readonly width: number;
    readonly height: number;
    readonly overlay?: FrameOverlay | ((width: number, height: number) => FrameOverlay);
    /**
     * Drawn live into every composed frame, after the scene and the baked mark.
     *
     * For anything that changes frame to frame — a speedometer, a clock — which the
     * baked `overlay` cannot express at all. See `ExportTargetOptions.drawFrame`.
     */
    readonly drawFrame?: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
    /**
     * What the renderer is currently managing, frames per second. A device below
     * the target rate records at a smaller frame instead: a slightly softer clip
     * that holds its rate beats a full-size one that judders. Omit for no
     * measurement, which is treated as no evidence rather than as bad news.
     */
    readonly measuredFps?: number;
    /** Forwarded to `ExportTargetOptions.presentedFrames`; see `duplicateFrame` below. */
    readonly presentedFrames?: () => number;
  };
}

export class FrameRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private readonly mime: string;
  private target: ExportTarget | null = null;
  private targetStream: MediaStream | null = null;

  constructor(private readonly options: FrameRecorderOptions) {
    const mime = supportedClipMimeType();
    if (mime === null) throw new Error('This browser cannot record video.');
    if (
      options.canvas === undefined &&
      options.stream === undefined &&
      options.target === undefined
    ) {
      throw new Error('A recording needs a canvas, a stream or a target.');
    }
    this.mime = mime;
  }

  get mimeType(): string {
    return this.mime;
  }

  /**
   * Take over the render surface before recording starts.
   *
   * Separate from `start` because the aspect has to be in force *before* the
   * first frame anybody records: the camera composes for `renderer.aspect`, so
   * locking and recording in the same breath would put a screen-shaped shot in
   * the first frames of a vertical clip. Returns the frame size that will be
   * recorded, which is not always the one requested — see `measuredFps`.
   */
  prepare(): { width: number; height: number; reduced: boolean } | null {
    const options = this.options.target;
    if (options === undefined) return null;
    if (this.target !== null) {
      return { width: this.target.width, height: this.target.height, reduced: false };
    }
    const fps = this.options.fps ?? DEFAULT_CLIP_FPS;
    // The measurement was taken while rendering the *window*, so it is handed in
    // with the pixel count it was taken at — see `exportSizeFor`.
    const size = exportSizeFor(
      options.width,
      options.height,
      options.measuredFps ?? 0,
      fps,
      options.source.width * options.source.height,
    );
    this.target = new ExportTarget({
      source: options.source,
      surface: options.surface,
      width: size.width,
      height: size.height,
      fps,
      ...(options.overlay === undefined ? {} : { overlay: options.overlay }),
      ...(options.drawFrame === undefined ? {} : { drawFrame: options.drawFrame }),
      ...(options.presentedFrames === undefined
        ? {}
        : { presentedFrames: options.presentedFrames }),
    });
    this.targetStream = this.target.acquire();
    return size;
  }

  /**
   * Whether the frame about to be drawn will be kept. True when there is no
   * fixed target, so a caller can gate its render pass unconditionally.
   *
   * Call once per animation frame, drawing or not: the instant is kept and reused
   * when the frame is handed over, so one clock decides and commits.
   */
  captureDue(nowMs: number): boolean {
    return this.target?.captureDue(nowMs) ?? true;
  }

  /**
   * One rendered frame, offered to the recording.
   *
   * Call at the very end of the render pass. Cheap and false when there is no
   * fixed target, so a caller can hand every frame over unconditionally. Takes no
   * instant — it uses the one `captureDue` was given for this frame.
   */
  frameRendered(): boolean {
    return this.target?.frameRendered() ?? false;
  }

  /**
   * What the pacing actually was, or null when recording the canvas directly.
   *
   * The measurement is the point rather than a diagnostic afterthought: an export
   * that ran below its target rate produced a juddering file, and the only honest
   * options are to say so or to have not measured.
   */
  get pacing(): FramePacingReport | null {
    return this.target === null ? null : this.target.pacing;
  }

  /**
   * Whether the frame `frameRendered` just composited repeats the one before it.
   *
   * False without a target, and false when `presentedFrames` was never supplied — the same
   * two "no evidence yet" cases `pacing` already has to account for. See
   * `ExportTarget.duplicateFrame`, which this only forwards.
   */
  get duplicateFrame(): boolean {
    return this.target?.duplicateFrame ?? false;
  }

  /**
   * Start the measurement over, keeping the schedule.
   *
   * For a caller that records a warm-up in front of the clip proper: what a device
   * costs while an encoder gets going is not what the clip is like, and the report is
   * what the export decides whether to warn the player on.
   */
  resetPacing(): void {
    this.target?.resetPacing();
  }

  start(): void {
    if (this.recorder !== null) return;
    const { canvas, audio, fps = DEFAULT_CLIP_FPS } = this.options;

    if (this.options.target !== undefined) this.prepare();
    const source = this.targetStream ?? this.options.stream ?? canvas?.captureStream(fps) ?? null;
    if (source === null) throw new Error('A recording needs a canvas, a stream or a target.');

    /*
     * A fresh stream rather than the source one. Adding the audio tracks to a
     * stream the caller owns means stopping the recording would stop the audio
     * graph's capture track too, and a second export would then come out silent.
     */
    const stream = new MediaStream();
    for (const track of source.getVideoTracks()) stream.addTrack(track);
    if (audio != null) {
      for (const track of audio.getAudioTracks()) stream.addTrack(track);
    }

    this.chunks = [];
    this.recorder = new MediaRecorder(stream, {
      mimeType: this.mime,
      videoBitsPerSecond: this.options.videoBitsPerSecond ?? this.defaultBitrate(stream, fps),
    });
    this.recorder.ondataavailable = (event): void => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
  }

  /**
   * Resolves with the finished clip, or null if nothing was recorded.
   *
   * The surface goes back before the promise resolves either way. A cancelled
   * export that left the drawing buffer pinned to 1080x1920 would leave the game
   * rendering into the wrong shape for the rest of the session.
   */
  async stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (recorder === null) {
      this.release();
      return null;
    }
    this.recorder = null;

    await new Promise<void>((resolve) => {
      recorder.onstop = (): void => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
    this.release();

    if (this.chunks.length === 0) return null;
    return new Blob(this.chunks, { type: this.mime });
  }

  /** Give the render surface back. Safe at any point, and idempotent. */
  release(): void {
    this.target?.release();
    this.target = null;
    this.targetStream = null;
  }

  /**
   * Bitrate from whatever the frame's real size turns out to be.
   *
   * Read from the track where possible, because that is the authority: a stream
   * from a composited target has nothing to do with the canvas that was passed
   * in, and guessing from the wrong one is how a 1080x1920 clip ends up encoded
   * at a bitrate chosen for a 400-pixel window.
   */
  private defaultBitrate(stream: MediaStream, fps: number): number {
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    const width = settings?.width ?? this.options.canvas?.width ?? 1280;
    const height = settings?.height ?? this.options.canvas?.height ?? 720;
    return clipBitrate(width, height, fps);
  }
}

/**
 * Hand a file to the player.
 *
 * `navigator.share` where it exists, because on a phone that is one tap into
 * the app they were going to post to anyway; a download otherwise. A file in
 * the Downloads folder that nobody can find is most of the way to no export at
 * all.
 */
export async function offerClip(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });

  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch {
      // Cancelled, or refused. Fall through to a download rather than leaving
      // the player with nothing.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked on the next turn: doing it synchronously races the download in
  // some browsers and produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

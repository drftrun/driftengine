/**
 * Encoding frames and samples into a file, on a timeline we choose.
 *
 * The difference between this and a screen recorder is one word: **timestamps.** A
 * recorder stamps a frame with the instant it happened to arrive, so the file's cadence
 * is a measurement of how busy the machine was. Here every frame is stamped with where
 * it *belongs*, so a slow machine produces a slower export rather than a worse file.
 *
 * That was not a preference. Measured with `ffprobe` on real `MediaRecorder` output: a
 * clip's audio led its picture by 51 ms in one run and 85 ms in the next, and the
 * `outputLatency` it would have to be corrected by reported 0.048 then 0.024 — so the
 * error is real, varies, and cannot be calibrated out from inside the page. Nothing
 * below asks the browser what time it is.
 *
 * Game-agnostic on purpose (AGENTS.md): frames, samples, sizes and rates. A second game
 * uses it unchanged.
 */
import type { FrameOverlay } from '@driftengine/core';
import { clipCodecs } from './clipSupport.ts';
import type { ClipEncodeRequest } from './clipSupport.ts';

/**
 * Everything an encode needs: the frame, the rate, the bitrate, and the score's sample rate.
 *
 * The first four are `ClipEncodeRequest`, which is what `clipEncodingSupported` asks about, so a
 * caller can hand the same object to the gate and to `open` and know they asked one question.
 */
export interface ClipEncoderOptions extends ClipEncodeRequest {
  /** Audio sample rate, so the score and the encoder agree. */
  readonly sampleRate?: number;
}

/**
 * Microseconds for frame `index` at `fps`.
 *
 * **The product is rounded, never a per-frame constant accumulated.** A 60 fps frame is
 * 16666.67 µs and the nearest integer is 16667, which is a third of a microsecond long
 * — trivial once and 20 ms over a minute, which is more than a frame of drift by the
 * end of a clip. Deriving each stamp from its own index cannot drift at all.
 */
export function frameTimestampUs(index: number, fps: number): number {
  return Math.round((index * 1_000_000) / Math.max(fps, 1));
}

/** How many frames may be in flight before the loop waits for the encoder. */
const QUEUE_LIMIT = 8;
/** Samples per encoded audio chunk. A power of two the encoders all accept. */
const AUDIO_CHUNK = 1024;
/** Seconds between key frames. Two is what every platform's transcoder expects. */
const KEYFRAME_SEC = 2;

interface MuxerLike {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void;
  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void;
  finalize(): void;
}

/** Which audio codec a file ended up carrying. See `ClipEncoder.audioCodec`. */
export type ClipAudioCodec = 'aac' | 'opus';

export class ClipEncoder {
  private video: VideoEncoder | null = null;
  private audio: AudioEncoder | null = null;
  private muxer: MuxerLike | null = null;
  private target: { buffer: ArrayBuffer | null } | null = null;
  /**
   * The audio codec this file carries, once configured.
   *
   * Reported rather than kept private because the two answers are not equivalent to
   * whoever receives the file, and the difference is invisible in it: an MP4 is an
   * MP4 either way. AAC is what every share target ingests. Opus in MP4 is legal ISO
   * and almost nothing consumer-side reads it — Android's MediaCodec decodes Opus
   * only in Matroska, WebM and Ogg, so the TikTok app cannot open the file at all.
   *
   * A caller that knows which one it got can say so. One that cannot know hands over
   * a file that fails somewhere it will never see, which is what happened.
   */
  private chosenAudio: ClipAudioCodec | null = null;
  /** The first error either encoder reported. Read by the caller; never thrown at it. */
  private failure: string | null = null;
  private closed = false;

  private constructor(private readonly options: ClipEncoderOptions) {}

  /**
   * Configure the encoders and the container.
   *
   * The muxer is imported here rather than at the top of the module, so a player who
   * never exports never downloads it. Rejects when the browser cannot encode, which the
   * caller answers by recording instead.
   */
  static async open(options: ClipEncoderOptions): Promise<ClipEncoder> {
    const encoder = new ClipEncoder(options);
    await encoder.configure();
    return encoder;
  }

  /** The error that ended the encode, or null while it is going well. */
  get error(): string | null {
    return this.failure;
  }

  /**
   * The audio codec the file carries, or null before `open` has configured one.
   *
   * Survives `finish`, deliberately: the caller asks *after* it has a blob.
   */
  get audioCodec(): ClipAudioCodec | null {
    return this.chosenAudio;
  }

  private async configure(): Promise<void> {
    const { width, height, fps, bitrate, sampleRate = 48000 } = this.options;

    /*
     * The audio codec is *asked about* before anything is built, and that omission is
     * what broke the first export. AAC was configured without checking, and Chrome on
     * Linux has no AAC encoder — so `configure` accepted it, the codec errored
     * internally on the first frame, closed itself, and the loop's next call reported
     * "Cannot call 'encode' on a closed codec". Which is a true statement about a
     * consequence and says nothing about the cause.
     *
     * AAC first because it is what every share target ingests without transcoding.
     * Opus second because Chrome muxes Opus into MP4 happily — its own `MediaRecorder`
     * does, as `ffprobe` showed on a probe file earlier — so it is a real fallback
     * rather than a theoretical one.
     */
    const audioCandidates = [
      { codec: 'mp4a.40.2', muxed: 'aac' as const },
      { codec: 'opus', muxed: 'opus' as const },
    ];
    let audioChoice: { codec: string; muxed: ClipAudioCodec } | null = null;
    for (const candidate of audioCandidates) {
      const config = {
        codec: candidate.codec,
        sampleRate,
        numberOfChannels: 2,
        bitrate: 192_000,
      };
      try {
        const support = await AudioEncoder.isConfigSupported(config);
        if (support.supported === true) {
          audioChoice = candidate;
          break;
        }
      } catch {
        // A codec string this build does not recognise. Try the next.
      }
    }
    if (audioChoice === null) throw new Error('This browser cannot encode clip audio.');
    this.chosenAudio = audioChoice.muxed;

    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      fastStart: 'in-memory',
      video: { codec: 'avc', width, height },
      audio: { codec: audioChoice.muxed, numberOfChannels: 2, sampleRate },
    });
    this.target = target;
    this.muxer = muxer as unknown as MuxerLike;

    /*
     * The ladder is derived from the frame rather than written down here — see `clipCodecs`,
     * which is also what `clipEncodingSupported` walks, so a gate and an export cannot answer
     * differently.
     *
     * **Both rungs used to be level 4.0 spelled out as literals, and that is what stopped 4K.**
     * A level is a promise about frame size: 4.0's 8192 macroblocks holds 1920x1080 and nothing
     * larger, so `isConfigSupported` said no at 2560x1440 and above and `configure` below was
     * never reached at those sizes. The comment that stood here reasoned that the level is a
     * floor and that Chrome raises it, which is true of every file this produces and is not a
     * thing that can happen to a config the browser refused first.
     */
    const video = new VideoEncoder({
      output: (chunk, meta) => this.muxer?.addVideoChunk(chunk, meta),
      error: (error) => this.fail(error.message),
    });
    const codecs = clipCodecs(width, height);
    let configured = false;
    for (const codec of codecs) {
      const config = { codec, width, height, bitrate, framerate: fps };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported !== true) continue;
      video.configure(config);
      configured = true;
      break;
    }
    if (!configured) throw new Error('This browser cannot encode video at that size.');
    this.video = video;

    const audio = new AudioEncoder({
      output: (chunk, meta) => this.muxer?.addAudioChunk(chunk, meta),
      error: (error) => this.fail(error.message),
    });
    audio.configure({
      codec: audioChoice.codec,
      sampleRate,
      numberOfChannels: 2,
      bitrate: 192_000,
    });
    this.audio = audio;
  }

  /**
   * One frame, at its own index.
   *
   * Awaits while the encoder is behind, which is the only backpressure in the pipeline:
   * a render loop with nothing to wait for will queue a thousand 1080x1920 frames and
   * run the tab out of memory long before the encoder catches up.
   */
  async addFrame(source: CanvasImageSource, index: number): Promise<void> {
    const video = this.video;
    // `state`, not just the failure flag: a codec that hit an internal error closes
    // itself, and the error callback that would set the flag may not have run yet.
    // Encoding into it then throws a message about the closure and hides the cause.
    if (video === null || video.state !== 'configured' || this.failure !== null) return;
    const { fps } = this.options;
    const frame = new VideoFrame(source, {
      timestamp: frameTimestampUs(index, fps),
      duration: Math.round(1_000_000 / fps),
    });
    try {
      video.encode(frame, { keyFrame: index % Math.round(fps * KEYFRAME_SEC) === 0 });
    } finally {
      // Closed whatever happened: a `VideoFrame` holds a GPU surface, and leaking one a
      // frame is how a long export becomes an out-of-memory crash.
      frame.close();
    }
    while (
      video.encodeQueueSize > QUEUE_LIMIT &&
      this.failure === null &&
      video.state === 'configured'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /**
   * The whole score, in order.
   *
   * Interleaved into the encoder's f32 planar layout by hand rather than handed the
   * `AudioBuffer`, because `AudioData` takes a flat buffer and the two channels of an
   * `AudioBuffer` are separate arrays.
   */
  async addAudio(buffer: AudioBuffer): Promise<void> {
    const audio = this.audio;
    if (audio === null || audio.state !== 'configured' || this.failure !== null) return;
    const channels = Math.min(buffer.numberOfChannels, 2);
    const left = buffer.getChannelData(0);
    const right = channels > 1 ? buffer.getChannelData(1) : left;
    const rate = buffer.sampleRate;
    const scratch = new Float32Array(AUDIO_CHUNK * 2);

    for (let start = 0; start < buffer.length; start += AUDIO_CHUNK) {
      const count = Math.min(AUDIO_CHUNK, buffer.length - start);
      // Planar: all of the left channel, then all of the right.
      for (let i = 0; i < count; i++) {
        scratch[i] = left[start + i] ?? 0;
        scratch[count + i] = right[start + i] ?? 0;
      }
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: rate,
        numberOfFrames: count,
        numberOfChannels: 2,
        timestamp: Math.round((start / rate) * 1_000_000),
        data: scratch.subarray(0, count * 2),
      });
      if (audio.state !== 'configured' || this.failure !== null) {
        data.close();
        return;
      }
      try {
        audio.encode(data);
      } finally {
        data.close();
      }
      if (this.failure !== null) return;
      while (audio.encodeQueueSize > QUEUE_LIMIT * 4) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
  }

  /** Flush both encoders, close the container, and hand back the file. */
  async finish(): Promise<Blob | null> {
    if (this.closed) return null;
    this.closed = true;
    try {
      await this.video?.flush();
      await this.audio?.flush();
      this.muxer?.finalize();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'the encoder gave up');
    }
    this.release();
    const buffer = this.target?.buffer ?? null;
    if (this.failure !== null || buffer === null) return null;
    return new Blob([buffer], { type: 'video/mp4' });
  }

  /** Give everything back without producing a file. Safe at any point. */
  abort(): void {
    this.closed = true;
    this.release();
  }

  private release(): void {
    try {
      if (this.video?.state === 'configured') this.video.close();
      if (this.audio?.state === 'configured') this.audio.close();
    } catch {
      // Already closed. Nothing to do about an encoder we were discarding.
    }
    this.video = null;
    this.audio = null;
  }

  /** First failure wins: the later ones are consequences of it. */
  private fail(message: string): void {
    this.failure ??= message;
  }
}

/** Re-exported so a caller can composite a mark without importing two modules. */
export type { FrameOverlay };

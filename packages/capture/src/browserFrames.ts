/**
 * A clip in a browser as a `FrameSource`: a video element decoded into a canvas, a frame at a time.
 *
 * **A declared browser module** — a native host writes its own source over its own decoder, which is
 * the whole point of the seam. Nothing else in this package touches a DOM.
 *
 * **Why a video element rather than WebCodecs.** `VideoDecoder` takes encoded chunks and a browser
 * ships no demuxer to make them from an MP4, so a WebCodecs source means a demuxing dependency in a
 * package whose bar for one is high. A video element demuxes, decodes and seeks with nothing added,
 * and `drawImage` into a 2D canvas is how its frame becomes bytes. **What it gives up**: a frame is
 * addressed by time rather than by its place in the stream — the middle of frame `index` at the
 * clip's rate — so a clip of variable frame rate answers the frame covering that instant rather
 * than the `index`-th one. What would make that wrong is a capture that needs a particular frame
 * rather than a moment; nothing here does, since frames are chosen by motion.
 *
 * **The rate is measured, not assumed**, from the first frames the decoder presents, and falls back
 * to the caller's `frameRate` where `requestVideoFrameCallback` is absent.
 */
import type { FrameSize, FrameSource } from './frames.ts';

/** A browser's clip, and how to let it go. */
export interface BrowserClip extends FrameSource {
  /** Releases the element and the object URL; the source answers nothing afterwards. */
  close(): void;
}

interface FrameCallbackMetadata {
  readonly mediaTime: number;
  readonly presentedFrames: number;
}
type VideoWithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: FrameCallbackMetadata) => void,
  ) => number;
};

const once = (video: HTMLVideoElement, event: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const done = (): void => {
      video.removeEventListener(event, done);
      video.removeEventListener('error', failed);
      resolve();
    };
    const failed = (): void => {
      video.removeEventListener(event, done);
      video.removeEventListener('error', failed);
      reject(new Error(`the clip could not be read: ${video.error?.message ?? 'no reason given'}`));
    };
    video.addEventListener(event, done);
    video.addEventListener('error', failed);
  });

/** The rate the decoder presents frames at, from two it presents, or null where it cannot say. */
async function measuredRate(video: VideoWithCallback): Promise<number | null> {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  const times: number[] = [];
  await new Promise<void>((resolve) => {
    const take = (_now: number, metadata: FrameCallbackMetadata): void => {
      times.push(metadata.mediaTime);
      if (times.length >= 3) resolve();
      else video.requestVideoFrameCallback?.(take);
    };
    video.requestVideoFrameCallback?.(take);
    void video.play().catch(() => resolve());
    setTimeout(resolve, 2000);
  });
  video.pause();
  const steps: number[] = [];
  for (let i = 1; i < times.length; i += 1)
    steps.push((times[i] as number) - (times[i - 1] as number));
  const shortest = Math.min(...steps.filter((step) => step > 0));
  return Number.isFinite(shortest) && shortest > 0 ? 1 / shortest : null;
}

/**
 * The clip's frames, addressed at the clip's rate. `frameRate` is the fallback where the browser
 * cannot say what the rate is.
 */
export async function browserFrameSource(
  clip: Blob,
  options: { readonly frameRate?: number } = {},
): Promise<BrowserClip> {
  // platform: browser default — this module is the browser's own `FrameSource`.
  const url = URL.createObjectURL(clip);
  const video = document.createElement('video') as VideoWithCallback;
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  await once(video, 'loadedmetadata');
  /*
   * **A container that parses is not a track that decodes**, and the difference is silent.
   *
   * Chrome on Linux plays no HEVC, which is what every recent phone records by default. The file
   * loads, `loadedmetadata` fires, `duration` comes back correct to the millisecond — and
   * `videoWidth` is zero, because nothing decoded. Left alone, the first frame draws a zero-wide
   * image into a zero-wide canvas and dies inside `getImageData` with "the source width is 0",
   * which names neither the clip nor the codec and sends a reader into the canvas code.
   *
   * So it is refused here, by name, with the duration as evidence that the file itself is fine.
   * **What this cannot do is say which codec it was**: the element reports no track it could not
   * decode, so the message names the one that always works rather than guessing at the one that
   * did not.
   */
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    const seconds = Number.isFinite(video.duration) ? video.duration.toFixed(2) : 'an unknown';
    throw new Error(
      `this browser cannot decode the clip's video track: it read ${seconds} s of container and ` +
        'no picture. A codec this browser does not have is the usual cause — HEVC on a build ' +
        'without it, which is what most phones record. Convert the clip to H.264 and try again.',
    );
  }
  const rate = (await measuredRate(video)) ?? options.frameRate ?? 30;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const count = Math.max(1, Math.floor(video.duration * rate));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('a clip needs a 2D canvas to become pixels');
  let open = true;

  return {
    frameCount: () => (open ? count : 0),
    async frameAt(index: number, out: Uint8Array): Promise<FrameSize> {
      if (!open) throw new Error('the clip is closed');
      if (out.length >= width * height * 4) {
        /* The middle of the frame, so rounding cannot land on the boundary either side. */
        const at = Math.min((index + 0.5) / rate, Math.max(0, video.duration - 1 / rate));
        if (Math.abs(video.currentTime - at) > 1e-6) {
          video.currentTime = at;
          await once(video, 'seeked');
        }
        context.drawImage(video, 0, 0, width, height);
        out.set(context.getImageData(0, 0, width, height).data);
      }
      return { width, height };
    },
    close() {
      open = false;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

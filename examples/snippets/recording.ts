/**
 * The parts of recording the example does not show: which buttons a browser can offer, handing a
 * clip to a phone's share sheet, a frame size chosen from what the device is managing, and the
 * pacer on its own.
 *
 * A snippet, typechecked with the examples and quoted by the manual's recording chapter.
 */
import {
  FramePacer,
  clipBitrate,
  describeClipMime,
  exportSizeFor,
  offerClip,
  supportedClipMimeType,
} from '@driftengine/core';
import {
  clipEncodingSupported,
  framesReachEncoder,
  offlineEncodingSupported,
} from '@driftengine/media';

// #region offer
/**
 * What to offer, asked once before anything is built: a still always, a recording where the
 * browser has a recorder, and a render where it can encode a clip of this size and hands its
 * encoder real pictures.
 */
export async function whatToOffer(width: number, height: number, fps: number) {
  const recordable = supportedClipMimeType();
  const renderable =
    offlineEncodingSupported() &&
    (await clipEncodingSupported({
      width,
      height,
      fps,
      bitrate: clipBitrate(width, height, fps),
    })) &&
    (await framesReachEncoder()) !== 'empty';
  return {
    still: true,
    record: recordable !== null,
    /* MP4 with AAC is the one file every phone's share targets take as it is. */
    recordShareable: recordable !== null && describeClipMime(recordable).shareable,
    render: renderable,
  };
}
// #endregion

// #region share
/** A finished clip to the share sheet where there is one, and a download where there is not. */
export async function share(clip: Blob): Promise<void> {
  await offerClip(clip, clip.type.includes('mp4') ? 'clip.mp4' : 'clip.webm');
}
// #endregion

// #region size
/**
 * The frame to record at, from what the renderer is managing in the window. A device below the
 * clip's rate records at two thirds the size, which keeps its rate: a slightly softer clip that
 * holds 30 fps reads better than a sharp one that judders.
 */
export function recordingSize(window: HTMLCanvasElement, measuredFps: number) {
  return exportSizeFor(1080, 1920, measuredFps, 30, window.width * window.height);
}
// #endregion

// #region pacer
/**
 * The pacer alone, for a page that captures frames some other way. It keeps every n-th animation
 * frame, n chosen from the loop's measured rate, so the frames kept are evenly spaced and so is
 * what they show; `report` says what it managed.
 */
const pacer = new FramePacer(30);

export function onAnimationFrame(nowMs: number, capture: () => void): void {
  if (!pacer.due(nowMs)) return;
  capture();
  pacer.offer(nowMs);
}

export function howItWent(): string {
  const { capturedFps, worstGapMs, slipped } = pacer.report;
  return `${capturedFps.toFixed(1)} fps, worst gap ${worstGapMs.toFixed(0)} ms, ${slipped} slipped`;
}
// #endregion

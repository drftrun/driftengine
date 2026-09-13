/**
 * Whether the pictures this browser encodes are the pictures it was given.
 *
 * Every other capability call asks whether the browser *says* it can do something. This one asks
 * whether it did, and it is the only one that has caught a file going out wrong.
 *
 * **The fault it exists for.** Chrome 149 with `chrome://flags#enable-vulkan` on, under Wayland,
 * composites through Vulkan while ANGLE stays on GL, and in that arrangement a `VideoFrame` built
 * from a canvas reaches the encoder empty. Nothing reports it: `VideoEncoder.error` never fires,
 * `encodeQueueSize` drains, `flush` resolves, the muxer finalises, and the app hands somebody a
 * clip that is solid green from end to end with its audio intact. Four went out that way from a
 * consuming app on 2026-08-14 before anybody opened one.
 *
 * Reproduced here from this repository's own harness, on an RX 9070 XT on RADV, with the flags as
 * the only variable: twelve frames of 1920x1080 encoded to 114,157 bytes with them off and 8,747
 * bytes with them on, and `ffprobe` read every frame of the second file back as YAVG 0, UAVG 0,
 * VAVG 0. All-zero YUV is green rather than black once a decoder applies the limited range.
 * `--headless=new` does not reproduce it at all, with or without Vulkan, which is consistent with
 * it taking the compositor and the ozone platform together.
 *
 * **So the check is a round trip rather than an inspection**, and three things that look like
 * witnesses are not: `getImageData` on the same canvas returns the right pixels in every run,
 * `VideoFrame.copyTo` reported full buffers for a case that went on to encode green, and every
 * capability call answers yes. What would make this module wrong is a browser that fails delivery
 * for some frames and not others, in which case one probe at the start is not enough; the fault
 * measured here is a property of the browser's configuration and does not vary frame to frame.
 */
import { clipCodecs } from './clipSupport.ts';

/** What the probe found. `unknown` is the answer that changes nothing. */
export type FrameDelivery = 'carries' | 'empty' | 'unknown';

/** Side of the probe frame. The smallest thing worth asking; it encodes to 39 bytes. */
const PROBE_SIZE = 64;

/**
 * The colour the probe paints: full red and full blue, no green.
 *
 * Chosen to be the opposite of the failure. An all-zero frame decodes to green with no red and no
 * blue in either colour space a browser might tag it with, BT.709 putting it at `0,77,0` and
 * BT.601 at `0,135,0`, so a picture that survived and a picture that did not cannot be confused
 * by a decoder's choice of matrix. A grey probe would have to tell them apart by brightness,
 * which is a threshold somebody has to guess at.
 */
const PROBE_COLOR = 'rgb(255 0 255)';

/** How long the round trip gets before it is abandoned. Far longer than it has ever taken. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * What a decoded probe colour means.
 *
 * **Only a positive reading of an empty frame refuses anything.** A probe that could not run, a
 * decoder that returned nothing, a colour this does not recognise: all `unknown`, and a caller
 * lets the export through on all of them. The two mistakes are not equal. A false negative costs
 * somebody a file they can already see is wrong; a false positive costs them every clip they were
 * going to make, on a machine where nothing was ever broken.
 */
export function deliveryVerdict(decoded: readonly [number, number, number] | null): FrameDelivery {
  if (decoded === null) return 'unknown';
  const [red, , blue] = decoded;
  /* Both channels the probe painted came back. Generous, because the round trip goes through a
     4:2:0 chroma subsample and a colour space conversion and neither is lossless. */
  if (red > 128 && blue > 128) return 'carries';
  /* Neither did, which no encode of this colour can produce. */
  if (red < 32 && blue < 32) return 'empty';
  return 'unknown';
}

/** One answer per session. See `framesReachEncoder`. */
let asked: Promise<FrameDelivery> | null = null;

/**
 * Paint a known colour, encode it, decode it back, and report what came out.
 *
 * Memoised for the session: the fault is a property of how the browser was started, so a second
 * answer cannot differ from the first, and an export path that asks before every attempt should
 * pay for one encode rather than one per press.
 *
 * Every failure path answers `unknown` rather than throwing, including the timeout. This runs in
 * front of an export, and a capability probe that can itself stop one has become a liability
 * rather than a check.
 */
export function framesReachEncoder(): Promise<FrameDelivery> {
  asked ??= run();
  return asked;
}

async function run(): Promise<FrameDelivery> {
  if (
    typeof document === 'undefined' ||
    typeof VideoEncoder !== 'function' ||
    typeof VideoDecoder !== 'function' ||
    typeof VideoFrame !== 'function'
  ) {
    return 'unknown';
  }
  try {
    return await Promise.race([
      roundTrip(),
      new Promise<FrameDelivery>((resolve) => {
        setTimeout(() => resolve('unknown'), PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return 'unknown';
  }
}

async function roundTrip(): Promise<FrameDelivery> {
  const codec = clipCodecs(PROBE_SIZE, PROBE_SIZE)[0];
  if (codec === undefined) return 'unknown';

  const canvas = document.createElement('canvas');
  canvas.width = PROBE_SIZE;
  canvas.height = PROBE_SIZE;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) return 'unknown';
  ctx.fillStyle = PROBE_COLOR;
  ctx.fillRect(0, 0, PROBE_SIZE, PROBE_SIZE);

  const chunks: EncodedVideoChunk[] = [];
  /* The type the decoder's own config field takes, which is wider than `BufferSource`: it
     accommodates a `SharedArrayBuffer`, and narrowing it here would only be a cast back. */
  let description: AllowSharedBufferSource | undefined;
  let failed = false;
  const config = {
    codec,
    width: PROBE_SIZE,
    height: PROBE_SIZE,
    bitrate: 1_000_000,
    framerate: 30,
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (support.supported !== true) return 'unknown';

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (description === undefined && meta?.decoderConfig?.description !== undefined) {
        description = meta.decoderConfig.description;
      }
      chunks.push(chunk);
    },
    error: () => {
      failed = true;
    },
  });
  encoder.configure(config);
  const frame = new VideoFrame(canvas, { timestamp: 0, duration: 33_333 });
  try {
    encoder.encode(frame, { keyFrame: true });
  } finally {
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  if (failed || chunks.length === 0) return 'unknown';

  let decoded: [number, number, number] | null = null;
  const decoder = new VideoDecoder({
    output: (picture) => {
      try {
        const read = document.createElement('canvas');
        read.width = PROBE_SIZE;
        read.height = PROBE_SIZE;
        const readCtx = read.getContext('2d', { alpha: false });
        if (readCtx !== null) {
          readCtx.drawImage(picture, 0, 0);
          const px = readCtx.getImageData(PROBE_SIZE / 2, PROBE_SIZE / 2, 1, 1).data;
          decoded = [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
        }
      } finally {
        picture.close();
      }
    },
    error: () => {
      failed = true;
    },
  });
  decoder.configure({
    codec,
    codedWidth: PROBE_SIZE,
    codedHeight: PROBE_SIZE,
    ...(description === undefined ? {} : { description }),
  });
  for (const chunk of chunks) decoder.decode(chunk);
  await decoder.flush();
  decoder.close();
  if (failed) return 'unknown';
  return deliveryVerdict(decoded);
}

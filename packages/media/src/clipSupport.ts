/**
 * What this browser will encode, asked before anything is built.
 *
 * One responsibility: turn a frame size into the codec strings an encode is negotiated with, and
 * answer whether this browser accepts them. `ClipEncoder.open` configures from the same ladder,
 * so a caller greying out a control and a caller pressing Export are asking one question rather
 * than two copies of it.
 *
 * **That was not the arrangement, and the gap shipped.** Both rungs used to be level 4.0 written
 * into the string by hand, and a level is a promise about frame *size*: 4.0 holds 8192
 * macroblocks, which is 1920x1080 with 32 to spare and nothing above it. So `isConfigSupported`
 * refused 2560x1440, 2160x2160 and 3840x2160 outright, `VideoEncoder.configure` was never reached
 * at those sizes, and a 4K export ended in "this browser cannot encode video at that size" on a
 * card that encodes 4K. A second consumer found it by copying the two strings into its own
 * repository to grey out a panel with, which is the shape of a decision that has no home.
 */

/**
 * Whether this browser can render a clip offline rather than record one.
 *
 * Both halves are needed: frames without a score is a silent clip and a score without
 * frames is nothing. A browser missing either falls back to the recorder.
 *
 * Says nothing about a *size*, deliberately: it is about the API being present at all, and it
 * answers the same for a 64x64 frame and a 4K one. `clipEncodingSupported` is the size question.
 */
export function offlineEncodingSupported(): boolean {
  return (
    typeof VideoEncoder === 'function' &&
    typeof AudioEncoder === 'function' &&
    typeof VideoFrame === 'function' &&
    typeof AudioData === 'function' &&
    typeof OfflineAudioContext === 'function'
  );
}

/**
 * The four numbers an encode is negotiated with, before there is anything to encode.
 *
 * `ClipEncoderOptions` extends it, so the question a gate asks is the options the export opens
 * with rather than a paraphrase of them.
 */
export interface ClipEncodeRequest {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Bits per second for video. See `clipBitrate` for a figure worth passing. */
  readonly bitrate: number;
}

/**
 * H.264 levels, smallest first, with the largest frame each can represent.
 *
 * `maxMacroblocks` is the spec's MaxFS, and on Chrome 149 it is exactly what
 * `isConfigSupported` enforces: measured over 9 sizes, 2 rates and 7 levels on an RX 9070 XT,
 * every level at or above the one whose MaxFS holds the frame answered yes and every level below
 * it answered no, in all 252 cells. Profile never moved an answer and neither did frame rate.
 *
 * **The rate bound is deliberately not part of the choice**, and that is the compromise here.
 * The spec's MaxMBPS says 1920x1080 at 60 needs level 4.2 and at 120 needs 5.1; this asks 4.0 for
 * both. It is defensible because the level in a codec string is a floor for the negotiation
 * rather than a description of the file: asked for 4.0 at 1920x1080, Chrome wrote **level 4.2**
 * into the file, and asked for 5.1 at 3840x2160 it wrote 5.2. What would make it wrong is a
 * browser that honours the floor literally and encodes a stream its own level cannot carry, which
 * nothing here has met. The rungs are worth having anyway for the size wall, which is real.
 *
 * Levels that hold no more than the one below are left out rather than listed: 4.1 has 4.0's
 * 8192, 5.2 has 5.1's 36864, 6.1 and 6.2 have 6.0's 139264. Asking for one of them buys a bigger
 * number in the string and no frame. Measured, at 3840x2160: a 5.1 request and a 5.2 request
 * produced the same byte count and the same level in the file.
 *
 * The table starts at 4.0 rather than at 1.0 because nothing below it changes an answer. A 720p
 * fallback frame is 3600 macroblocks and level 4.0 carries it, the encoder writes its own level
 * regardless, and lowering the floor would only put a smaller number in front of a browser that
 * has never been measured caring.
 */
const AVC_LEVELS: readonly { readonly id: number; readonly maxMacroblocks: number }[] = [
  { id: 0x28, maxMacroblocks: 8192 }, // 4.0
  { id: 0x2a, maxMacroblocks: 8704 }, // 4.2
  { id: 0x32, maxMacroblocks: 22_080 }, // 5.0
  { id: 0x33, maxMacroblocks: 36_864 }, // 5.1
  { id: 0x3c, maxMacroblocks: 139_264 }, // 6.0
];

/**
 * The codec strings to try for a frame this size, best first.
 *
 * High profile first, constrained baseline as the fallback, both at the smallest level that can
 * represent the frame. High is what every phone decodes in hardware and what a transcoder
 * prefers; baseline exists because a machine without hardware AVC will refuse the first and
 * encode the second in software rather than refuse to export. **Both rungs move together**: a
 * baseline rung pinned to 4.0 is no fallback at 4K, it is a second refusal.
 *
 * Empty when no level can hold the frame, which is a frame past 139,264 macroblocks. The caller
 * turns that into the same refusal it gives when the browser says no, one round trip earlier.
 *
 * Not on the barrel on purpose. The ladder is the engine's decision, and a consumer that can read
 * it is a consumer that can pin a codec string in its own repository, which is how one decision
 * became two copies the last time.
 */
export function clipCodecs(width: number, height: number): readonly string[] {
  /* Whole macroblocks: 1080 is 67.5 columns of 16 and costs 68 of them. */
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = AVC_LEVELS.find((rung) => macroblocks <= rung.maxMacroblocks);
  if (level === undefined) return [];
  const hex = level.id.toString(16).toUpperCase().padStart(2, '0');
  return [`avc1.6400${hex}`, `avc1.42E0${hex}`];
}

/** One answer per distinct request, kept for the session. See `clipEncodingSupported`. */
const answers = new Map<string, Promise<boolean>>();

/**
 * Whether this browser will encode a clip of this size, at this rate, at this bitrate.
 *
 * The question `ClipEncoder.open` is about to ask, asked early enough to grey out a control
 * instead of failing an export somebody already chose. It walks the same ladder `open` walks, so
 * the two cannot drift; a gate built from a copied codec string offered ten sizes the export
 * would refuse, which is the fault this exists to make unrepeatable.
 *
 * Memoised on the whole request, because the answer is a property of the machine rather than of
 * the moment: a panel asking about nine sizes at two rates costs eighteen probes at boot and
 * nothing afterwards. The promise is stored rather than the result, so eighteen concurrent asks
 * about one size are one probe.
 *
 * False when WebCodecs is absent, which is the same answer from the caller's point of view. What
 * it does **not** answer: whether the frames arrive once encoding starts. See `framesReachEncoder`.
 */
export async function clipEncodingSupported(request: ClipEncodeRequest): Promise<boolean> {
  const { width, height, fps, bitrate } = request;
  const key = `${width}x${height}@${fps}/${bitrate}`;
  const known = answers.get(key);
  if (known !== undefined) return known;
  const asking = ask(request);
  answers.set(key, asking);
  return asking;
}

async function ask({ width, height, fps, bitrate }: ClipEncodeRequest): Promise<boolean> {
  if (typeof VideoEncoder !== 'function') return false;
  for (const codec of clipCodecs(width, height)) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });
      if (support.supported === true) return true;
    } catch {
      // A codec string this build will not parse is one it cannot encode. Try the next rung.
    }
  }
  return false;
}

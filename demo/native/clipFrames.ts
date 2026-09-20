/**
 * A clip on the native host as a `FrameSource`, decoded by ffmpeg.
 *
 * **The seam exists for exactly this.** `packages/capture/src/frames.ts` says a host hands the
 * engine a `FrameSource` — a video element in a browser, a decoder on a native host, a folder of
 * stills in a test — and the engine never opens a file. `browserFrames.ts` is the browser's; this
 * is a native one, and writing it needed no change to anything in `packages/capture`.
 *
 * **ffmpeg is invoked, not linked**, which is the distinction `docs/FORMAT.md` already draws about
 * Blender: driving a separate process creates no derived work, so a GPL-licensed decoder on the
 * machine does not reach a permissively licensed engine. Nothing here ships — this is a harness,
 * and a native host that shipped capture would decode in process with whatever its platform gives
 * it. What this proves is the seam and the stages behind it, not a product's decoder.
 *
 * **One process per frame, and that is a deliberate simplicity.** A capture keeps a handful of
 * frames out of thousands, chosen before any of them is decoded, so seeking to each in turn costs
 * less than streaming the clip — and the alternative, a long-lived pipe with a frame protocol over
 * it, is a great deal of machinery for six frames. It would be the wrong choice for a source that
 * wanted every frame.
 */
import { execFileSync } from 'node:child_process';

import type { FrameSize, FrameSource } from '../../packages/capture/src/frames.ts';

export interface NativeClip extends FrameSource {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

interface Probed {
  width: number;
  height: number;
  rate: number;
  duration: number;
}

/** What ffprobe says about the clip: its size, its rate and how long it runs. */
function probe(file: string): Probed {
  const said = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,avg_frame_rate:format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=0',
      file,
    ],
    { encoding: 'utf8' },
  );
  const field = (name: string): string => {
    const found = new RegExp(`^${name}=(.*)$`, 'm').exec(said);
    if (found === null) throw new Error(`ffprobe said nothing about ${name} for ${file}`);
    return found[1] as string;
  };
  const [num, den] = field('avg_frame_rate').split('/');
  const rate = Number(den) > 0 ? Number(num) / Number(den) : Number(num);
  return {
    width: Number(field('width')),
    height: Number(field('height')),
    rate: Number.isFinite(rate) && rate > 0 ? rate : 30,
    duration: Number(field('duration')),
  };
}

/**
 * The clip at `file`, a frame at a time.
 *
 * **A frame is addressed by time, as the browser's is**, so a clip of variable frame rate answers
 * the frame covering that instant rather than the `index`-th one. Nothing in a capture needs a
 * particular frame — frames are chosen by motion or by a stride — and the two hosts agreeing on
 * that is what makes a capture comparable between them.
 */
export function nativeClip(file: string): NativeClip {
  const { width, height, rate, duration } = probe(file);
  const count = Math.max(1, Math.floor(duration * rate));
  const bytes = width * height * 4;

  return {
    width,
    height,
    frameRate: rate,

    frameCount: () => count,

    frameAt(index: number, out: Uint8Array): FrameSize {
      if (out.length >= bytes) {
        /* The middle of the frame, so rounding cannot land on the boundary either side. */
        const at = Math.min((index + 0.5) / rate, Math.max(0, duration - 1 / rate));
        const raw = execFileSync(
          'ffmpeg',
          [
            '-v',
            'error',
            /* Before `-i`, so ffmpeg seeks rather than decoding everything up to the instant. */
            '-ss',
            at.toFixed(6),
            '-i',
            file,
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgba',
            '-',
          ],
          { maxBuffer: bytes * 4 },
        );
        if (raw.length < bytes) {
          throw new Error(
            `ffmpeg returned ${raw.length} bytes for frame ${index} of ${file}, ` +
              `where ${width}×${height} RGBA is ${bytes}`,
          );
        }
        out.set(raw.subarray(0, bytes));
      }
      return { width, height };
    },
  };
}

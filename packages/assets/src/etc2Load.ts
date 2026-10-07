/**
 * BC textures re-encoded as ETC2 or EAC for a device that samples those and not BC — which is a
 * phone — and the worker that does it.
 *
 * **After the picture, not before it.** Such a texture is decoded and shown as RGBA first, exactly
 * as it was before this existed (`bcLoad.ts`), and its blocks then go to an encode worker of their
 * own; the chain that comes back replaces the image behind the handle every draw already holds
 * (`updateSurfaceTexture`). So nothing arrives later than it did, and the texture ends at half a
 * byte a texel, or a byte with alpha, where it held four. **What it costs** is the encode, on a core
 * of its own: measured at 0.7 s for a 2048² photograph on a desktop processor, and several times
 * that on a phone's, one texture at a time. **What it gives up** is the memory a load peaks at,
 * which is still every texture as RGBA until the encodes catch up: what would make that wrong is a
 * device that cannot hold the RGBA at all, and the answer then is blocks it samples in the file,
 * which a KTX2 texture carries through as they are.
 *
 * **A worker of its own, not the decode worker**, so a texture waiting to be decoded never waits
 * behind a second of somebody else's encode; and one job in flight at a time, so a model's hundred
 * textures are a hundred small messages queued here rather than a hundred copies of their blocks
 * queued there. **Never on the main thread**: where no worker was named, or the one started fails,
 * the textures stay RGBA and the loader says why once — a texture held at four bytes a texel is
 * the state this improves on, never a stall.
 */
import { uploadsCompressed } from '@driftengine/core';
import type { CompressedTextureFormat, CompressedTextureSource } from '@driftengine/core';
import type { BcImage } from '@driftengine/drft';

import type { BcWorker } from './bcLoad.ts';
import type { Etc2Reply, Etc2Request } from './etc2Answer.ts';

export type { Etc2Reply, Etc2Request } from './etc2Answer.ts';
export { answerEtc2Request } from './etc2Answer.ts';

/**
 * Whether `image` can go up as ETC2 or EAC on a device offering `available`, read in the colour
 * space the slot reads: every format it could become, since which colour format is decided by the
 * decoded alpha. EAC has no sRGB twin, so a BC4 or BC5 texture read as colour stays an image.
 */
export function etc2Plan(
  image: BcImage,
  srgb: boolean,
  available: readonly CompressedTextureFormat[],
): boolean {
  const { format, width, height } = image;
  if (format === 'bc4') return uploadsCompressed('eac-r11', srgb, width, height, available);
  if (format === 'bc5') return uploadsCompressed('eac-rg11', srgb, width, height, available);
  return (
    uploadsCompressed('etc2-rgb8', srgb, width, height, available) &&
    uploadsCompressed('etc2-rgba8', srgb, width, height, available)
  );
}

/** BC textures to ETC2 or EAC chains, one at a time, on a worker. */
export interface Etc2Encoder {
  encode(image: BcImage, srgb: boolean): Promise<CompressedTextureSource>;
  /** Empty while the worker lives; otherwise why the textures stay RGBA. */
  readonly reason: string;
  dispose(): void;
}

interface Job {
  readonly id: number;
  readonly image: BcImage;
  readonly srgb: boolean;
  resolve(source: CompressedTextureSource): void;
  reject(error: Error): void;
}

/** An encoder over a worker `spawn` starts: the same factory the decoder is given. */
export function createEtc2Encoder(spawn: () => BcWorker): Etc2Encoder {
  let worker: BcWorker | null = null;
  let reason = '';
  let running: Job | null = null;
  const waiting: Job[] = [];
  let next = 0;

  const stop = (why: string): void => {
    reason = why;
    worker?.terminate();
    worker = null;
    const error = new Error(why);
    running?.reject(error);
    running = null;
    for (const job of waiting) job.reject(error);
    waiting.length = 0;
  };

  const pump = (): void => {
    const target = worker;
    if (running !== null || target === null) return;
    const job = waiting.shift();
    if (job === undefined) return;
    running = job;
    const { image } = job;
    /* A copy, for the reason `bcLoad.ts` gives: a level is a view over the fetched file. */
    const blocks = (image.levels[0] as Uint8Array).slice().buffer;
    const request: Etc2Request = {
      kind: 'etc2',
      id: job.id,
      format: image.format,
      width: image.width,
      height: image.height,
      blocks,
      srgb: job.srgb,
    };
    target.postMessage(request, [blocks]);
  };

  try {
    const started = spawn();
    worker = started;
    started.onmessage = (event): void => {
      const reply = event.data as Etc2Reply;
      const job = running;
      if (job === null || reply.id !== job.id) return;
      running = null;
      if (reply.format !== undefined && reply.levels !== undefined) {
        const levels = reply.levels.map((level) => new Uint8Array(level));
        const { width, height } = job.image;
        job.resolve({ format: reply.format, width, height, levels });
      } else {
        job.reject(new Error(reply.error ?? 'etc2: the encode answered nothing'));
      }
      pump();
    };
    started.onerror = (event): void => {
      const message = (event as { message?: unknown } | null)?.message;
      stop(
        `the ETC2 worker failed (${typeof message === 'string' ? message : 'no message'}), so ` +
          'BC textures stay RGBA on this device',
      );
    };
  } catch (error) {
    stop(
      `the ETC2 worker would not start (${error instanceof Error ? error.message : String(error)})` +
        ', so BC textures stay RGBA on this device',
    );
  }

  return {
    get reason(): string {
      return reason;
    },
    encode(image: BcImage, srgb: boolean): Promise<CompressedTextureSource> {
      if (worker === null) return Promise.reject(new Error(reason));
      return new Promise((resolve, reject) => {
        waiting.push({ id: next++, image, srgb, resolve, reject });
        pump();
      });
    },
    dispose(): void {
      stop('etc2: the encoder was disposed');
    },
  };
}

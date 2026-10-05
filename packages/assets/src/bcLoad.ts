/**
 * BC textures as the loader receives them: which go up as their blocks, and the decode of the rest
 * off the main thread.
 *
 * **Blocks where the device takes them**, through `uploadsCompressed`, and only with a chain: no
 * chain can be generated for blocks on the device, and a large texture with no mips crawls at a
 * distance, so a single stored level is decoded and given generated mips instead. **Decoded
 * otherwise**, which on a phone is every BC texture: in a worker, because a 2048² BC7 image is
 * 262,144 blocks and a phone's main thread spends the better part of a second on them.
 *
 * **Never silently slower.** Where there is no `Worker`, or the one this module starts fails to
 * load — a bundler that does not understand `new Worker(new URL(…))` — the decode moves to the main
 * thread and `reason` says so, and the loader prints it once. A request in flight when the worker
 * fails is decoded again there rather than left waiting.
 */
import { uploadsCompressed } from '@driftengine/core';
import type { CompressedTextureFormat } from '@driftengine/core';
import type { BcImage } from '@driftengine/drft';

import { answerBcRequest } from './bcAnswer.ts';
import type { BcReply, BcRequest } from './bcAnswer.ts';

export type { BcReply, BcRequest } from './bcAnswer.ts';
export { answerBcRequest } from './bcAnswer.ts';

/** What happens to one BC texture. */
export type BcPlan = 'blocks' | 'decode';

/** Blocks where this device takes the format in the colour space the slot reads, with a chain. */
export function bcPlan(
  image: BcImage,
  srgb: boolean,
  available: readonly CompressedTextureFormat[],
): BcPlan {
  const chained = image.levels.length > 1 || Math.max(image.width, image.height) <= 4;
  return chained && uploadsCompressed(image.format, srgb, image.width, image.height, available)
    ? 'blocks'
    : 'decode';
}

/** The part of a worker the decoder uses. A browser `Worker` satisfies it. */
export interface BcWorker {
  postMessage(request: BcRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

/** Level 0 of a BC image decoded to RGBA, off the main thread where one is to be had. */
export interface BcDecoder {
  decode(image: BcImage, asImage: boolean): Promise<Uint8Array>;
  /** Empty while a worker decodes; otherwise why the main thread does. */
  readonly reason: string;
  dispose(): void;
}

interface Pending {
  readonly image: BcImage;
  readonly asImage: boolean;
  resolve(rgba: Uint8Array): void;
  reject(error: Error): void;
}

function request(id: number, image: BcImage, asImage: boolean): BcRequest {
  /* A copy, so the transfer detaches nothing the loader still holds: a level is a view over the
     fetched file, and every other view over that file would read as empty afterwards. */
  const blocks = (image.levels[0] as Uint8Array).slice().buffer;
  return { id, format: image.format, width: image.width, height: image.height, blocks, asImage };
}

function settle(reply: BcReply, pending: Pending): void {
  if (reply.rgba !== undefined) pending.resolve(new Uint8Array(reply.rgba));
  else pending.reject(new Error(reply.error ?? 'bc: the decode answered nothing'));
}

/**
 * The worker this package ships, built the way a bundler understands, or null where there is no
 * `Worker` at all. `createBcDecoder`'s `spawn` is the way past either.
 */
const defaultSpawn: (() => BcWorker) | null =
  // platform: feature probe — no `Worker` means BC decodes on the main thread, with a reason
  typeof Worker === 'undefined'
    ? null
    : (): BcWorker =>
        // platform: browser default — `createBcDecoder(spawn)` is the seam a host supplies
        new Worker(new URL('./bcWorker.ts', import.meta.url), {
          type: 'module',
        }) as unknown as BcWorker;

export function createBcDecoder(spawn: (() => BcWorker) | null = defaultSpawn): BcDecoder {
  let worker: BcWorker | null = null;
  let reason = '';
  const pending = new Map<number, Pending>();
  let next = 0;

  const onMainThread = (why: string): void => {
    reason = `BC textures decode on the main thread: ${why}`;
    worker?.terminate();
    worker = null;
    for (const [id, waiting] of pending)
      settle(answerBcRequest(request(id, waiting.image, waiting.asImage)), waiting);
    pending.clear();
  };

  if (spawn === null) {
    reason = 'BC textures decode on the main thread: this runtime has no Worker';
  } else {
    try {
      worker = spawn();
      worker.onmessage = (event): void => {
        const reply = event.data as BcReply;
        const waiting = pending.get(reply.id);
        if (waiting === undefined) return;
        pending.delete(reply.id);
        settle(reply, waiting);
      };
      worker.onerror = (event): void => {
        const message = (event as { message?: unknown } | null)?.message;
        onMainThread(`the worker failed (${typeof message === 'string' ? message : 'no message'})`);
      };
    } catch (error) {
      onMainThread(
        `the worker would not start (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  return {
    get reason(): string {
      return reason;
    },
    decode(image: BcImage, asImage: boolean): Promise<Uint8Array> {
      const id = next++;
      const target = worker;
      if (target === null) {
        return new Promise((resolve, reject) => {
          settle(answerBcRequest(request(id, image, asImage)), { image, asImage, resolve, reject });
        });
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { image, asImage, resolve, reject });
        const message = request(id, image, asImage);
        target.postMessage(message, [message.blocks]);
      });
    },
    dispose(): void {
      worker?.terminate();
      worker = null;
      for (const waiting of pending.values())
        waiting.reject(new Error('bc: the decoder was disposed'));
      pending.clear();
    },
  };
}

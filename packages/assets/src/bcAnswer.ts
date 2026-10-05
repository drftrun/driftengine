/**
 * The BC worker's whole job, as a function: one request's level 0 decoded, or the reason it could
 * not be. Its own module so the worker imports the decoders and nothing else — not the loader, and
 * not the engine's barrel behind it.
 *
 * Decoded **as a GPU samples it** for the loader's own textures, so a decode at load looks like an
 * upload of the same blocks: BC4 red alone, BC5 red and green, the lit shader rebuilding a normal's
 * z either way. Decoded **as an ordinary image** (`asImage`) for a consumer taking images through
 * `onImage`, who builds textures the engine does not see. An error is answered rather than thrown,
 * so one bad texture fails on its own and the worker lives on.
 */
import type { BcFormat } from '@driftengine/drft';

import { decodeBc } from './bcDecode.ts';
import { decodeBcImage } from './bcImage.ts';

/** What the loader asks the worker: one level's blocks, handed over as a buffer of their own. */
export interface BcRequest {
  readonly id: number;
  readonly format: BcFormat;
  readonly width: number;
  readonly height: number;
  readonly blocks: ArrayBuffer;
  readonly asImage: boolean;
}

/** The answer: RGBA, eight bits a channel, or why not. */
export interface BcReply {
  readonly id: number;
  readonly rgba?: ArrayBuffer;
  readonly error?: string;
}

export function answerBcRequest(request: BcRequest): BcReply {
  try {
    const blocks = new Uint8Array(request.blocks);
    const { format, width, height } = request;
    const rgba = request.asImage
      ? decodeBcImage(format, width, height, blocks)
      : decodeBc(format, width, height, blocks);
    return { id: request.id, rgba: rgba.buffer as ArrayBuffer };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}

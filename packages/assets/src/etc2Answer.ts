/**
 * The encode worker's whole job, as a function: one BC texture's level 0 decoded as a GPU samples
 * it and made into an ETC2 or EAC chain (`etc2Chain.ts`), or the reason it could not be. Its own
 * module beside `bcAnswer.ts`, which the same worker answers decode requests with.
 *
 * **The blocks cross, not the pixels**: the loader has already decoded this texture once, for the
 * picture it shows while this runs, and hands its blocks over again rather than a copy of that
 * image — a quarter to an eighth of the bytes, decoded a second time here at about a fifth of the
 * encode's cost. An error is answered rather than thrown, so one bad texture fails on its own.
 */
import type { BcFormat } from '@driftengine/drft';

import { decodeBc } from './bcDecode.ts';
import { encodeEtc2Chain, etc2FormatFor } from './etc2Chain.ts';
import type { Etc2Format } from './etc2Encode.ts';

/** What the loader asks the encode worker: one level's BC blocks, and how the texture is read. */
export interface Etc2Request {
  readonly kind: 'etc2';
  readonly id: number;
  readonly format: BcFormat;
  readonly width: number;
  readonly height: number;
  readonly blocks: ArrayBuffer;
  /** Whether the slot reads colour, so the chain is averaged in light. */
  readonly srgb: boolean;
}

/** The answer: every level of the chain in one format, or why not. */
export interface Etc2Reply {
  readonly id: number;
  readonly format?: Etc2Format;
  readonly levels?: ArrayBuffer[];
  readonly error?: string;
}

export function answerEtc2Request(request: Etc2Request): Etc2Reply {
  try {
    const { width, height } = request;
    const rgba = decodeBc(request.format, width, height, new Uint8Array(request.blocks));
    const format = etc2FormatFor(request.format, rgba);
    const colour = format === 'etc2-rgb8' || format === 'etc2-rgba8';
    const levels = encodeEtc2Chain(format, rgba, width, height, colour && request.srgb);
    return { id: request.id, format, levels: levels.map((level) => level.buffer as ArrayBuffer) };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}

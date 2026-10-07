import { expect, it } from 'vitest';

import type { BcImage } from '@driftengine/drft';

import type { BcWorker } from './bcLoad.ts';
import { answerEtc2Request, createEtc2Encoder, etc2Plan } from './etc2Load.ts';
import type { Etc2Request } from './etc2Load.ts';

/** An 8x8 BC1 image, its four blocks in four-colour mode — red to blue — so it decodes opaque. */
function image(format: BcImage['format'] = 'bc1'): BcImage {
  const block = format === 'bc5' ? 16 : 8;
  const level = new Uint8Array(4 * block);
  for (let b = 0; b < 4; b++) {
    level.set([0x00, 0xf8, 0x1f, 0x00, 0x1b, 0xe4, 0x1b, 0xe4], b * block);
  }
  return { format, srgb: true, width: 8, height: 8, levels: [level] };
}

const ETC2 = ['etc2-rgb8', 'etc2-rgb8-srgb', 'etc2-rgba8', 'etc2-rgba8-srgb'] as const;

/*
 * **Only where every format the texture could become is taken, in the colour space it is read
 * in.** Colour needs both ETC2 formats, since which one is decided by the alpha after the decode;
 * a BC5 map needs EAC's two channels, and read as colour it has no sRGB twin to go to at all.
 */
it('A BC TEXTURE IS RE-ENCODED ONLY WHERE THE DEVICE TAKES WHAT IT WOULD BECOME', () => {
  expect(etc2Plan(image(), true, [...ETC2])).toBe(true);
  expect(etc2Plan(image(), true, ['etc2-rgb8', 'etc2-rgba8']), 'sRGB wanted').toBe(false);
  expect(etc2Plan(image(), true, ['etc2-rgb8-srgb']), 'no alpha format').toBe(false);
  expect(etc2Plan(image(), false, []), 'a device with neither').toBe(false);
  expect(etc2Plan(image('bc5'), false, ['eac-rg11'])).toBe(true);
  expect(etc2Plan(image('bc5'), true, ['eac-rg11']), 'EAC has no sRGB').toBe(false);
});

/*
 * **One job at a time, matched to its answer, the chain whole.** Three textures asked for at once
 * post one request; its answer — the worker's own function, run here — posts the next. A worker
 * that fails takes every waiting texture with it, and says the textures stay RGBA.
 */
it('ENCODES ONE TEXTURE AT A TIME ON THE WORKER, AND A FAILED WORKER LEAVES THEM RGBA', async () => {
  const posted: Etc2Request[] = [];
  let listener: ((event: { data: unknown }) => void) | null = null;
  let failure: ((event: unknown) => void) | null = null;
  const worker: BcWorker = {
    postMessage: (request) => posted.push(request as Etc2Request),
    terminate: () => undefined,
    set onmessage(handler: ((event: { data: unknown }) => void) | null) {
      listener = handler;
    },
    get onmessage() {
      return listener;
    },
    set onerror(handler: ((event: unknown) => void) | null) {
      failure = handler;
    },
    get onerror() {
      return failure;
    },
  };
  const encoder = createEtc2Encoder(() => worker);
  const first = encoder.encode(image(), true);
  const second = encoder.encode(image(), true);
  const third = encoder.encode(image(), false);
  expect(posted, 'one in flight').toHaveLength(1);
  expect(posted[0]).toMatchObject({ kind: 'etc2', format: 'bc1', width: 8, height: 8, srgb: true });

  (listener as unknown as (event: { data: unknown }) => void)({
    data: answerEtc2Request(posted[0] as Etc2Request),
  });
  const chain = await first;
  expect(chain.format).toBe('etc2-rgb8');
  expect([chain.width, chain.height]).toEqual([8, 8]);
  /* 8x8 is four blocks of eight bytes; then 4x4, 2x2 and 1x1, one block each. */
  expect(chain.levels.map((level) => level.length)).toEqual([32, 8, 8, 8]);
  expect(posted, 'and the next one posted').toHaveLength(2);

  (failure as unknown as (event: unknown) => void)({ message: 'gone' });
  await expect(second).rejects.toThrow(/stay RGBA/);
  await expect(third).rejects.toThrow(/stay RGBA/);
  expect(encoder.reason).toMatch(/failed \(gone\)/);
  await expect(encoder.encode(image(), true)).rejects.toThrow(/stay RGBA/);
});

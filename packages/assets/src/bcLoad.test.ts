import { expect, it } from 'vitest';

import { decodeBc } from './bcDecode.ts';
import { decodeBcImage } from './bcImage.ts';
import { answerBcRequest, bcPlan, createBcDecoder } from './bcLoad.ts';
import type { BcRequest, BcWorker } from './bcLoad.ts';
import type { BcImage } from '@driftengine/drft';

/** One 8x8 BC1 image of `levels` levels, every block a different byte so a decode can be told. */
function image(levels: number, size = 8): BcImage {
  const out: Uint8Array[] = [];
  for (let level = 0; level < levels; level++) {
    const side = Math.max(1, size >> level);
    const bytes = new Uint8Array(Math.ceil(side / 4) ** 2 * 8);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + level * 11) & 0xff;
    out.push(bytes);
  }
  return { format: 'bc1', srgb: true, width: size, height: size, levels: out };
}

/*
 * **Blocks where the device takes them and a chain came with them; decoded otherwise.** A device
 * offering nothing — a phone — decodes. A single stored level is decoded too, because no chain can
 * be generated for blocks on the device, and a large texture with no mips crawls at a distance;
 * where a single level is the whole chain to speak of (a block or smaller), it goes up as it is.
 */
it('A BC TEXTURE GOES UP AS BLOCKS ONLY WHERE THE DEVICE TAKES IT AND A CHAIN CAME WITH IT', () => {
  expect(bcPlan(image(4), true, ['bc1-srgb'])).toBe('blocks');
  expect(bcPlan(image(4), true, ['bc1']), 'linear offered, sRGB wanted').toBe('decode');
  expect(bcPlan(image(4), true, []), 'a phone').toBe('decode');
  expect(bcPlan(image(1), true, ['bc1-srgb']), 'one level of 8x8: no chain').toBe('decode');
  expect(bcPlan(image(1, 4), true, ['bc1-srgb']), 'one level of 4x4 is enough').toBe('blocks');
});

/*
 * The worker's whole job, as a function: level 0 decoded as a GPU would sample it, or as an ordinary
 * image for a consumer who builds its own textures, and an error answered rather than thrown, so a
 * bad texture fails on its own and the worker lives.
 */
it('answers a request with level 0 decoded either way, and a refusal with its reason', () => {
  const bc = image(2);
  const level = bc.levels[0] as Uint8Array;
  const request = (asImage: boolean): BcRequest => ({
    id: 3,
    format: 'bc1',
    width: 8,
    height: 8,
    blocks: level.slice().buffer,
    asImage,
  });
  const gpu = answerBcRequest(request(false));
  expect(gpu.id).toBe(3);
  expect(Array.from(new Uint8Array(gpu.rgba ?? new ArrayBuffer(0)))).toEqual(
    Array.from(decodeBc('bc1', 8, 8, level)),
  );
  const asImage = answerBcRequest(request(true));
  expect(Array.from(new Uint8Array(asImage.rgba ?? new ArrayBuffer(0)))).toEqual(
    Array.from(decodeBcImage('bc1', 8, 8, level)),
  );
  const short = answerBcRequest({ ...request(false), blocks: new ArrayBuffer(4) });
  expect(short.rgba).toBeUndefined();
  expect(short.error).toMatch(/needs 32 bytes/);
});

/*
 * **The client matches each answer to its request**, through a worker that answers out of order —
 * which a real one may, and which a client counting replies would get wrong — and it hands the
 * blocks over as a copy, so the file the loader still holds is never detached.
 */
it('matches answers to requests out of order, and never detaches the file it was given', async () => {
  const held: BcRequest[] = [];
  const hook: { listener: ((event: { data: unknown }) => void) | null } = { listener: null };
  const worker: BcWorker = {
    /* Transferred as a real worker's postMessage would, so a buffer handed over is detached here. */
    postMessage: (request: BcRequest, transfer?: Transferable[]) =>
      held.push(structuredClone(request, { transfer: (transfer ?? []) as ArrayBuffer[] })),
    terminate: () => undefined,
    set onmessage(handler: ((event: { data: unknown }) => void) | null) {
      hook.listener = handler;
    },
  };
  const decoder = createBcDecoder(() => worker);
  const a = image(1);
  const b = { ...image(1), levels: [new Uint8Array(32).fill(0xff)] };
  const first = decoder.decode(a, false);
  const second = decoder.decode(b, false);
  expect(held).toHaveLength(2);
  for (const request of [...held].reverse()) hook.listener?.({ data: answerBcRequest(request) });
  expect(Array.from(await first)).toEqual(
    Array.from(decodeBc('bc1', 8, 8, a.levels[0] as Uint8Array)),
  );
  expect(Array.from(await second)).toEqual(
    Array.from(decodeBc('bc1', 8, 8, b.levels[0] as Uint8Array)),
  );
  expect((a.levels[0] as Uint8Array).byteLength, 'the source was copied, not transferred').toBe(32);
  decoder.dispose();
});

/* With no worker to be had, the same answer on the main thread — slower, said once, never wrong. */
it('decodes on the main thread where there is no worker, with the same answer', async () => {
  const decoder = createBcDecoder(null);
  const a = image(1);
  expect(Array.from(await decoder.decode(a, true))).toEqual(
    Array.from(decodeBcImage('bc1', 8, 8, a.levels[0] as Uint8Array)),
  );
  expect(decoder.reason).toMatch(/main thread/);
});

/*
 * **A worker that fails after work was handed to it does not strand that work.** A bundler that
 * cannot resolve the worker's URL starts it anyway and reports the failure as an error event, after
 * the first textures were posted; those are decoded on the main thread, and every later one too.
 */
it('decodes what was in flight on the main thread when the worker fails', async () => {
  const hook: { fail: ((event: unknown) => void) | null } = { fail: null };
  const worker: BcWorker = {
    postMessage: () => undefined,
    terminate: () => undefined,
    onmessage: null,
    set onerror(handler: ((event: unknown) => void) | null) {
      hook.fail = handler;
    },
  };
  const decoder = createBcDecoder(() => worker);
  const a = image(1);
  const waiting = decoder.decode(a, false);
  expect(decoder.reason).toBe('');
  hook.fail?.({ message: 'could not load the worker module' });
  expect(Array.from(await waiting)).toEqual(
    Array.from(decodeBc('bc1', 8, 8, a.levels[0] as Uint8Array)),
  );
  expect(decoder.reason).toMatch(
    /main thread: the worker failed \(could not load the worker module\)/,
  );
  expect(Array.from(await decoder.decode(a, false))).toHaveLength(8 * 8 * 4);
});

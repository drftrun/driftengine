import { describe, expect, it, test } from 'vitest';
import { SoundRegistry } from './registry.ts';
import type { FetchLike } from './registry.ts';

/** Enough of an AudioBuffer to be identifiable; nothing here plays anything. */
const FILE_BUFFER = { id: 'from-file' } as unknown as AudioBuffer;
const SYNTH_BUFFER = { id: 'from-synth' } as unknown as AudioBuffer;

function ctx(decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>): BaseAudioContext {
  return { decodeAudioData: decode } as unknown as BaseAudioContext;
}

const goodCtx = ctx(async () => FILE_BUFFER);
const synth = (): AudioBuffer => SYNTH_BUFFER;

function serving(available: Record<string, boolean>): FetchLike {
  return async (url) =>
    ({
      ok: available[url] === true,
      status: available[url] === true ? 200 : 404,
      arrayBuffer: async () => new ArrayBuffer(8),
    }) as unknown as Response;
}

test('a slot with a present file resolves to the file', async () => {
  const registry = new SoundRegistry(serving({ '/audio/jump.opus': true }));
  registry.register('jump', { urls: ['/audio/jump.opus'], synth });
  await registry.load(goodCtx);

  expect(registry.resolved.get('jump')).toBe('file');
  expect(registry.get('jump')).toBe(FILE_BUFFER);
});

test('a missing file falls back to synthesis rather than failing', async () => {
  const registry = new SoundRegistry(serving({}));
  registry.register('jump', { urls: ['/audio/jump.opus'], synth });
  await registry.load(goodCtx);

  // Development must not be blocked on assets existing, and a missing file must
  // never take the audio graph down with it.
  expect(registry.resolved.get('jump')).toBe('synth');
  expect(registry.get('jump')).toBe(SYNTH_BUFFER);
});

test('one missing file does not prevent the others loading', async () => {
  // The test that earns its place: assets arrive by hand, a few at a time, so
  // a partially populated folder is the normal state for months. A single
  // absent file silencing the whole game would be found late and blamed on
  // something else.
  const registry = new SoundRegistry(serving({ '/audio/land.opus': true }));
  registry.register('jump', { urls: ['/audio/jump.opus'], synth });
  registry.register('land', { urls: ['/audio/land.opus'], synth });
  await registry.load(goodCtx);

  expect(registry.resolved.get('land')).toBe('file');
  expect(registry.resolved.get('jump')).toBe('synth');
});

test('a decode failure is treated as a missing file, not a crash', async () => {
  // A corrupt or half-uploaded asset is the likeliest real-world failure, and
  // it arrives as a rejected decode rather than a 404.
  const registry = new SoundRegistry(serving({ '/audio/jump.opus': true }));
  registry.register('jump', { urls: ['/audio/jump.opus'], synth });
  await registry.load(
    ctx(async () => {
      throw new Error('not audio');
    }),
  );

  expect(registry.resolved.get('jump')).toBe('synth');
  expect(registry.get('jump')).toBe(SYNTH_BUFFER);
});

test('a network error is also just a missing file', async () => {
  const registry = new SoundRegistry(async () => {
    throw new Error('offline');
  });
  registry.register('jump', { urls: ['/audio/jump.opus'], synth });
  await registry.load(goodCtx);

  expect(registry.resolved.get('jump')).toBe('synth');
});

test('the first candidate that loads wins, and earlier misses are not failures', async () => {
  /*
   * Slots list several formats because a sound arrives in whatever format it
   * was made in. Only one will ever be present, so every request but one is
   * expected to 404 — treating those as errors would mean every slot in the
   * game reported a failure on every load.
   */
  const registry = new SoundRegistry(serving({ '/audio/track-1.mp3': true }));
  registry.register('track-1', {
    urls: ['/audio/track-1.opus', '/audio/track-1.mp3', '/audio/track-1.wav'],
    synth,
  });
  await registry.load(goodCtx);

  expect(registry.resolved.get('track-1')).toBe('file');
  expect(registry.get('track-1')).toBe(FILE_BUFFER);
});

test('no two stand-ins are built in the same task', async () => {
  /*
   * The property that keeps a load off the frame loop. Synthesis is arithmetic
   * on the main thread — an ambience bed is seconds of filtered noise — and
   * before this the fallbacks all settled in one microtask drain: traced in a
   * consumer as blocks of 11, 14, 14, 21 and 34 ms, and 125 ms between two
   * frames because the vsync deadline kept landing inside one.
   *
   * Observed rather than asserted about the implementation: a chained timer
   * counts the tasks going past, and every stand-in has to see a different
   * count. Two built in one task would see the same one.
   */
  let task = 0;
  let pumping = true;
  const pump = (): void => {
    if (!pumping) return;
    task++;
    setTimeout(pump, 0);
  };
  setTimeout(pump, 0);

  const seen: number[] = [];
  const registry = new SoundRegistry(serving({}));
  for (const slot of ['jump', 'land', 'hurt', 'notify']) {
    registry.register(slot, {
      urls: [`/audio/${slot}.opus`],
      synth: () => {
        seen.push(task);
        return SYNTH_BUFFER;
      },
    });
  }
  await registry.load(goodCtx);
  pumping = false;

  expect(seen).toHaveLength(4);
  expect(new Set(seen).size).toBe(4);
});

describe('a stand-in that throws', () => {
  /**
   * **The paragraph in `load` promised this and the loop did not deliver it.** File failures land
   * on `allSettled` and every one is contained; a synth that threw took the whole `load` down, so
   * every slot after it in registration order was left with no buffer — and `play` returns
   * silently on an undefined one. A game where the first few sounds work and the rest do not, with
   * nothing in the console, and the boundary falling wherever the bad slot happened to be
   * registered.
   */
  it('does not silence the slots registered after it', async () => {
    const registry = new SoundRegistry();
    registry.register('first', { urls: [], synth: () => SYNTH_BUFFER });
    registry.register('broken', {
      urls: [],
      synth: () => {
        throw new Error('no');
      },
    });
    registry.register('last', { urls: [], synth: () => SYNTH_BUFFER });

    await registry.load(ctx(async () => FILE_BUFFER));

    expect(registry.get('first'), 'before the bad one').toBeDefined();
    expect(registry.get('last'), 'after the bad one — this is the whole bug').toBeDefined();
    expect(registry.get('broken'), 'and the bad one is simply silent').toBeUndefined();
  });

  it('says which slot could not be built, because a silent one looks like an untriggered one', async () => {
    const registry = new SoundRegistry();
    registry.register('broken', {
      urls: [],
      synth: () => {
        throw new Error('bad partials');
      },
    });
    await registry.load(ctx(async () => FILE_BUFFER));
    expect(registry.unbuilt.get('broken')).toContain('bad partials');
  });
});

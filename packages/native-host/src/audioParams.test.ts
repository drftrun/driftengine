import { describe, expect, test } from 'vitest';

import { hostAudioContexts } from './audio.ts';

/**
 * **What this file is for: a parameter ramp that sounds the same as in Chrome.** The engine moves
 * every level and cutoff with `setTargetAtTime` scheduled ahead of now, and `node-web-audio-api`
 * 2.2.0 renders such a ramp wrongly until it starts whenever the event before it has settled: 31.1
 * for a gain holding at 1, 10.5 for one that ramped to 0.5, a filter at −839,731 Hz. The host
 * corrects it (`audioParams.ts`). Every expected value below is Chrome's, measured 2026-09-19 by
 * rendering the same automation there.
 */

const { OfflineAudioContext } = hostAudioContexts({ sink: 'none' });
const RATE = 48000;

/** A parameter's value over one second, sampled at the times given. */
async function trace(automate: (param: AudioParam) => void, times: number[]): Promise<number[]> {
  const context = new OfflineAudioContext(1, RATE, RATE);
  const source = context.createConstantSource();
  source.offset.value = 0;
  automate(source.offset);
  source.connect(context.destination);
  source.start();
  const samples = (await context.startRendering()).getChannelData(0);
  return times.map((t) => Number((samples[Math.floor(t * RATE)] as number).toFixed(4)));
}

const TIMES = [0.1, 0.29, 0.31, 0.4, 0.6];
/* A gain at 1 easing to 0.25 from 0.3 s with a time constant of 0.08, as Chrome renders it. */
const EASED = [1, 1, 0.9119, 0.4649, 0.2676];

describe('a ramp scheduled ahead, on the native host', () => {
  test('FROM A VALUE THAT IS SIMPLY SET, it holds until it starts', async () => {
    expect(
      await trace((p) => {
        p.value = 1;
        p.setTargetAtTime(0.25, 0.3, 0.08);
      }, TIMES),
    ).toEqual(EASED);
  });

  test('FROM A VALUE SET AT A TIME, and after the cancel the engine ramps with', async () => {
    expect(
      await trace((p) => {
        p.setValueAtTime(1, 0);
        p.cancelScheduledValues(0.3);
        p.setTargetAtTime(0.25, 0.3, 0.08);
      }, TIMES),
    ).toEqual(EASED);
  });

  test('AN EVENT CANCELLED IS NOT THE ONE IT HOLDS FROM', async () => {
    /*
     * The hold at 0.35 is cancelled, so the value is 1 until the ramp at 0.4 — Chrome's curve above,
     * 0.1 s later, since it depends only on the time since the ramp began.
     */
    expect(
      await trace(
        (p) => {
          p.value = 1;
          p.setValueAtTime(0.7, 0.35);
          p.cancelScheduledValues(0.3);
          p.setTargetAtTime(0.25, 0.4, 0.08);
        },
        [0.36, 0.39, 0.45, 0.5],
      ),
    ).toEqual([1, 1, 0.6514, 0.4649]);
  });

  test('FROM THE END OF A RAMP, it holds the value the ramp reached', async () => {
    expect(
      await trace(
        (p) => {
          p.value = 1;
          p.linearRampToValueAtTime(0.5, 0.2);
          p.setTargetAtTime(0.25, 0.5, 0.08);
        },
        [0.3, 0.49, 0.52, 0.7],
      ),
    ).toEqual([0.5, 0.5, 0.4447, 0.2705]);
  });

  test('FROM ANOTHER RAMP STILL EASING, nothing is added and it was right already', async () => {
    expect(
      await trace(
        (p) => {
          p.value = 1;
          p.setValueAtTime(1, 0.2);
          p.setTargetAtTime(0.5, 0.2, 0.05);
          p.setTargetAtTime(0.25, 0.5, 0.08);
        },
        [0.21, 0.3, 0.49, 0.52, 0.7],
      ),
    ).toEqual([0.9094, 0.5677, 0.5015, 0.4457, 0.2706]);
  });
});

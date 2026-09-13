/**
 * The floor allocates nothing per tick.
 *
 * Counted by garbage collections, never by `heapUsed` — which reads the *live* heap, so
 * garbage made and dropped does not move it and the test passes against the very
 * perturbation it exists to catch. The control allocates two objects per iteration and
 * the assertion is the **separation**, never either number.
 *
 * This matters more here than almost anywhere: the floor runs every fixed step for
 * every agent, whether or not a provider exists, and it is the thing an agent falls
 * back to precisely when everything else is already going wrong.
 */
import { describe, expect, it } from 'vitest';
import { UtilityPolicy } from './utility.ts';
import type { Intent, PolicyContext, PolicyOption } from './types.ts';

function option(id: string, weight: number): PolicyOption {
  return {
    intent: {
      id,
      priority: 10,
      toolIds: [],
      args: [],
      expectedExtentMs: 500,
      source: 'floor',
    } satisfies Intent,
    score: (context) => weight + (context.tick % 3),
  };
}

async function collections(work: () => void): Promise<number> {
  let n = 0;
  const observer = new PerformanceObserver((list) => {
    n += list.getEntries().length;
  });
  observer.observe({ entryTypes: ['gc'] });
  work();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  return n;
}

describe('UtilityPolicy allocation', () => {
  it('allocates nothing per select', async () => {
    const policy = new UtilityPolicy([option('flee', 1), option('search', 4), option('idle', 2)]);
    const context: PolicyContext = { tick: 0, agentId: 'A17', elapsedMs: 0 };

    const CALLS = 1_000_000;
    let sink: unknown;

    /* The control first, so it collects whatever earlier work left in the young
       generation. Two objects per iteration — a fresh intent and its tool array is
       exactly what a careless implementation would build. */
    const noisy = await collections(() => {
      for (let i = 0; i < CALLS; i++) sink = [{ at: i }, [i]];
    });

    let seen = 0;
    const quiet = await collections(() => {
      for (let i = 0; i < CALLS; i++) {
        /* A fresh context object per call would itself allocate, so the tick is
           mutated through a cast rather than rebuilt — the session does the same. */
        (context as { tick: number }).tick = i;
        seen += policy.select(context).priority;
      }
    });

    expect(noisy, 'the control must separate the two states').toBeGreaterThan(3);
    expect(quiet).toBeLessThan(noisy / 4);
    expect(seen).toBeGreaterThan(0);
    expect(sink).not.toBe(undefined);
  });
});

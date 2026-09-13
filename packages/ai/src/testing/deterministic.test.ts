/**
 * A provider whose latency is programmable, and whose clock is not the wall.
 *
 * Every timing property Track O claims is asserted against this. If it resolved on a
 * real timer, each of those assertions would be a race that passes on a fast machine,
 * and the buffered loop's whole argument is about timing.
 */
import { describe, expect, it } from 'vitest';
import { DeterministicProvider } from './deterministic.ts';
import type { AiEvent, AiRequest } from '../provider/types.ts';

function request(): AiRequest {
  return {
    preamble: '',
    context: { capturedAtTick: 0 },
    toolIds: [],
    signal: new AbortController().signal,
  };
}

/**
 * Let every pending microtask settle.
 *
 * A zero timeout rather than `setImmediate`, which the workspace tsconfig has no
 * types for. What matters is that it is a macrotask, so every microtask queued by an
 * `advance` has run by the time it resolves.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function collect(iterable: AsyncIterable<AiEvent>): AiEvent[] {
  const seen: AiEvent[] = [];
  void (async () => {
    for await (const event of iterable) seen.push(event);
  })();
  return seen;
}

const HELLO: AiEvent[] = [
  { kind: 'text', text: 'hello' },
  { kind: 'done', reason: 'complete' },
];

describe('DeterministicProvider', () => {
  it('yields nothing before its latency and everything at it', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 3, events: HELLO });
    const session = provider.createSession({ model: 'test' });
    const seen = collect(session.run(request()));

    for (const tick of [0, 1, 2]) {
      provider.advance(tick);
      await flush();
      expect(seen).toEqual([]);
    }

    provider.advance(3);
    await flush();
    expect(seen).toEqual(HELLO);
  });

  it('yields nothing, ever, when latency is never', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 'never', events: HELLO });
    const session = provider.createSession({ model: 'test' });
    const seen = collect(session.run(request()));

    for (let tick = 0; tick <= 10_000; tick++) provider.advance(tick);
    await flush();

    /* Not merely "no text": the iterable has not completed either, so a consumer
       awaiting it is still awaiting. This is the provider a never-blocked agent is
       tested against, and an iterable that quietly ended would let the agent notice. */
    expect(seen).toEqual([]);
  });

  it('completes an aborted request and counts it', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 5, events: HELLO });
    const session = provider.createSession({ model: 'test' });
    const seen = collect(session.run(request()));

    session.abort('test');
    await flush();

    expect(seen).toEqual([{ kind: 'done', reason: 'aborted', message: 'test' }]);
    expect(provider.abortedCount).toBe(1);
  });

  it('aborts through the request signal as well as the session', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 5, events: HELLO });
    const session = provider.createSession({ model: 'test' });
    const controller = new AbortController();
    const seen = collect(session.run({ ...request(), signal: controller.signal }));

    controller.abort();
    await flush();

    expect(seen).toEqual([{ kind: 'done', reason: 'aborted', message: 'signal' }]);
  });

  it('reports peak concurrency across overlapping sessions', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 2, events: HELLO });
    const a = provider.createSession({ model: 'test' });
    const b = provider.createSession({ model: 'test' });

    collect(a.run(request()));
    collect(b.run(request()));
    expect(provider.peakConcurrency).toBe(2);

    provider.advance(2);
    await flush();

    const c = provider.createSession({ model: 'test' });
    collect(c.run(request()));
    await flush();

    /* Still 2: peak is a high-water mark, not a current count. A test asserting the
       current count would pass on a run where the overlap simply had not happened yet. */
    expect(provider.peakConcurrency).toBe(2);
  });

  it('never exceeds one when requests do not overlap', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: HELLO });
    const session = provider.createSession({ model: 'test' });

    for (let tick = 1; tick <= 5; tick++) {
      collect(session.run(request()));
      provider.advance(tick);
      await flush();
    }

    expect(provider.peakConcurrency).toBe(1);
    expect(provider.requestCount).toBe(5);
  });

  it('gives the script function a request index that counts up', async () => {
    const seenIndices: number[] = [];
    const provider = new DeterministicProvider((index) => {
      seenIndices.push(index);
      return { latencyTicks: 0, events: HELLO };
    });
    const session = provider.createSession({ model: 'test' });

    for (let i = 0; i < 3; i++) {
      collect(session.run(request()));
      provider.advance(i);
      await flush();
    }

    expect(seenIndices).toEqual([0, 1, 2]);
  });

  it('resolves nothing without advance, on any real timer', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: HELLO });
    const session = provider.createSession({ model: 'test' });
    const seen = collect(session.run(request()));

    /* Ten flushes and a real macrotask. If anything here were on a timer this is
       where it would leak through, and every timing assertion in the package would
       be a race rather than a measurement. */
    for (let i = 0; i < 10; i++) await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(seen).toEqual([]);
  });

  it('applies a changed latency to the next request only', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 10, events: HELLO });
    const session = provider.createSession({ model: 'test' });
    const first = collect(session.run(request()));

    provider.setLatencyTicks(1);
    const second = collect(session.run(request()));

    provider.advance(1);
    await flush();

    expect(second).toEqual(HELLO);
    expect(first).toEqual([]);
  });
});

import { afterEach, expect, test } from 'vitest';
import { AudioGraph } from './graph.ts';
import { cutoffForSpeed, liftFrequencyHz, liftGainFor } from './filters.ts';
import type { FetchLike } from './registry.ts';
import { StubContext } from './audioHarness.ts';

/*
 * Only the parameter maths is tested. Graph topology and, above all, whether it
 * sounds good are not things a test can judge — sound is judged by ear
 * (AGENTS.md). What a test *can* protect is the shape of the curve driving it: a
 * non-monotonic filter sweep or a duck that reaches zero are audible as "vaguely
 * wrong" and almost impossible to hear as a *cause*.
 */

test('the master cutoff opens with speed and saturates at the top', () => {
  expect(cutoffForSpeed(0, 16)).toBeCloseTo(320, 0);
  expect(cutoffForSpeed(16, 16)).toBeCloseTo(18000, 0);
  // Overspeed — a fire launch — must not run the filter past hearing.
  expect(cutoffForSpeed(40, 16)).toBeCloseTo(18000, 0);
});

test('the cutoff curve is monotonic — going faster never dulls the mix', () => {
  /*
   * The break worth catching. "The filter opens as you hit full sprint" is the
   * single loudest moment in the mix, and a curve that dips anywhere inverts it
   * — accelerating would briefly sound like braking. Easy to introduce by
   * accident with an exponential and almost impossible to hear as a *cause*
   * rather than as vague wrongness.
   */
  let previous = -1;
  for (let speed = 0; speed <= 20; speed += 0.5) {
    const hz = cutoffForSpeed(speed, 16);
    expect(hz, `speed ${speed}`).toBeGreaterThanOrEqual(previous);
    previous = hz;
  }
});

test('a zero max speed cannot produce a silent or infinite filter', () => {
  // maxSpeed reaches its slider floor in the tuning panel, and a divide by it
  // would put NaN into an AudioParam — which fails as silence, not as an error.
  const hz = cutoffForSpeed(5, 0);
  expect(Number.isFinite(hz)).toBe(true);
  expect(hz).toBeGreaterThan(0);
});

test('the lift sweeps by musical interval, not by hertz', () => {
  /*
   * The airborne effect — the lift familiar from dance production — is a high-pass
   * sweep plus a duck, and the sweep's *shape*
   * is the part a test can hold. Pitch is logarithmic, so a linear ramp from 20 Hz spends
   * half its travel below the notes a track is made of: the first half of a jump would do
   * nothing audible and the second half would lurch. Geometric spacing makes every equal
   * step of the knob an equal interval.
   */
  expect(liftFrequencyHz(0), 'at rest the filter must be inaudible').toBeLessThan(25);
  expect(liftFrequencyHz(1)).toBeCloseTo(340, 0);
  // Half a lift is the geometric mean of the two ends, not the arithmetic one (180 Hz).
  expect(liftFrequencyHz(0.5)).toBeCloseTo(Math.sqrt(20 * 340), 0);

  let previous = 0;
  for (let lift = 0; lift <= 1.0001; lift += 0.05) {
    const hz = liftFrequencyHz(lift);
    expect(hz, `lift ${lift.toFixed(2)}`).toBeGreaterThanOrEqual(previous);
    previous = hz;
  }
});

test('the duck makes room without muting, and neither end can produce NaN', () => {
  /*
   * The other half of the same gesture: the dry track sits back so the tail is what fills
   * the space. It may never reach zero — that is the *stop* this effect replaced, and the
   * whole complaint about the stop was that the music was lost.
   */
  expect(liftGainFor(0)).toBe(1);
  expect(liftGainFor(1)).toBeGreaterThan(0.4);
  expect(liftGainFor(1)).toBeLessThan(1);
  expect(liftGainFor(0.5)).toBeCloseTo((1 + liftGainFor(1)) / 2, 6);

  // A NaN here reaches an AudioParam, where it fails as silence rather than as an error.
  for (const bad of [NaN, Infinity, -1, 5]) {
    expect(Number.isFinite(liftFrequencyHz(bad)), `${bad} Hz`).toBe(true);
    expect(Number.isFinite(liftGainFor(bad)), `${bad} gain`).toBe(true);
    expect(liftGainFor(bad)).toBeGreaterThan(0);
  }
});

/*
 * `fetchImpl` (AudioGraphOptions) is a straight pass-through to `SoundRegistry`'s own
 * constructor, whose injection is already exercised thoroughly (`registry.test.ts`).
 * This is the one link that could break without either file catching it: that the
 * option actually reaches the registry `graph.registry` exposes, not a copy of it.
 */

async function buildGraph(fetchImpl?: FetchLike): Promise<AudioGraph> {
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      return new StubContext() as unknown as AudioContext;
    }
  };
  const graph = await AudioGraph.create({ stemCount: 1, fetchImpl });
  if (graph === null) throw new Error('the stub context did not build a graph');
  return graph;
}

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

test('a custom fetchImpl reaches the registry a sound actually loads through', async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
  };

  const graph = await buildGraph(fetchImpl);
  graph.registry.register('jump', { urls: ['/audio/jump.opus'], synth: () => ({}) as AudioBuffer });
  await graph.registry.load(graph.context);

  expect(calls).toEqual(['/audio/jump.opus']);
  expect(graph.registry.resolved.get('jump')).toBe('file');
});

test('omitting fetchImpl is exactly the previous behaviour — no custom fetch is required', async () => {
  const graph = await buildGraph(undefined);
  graph.registry.register('jump', { urls: ['/audio/jump.opus'], synth: () => ({}) as AudioBuffer });
  await graph.registry.load(graph.context);

  // No fetch mock installed at all: falling through to the real global fetch (which has
  // nothing to talk to here) must degrade to the synth fallback, never throw.
  expect(graph.registry.resolved.get('jump')).toBe('synth');
});

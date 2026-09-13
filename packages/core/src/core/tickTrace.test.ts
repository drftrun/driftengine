import { describe, expect, test } from 'vitest';
import { TickTrace } from './tickTrace.ts';

function filled(values: readonly (readonly number[])[], flags: readonly number[] = []): TickTrace {
  const trace = new TickTrace(values[0]?.length ?? 1, Math.max(1, values.length));
  values.forEach((row, i) => trace.push(row, flags[i] ?? 0));
  return trace;
}

describe('TickTrace', () => {
  test('starts empty', () => {
    expect(new TickTrace(3).length).toBe(0);
  });

  test('remembers what each tick pushed', () => {
    const trace = filled([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const out = new Float32Array(2);
    trace.sample(1, out);
    expect([...out]).toEqual([3, 4]);
    expect(trace.length).toBe(3);
  });

  test('reads a single channel without a scratch array', () => {
    expect(
      filled([
        [1, 2],
        [3, 4],
      ]).channelAt(1, 0),
    ).toBe(3);
  });

  test('carries flags per tick', () => {
    const trace = filled([[0], [0]], [5, 2]);
    expect(trace.flagsAt(0)).toBe(5);
    expect(trace.flagsAt(1)).toBe(2);
  });

  test('grows past its initial capacity without losing anything', () => {
    const trace = new TickTrace(1, 2);
    for (let i = 0; i < 9; i++) trace.push([i]);
    expect(trace.length).toBe(9);
    expect(trace.channelAt(8, 0)).toBe(8);
    expect(trace.channelAt(0, 0)).toBe(0);
  });

  test('growth keeps flags aligned with their values', () => {
    // Two parallel arrays grow independently, which is exactly how they come
    // apart: a values array that doubled while the flags one did not would read
    // every flag past the boundary as zero, and zero is a legal flag.
    const trace = new TickTrace(1, 2);
    for (let i = 0; i < 9; i++) trace.push([i], i + 1);
    for (let i = 0; i < 9; i++) expect(trace.flagsAt(i)).toBe(i + 1);
  });

  test('clamps a sample beyond the end rather than reading rubbish', () => {
    // A caller one tick past the end is the ordinary case at a finish line, not
    // a bug: holding the last state is what a finished character does.
    const out = new Float32Array(1);
    filled([[7], [8]]).sample(99, out);
    expect(out[0]).toBe(8);
  });

  test('clamps a negative sample to the first tick', () => {
    const out = new Float32Array(1);
    filled([[7], [8]]).sample(-3, out);
    expect(out[0]).toBe(7);
  });

  describe('tickAtOrBefore', () => {
    const monotonic = filled([[0], [10], [20], [30], [40]]);

    test('finds an exact value', () => {
      expect(monotonic.tickAtOrBefore(0, 20)).toBe(2);
    });

    test('finds the tick before a value in between', () => {
      expect(monotonic.tickAtOrBefore(0, 25)).toBe(2);
    });

    test('answers 0 below the first value', () => {
      expect(monotonic.tickAtOrBefore(0, -5)).toBe(0);
    });

    test('answers the last tick above the final value', () => {
      expect(monotonic.tickAtOrBefore(0, 999)).toBe(4);
    });

    test('answers -1 on an empty trace rather than throwing', () => {
      expect(new TickTrace(1).tickAtOrBefore(0, 1)).toBe(-1);
    });

    test('picks the last of a run of equal values', () => {
      // A stalled channel is a character who stopped. Answering the first tick of
      // the plateau would report them as ahead by the whole length of the stall.
      const stalled = filled([[0], [10], [10], [10], [20]]);
      expect(stalled.tickAtOrBefore(0, 10)).toBe(3);
    });
  });
});

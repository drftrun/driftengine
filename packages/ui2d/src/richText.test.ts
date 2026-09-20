import { expect, test } from 'vitest';
import { runsFor } from './richText.ts';
import type { TextRun } from './richText.ts';

const PLAIN = { colour: 0xffffffff, bold: false, italic: false };
const spans = (out: TextRun[]) => out.map((r) => [r.from, r.to]);

test('no runs produce one run covering everything', () => {
  const out: TextRun[] = [];
  expect(runsFor('hello', [], out)).toBe(1);
  expect(spans(out)).toEqual([[0, 5]]);
});

test('an empty string produces nothing rather than an empty run', () => {
  const out: TextRun[] = [];
  expect(runsFor('', [{ from: 0, to: 0, ...PLAIN }], out)).toBe(0);
});

test('a run in the middle produces three runs with no gap', () => {
  const out: TextRun[] = [];
  expect(runsFor('hello', [{ from: 1, to: 3, ...PLAIN, colour: 1 }], out)).toBe(3);
  expect(spans(out)).toEqual([
    [0, 1],
    [1, 3],
    [3, 5],
  ]);
});

test('overlapping runs are split, and the later one wins the overlap', () => {
  const out: TextRun[] = [];
  runsFor(
    'abcdef',
    [
      { from: 0, to: 4, ...PLAIN, colour: 1 },
      { from: 2, to: 6, ...PLAIN, colour: 2 },
    ],
    out,
  );
  expect(spans(out)).toEqual([
    [0, 2],
    [2, 4],
    [4, 6],
  ]);
  expect(out[1]?.colour).toBe(2);
});

test('the result covers the whole string, with no gaps and in order', () => {
  const out: TextRun[] = [];
  const count = runsFor('abcdefgh', [{ from: 5, to: 6, ...PLAIN, colour: 9 }], out);
  expect(out[0]?.from).toBe(0);
  expect(out[count - 1]?.to).toBe(8);
  for (let i = 1; i < count; i += 1) expect(out[i]?.from).toBe(out[i - 1]?.to);
});

test('a run past the end is clamped rather than producing a span nothing can draw', () => {
  const out: TextRun[] = [];
  runsFor('abc', [{ from: 1, to: 99, ...PLAIN, colour: 1 }], out);
  expect(out[out.length - 1]?.to).toBe(3);
});

test('a zero-length run contributes no boundary', () => {
  const out: TextRun[] = [];
  expect(runsFor('abc', [{ from: 1, to: 1, ...PLAIN, colour: 5 }], out)).toBe(1);
});

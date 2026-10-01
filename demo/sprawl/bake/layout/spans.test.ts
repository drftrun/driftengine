import { expect, test } from 'vitest';

import { lineStops } from './spans.ts';

test('A SPAN EVERY GAP ALONG A STREET, CARRIED ACROSS ITS BLOCKS, not restarted at each', () => {
  /*
   * One street on the line x = 10, cut by junctions into runs 0–80, 90–170 and 180–260, a span every
   * 100 m from half a gap in: 50, 150 and 250 — one on each block. Restarted at each block, the
   * second and third would have stood at 140 and 230.
   */
  const line = [
    { line: 'v10', from: 0, to: 80 },
    { line: 'v10', from: 90, to: 170 },
    { line: 'v10', from: 180, to: 260 },
  ];
  expect(lineStops(line, 100)).toEqual([
    { run: 0, along: 50 },
    { run: 1, along: 150 },
    { run: 2, along: 250 },
  ]);
  /* A stop that falls in a junction's clearance, 40–60 here, waits for the next run's start. */
  expect(
    lineStops(
      [
        { line: 'v10', from: 0, to: 40 },
        { line: 'v10', from: 60, to: 260 },
      ],
      100,
    ),
  ).toEqual([
    { run: 1, along: 60 },
    { run: 1, along: 160 },
  ]);
  /* Two lines are two counts, whatever order their runs come in. */
  expect(
    lineStops(
      [
        { line: 'h5', from: 100, to: 300 },
        { line: 'v10', from: 0, to: 80 },
        { line: 'h5', from: 0, to: 90 },
      ],
      120,
    ),
  ).toEqual([
    { run: 2, along: 60 },
    { run: 0, along: 180 },
    { run: 1, along: 60 },
  ]);
});

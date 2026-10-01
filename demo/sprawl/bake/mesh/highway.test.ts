import { describe, expect, it } from 'vitest';

import type { CityLayout } from '../layout/layout.ts';
import type { RoadClass } from '../layout/tables.ts';
import { readScripts } from '../script/reader.ts';
import type { Value } from '../script/values.ts';
import { highwayInstances } from './highway.ts';
import { stretch } from './kit.ts';

const n = (v: Value | undefined): number =>
  v?.k === 'num' ? Math.round(v.v * 1000) / 1000 + 0 : NaN;
const round = (a: readonly number[]): number[] => a.map((v) => Math.round(v * 1000) / 1000 + 0);

describe('the elevated road and the diagonal', () => {
  it('a stretch of a line is resampled every step between its two distances, through its corners', () => {
    /* 10 m along x then 10 m along z; 5 m to 15 m at 2.5 m a point turns the corner at 10 m. */
    expect(round(stretch([0, 0, 0, 10, 0, 0, 10, 0, 10], 5, 15, 2.5))).toEqual([
      5, 0, 0, 7.5, 0, 0, 10, 0, 0, 10, 0, 2.5, 10, 0, 5,
    ]);
  });

  it('A DECK RUNS IN PIECES WITH PIERS UNDER ITS UNDERSIDE, AND THE DIAGONAL CROSSES A STREET AS WIDE AS IT CROSSES IT', () => {
    const deck: [number, number, number][] = [];
    for (let x = 0; x <= 200; x += 10) deck.push([x, 12, 0]);
    const cls = { width: 12 } as RoadClass;
    const layout = {
      roads: {
        highway: { points: deck },
        diagonal: {
          points: [
            [0, 0, 0],
            [100, 0, 100],
          ],
        },
        roads: [{ vertical: true, at: 50, from: -100, to: 200, cls }],
      },
    } as unknown as CityLayout;
    const out = highwayInstances(layout, readScripts(['e.flecs'], () => '').world);
    const named = (name: string) => out.filter((i) => i.name === name);
    /* 200 m in 100 m pieces. */
    expect(named('HighwayDeck').map((i) => [n(i.props.get('s0')), n(i.props.get('s1'))])).toEqual([
      [0, 100],
      [100, 200],
    ]);
    /* A pier every 40 m from 20 m, carrying the underside 2.3 m under the 12 m route. */
    expect(named('HighwayPier').map((i) => [i.position[0], n(i.props.get('h'))])).toEqual([
      [20, 9.7],
      [60, 9.7],
      [100, 9.7],
      [140, 9.7],
      [180, 9.7],
    ]);
    expect(named('DeckLight').map((i) => i.position[0])).toEqual([26, 78, 130, 182]);
    /* The diagonal meets x = 50 at 50·√2 along it; the street's 12 m, crossed at 45°, is √2 wider. */
    const crossing = named('DiagonalCrossing')[0];
    const half = 6 * Math.SQRT2;
    expect([n(crossing?.props.get('s0')), n(crossing?.props.get('s1'))]).toEqual(
      round([50 * Math.SQRT2 - half, 50 * Math.SQRT2 + half]),
    );
  });
});

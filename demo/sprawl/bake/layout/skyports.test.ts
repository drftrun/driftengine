import { describe, expect, it } from 'vitest';

import type { Lot } from './lots.ts';
import { skyportParts } from './skyports.ts';

const round = (x: number): number => Math.round(x * 1000) / 1000 + 0;

describe('the skyports', () => {
  it('A SKYPORT TURNS ITS DOOR TO THE STREET, AND ITS PAD LIGHT STANDS OVER THE DECK’S SPOT', () => {
    /* A lot facing +z, the street's side: the tower's −z side goes there, a half turn. */
    const parts = skyportParts(
      { position: [100, 200], yaw: 0, lot: {} as Lot },
      { template: 'Tower', deck: 12, spotX: 0, spotZ: -6.9, padLight: 'Pad' },
      0.31,
    );
    expect(
      parts.map((p) => [p.template, ...p.position.map(round), round(p.y), round(p.yaw)]),
    ).toEqual([
      ['Tower', 100, 200, 0.31, round(Math.PI)],
      /* The spot 6.9 m toward the street, on the deck 12 m up. */
      ['Pad', 100, 206.9, 12.31, round(Math.PI)],
    ]);
    expect(round(parts[1]?.light?.y ?? 0)).toBe(12.61);
  });
});

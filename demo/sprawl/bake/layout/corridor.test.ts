import { expect, it } from 'vitest';

import { underRoute } from './corridor.ts';

it('A LOT THE ELEVATED ROAD CROSSES, OR PASSES NEARER THAN ITS HALF-WIDTH, IS UNDER IT; ONE FURTHER OFF IS NOT', () => {
  /* The route runs along z = 0 from x 0 to 100, its corridor 13.6 m either side. */
  const route = [
    [0, 14, 0],
    [100, 14, 0],
  ] as const;
  const lot = (x0: number, z0: number, x1: number, z1: number) => ({ x0, z0, x1, z1 });
  /* Crossed right through. */
  expect(underRoute(lot(40, -5, 60, 5), route, 13.6)).toBe(true);
  /* Cut through the middle, every corner 50 m off: only the crossing says so. */
  expect(underRoute(lot(40, -50, 60, 50), route, 13.6)).toBe(true);
  /* 10 m off: inside the corridor, though the route never enters it. */
  expect(underRoute(lot(40, 10, 60, 30), route, 13.6)).toBe(true);
  /* 20 m off: clear. */
  expect(underRoute(lot(40, 20, 60, 40), route, 13.6)).toBe(false);
  /* Past the route's end by 5 m, level with it: the end is nearer than any corner. */
  expect(underRoute(lot(105, -30, 125, 30), route, 13.6)).toBe(true);
});

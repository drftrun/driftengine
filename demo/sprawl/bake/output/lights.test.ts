import { describe, expect, it } from 'vitest';

import type { CityLight } from '../mesh/lights.ts';
import { boxField, cityLightVolume, liteOf } from './lights.ts';

const round = (x: number): number => Math.round(x * 1000) / 1000 + 0;

describe("the city's light", () => {
  /* A block 10 m along its x and 4 along its z, standing from the ground to 20 m. */
  const block = { x: 0, z: 0, yaw: 0, w: 10, d: 4, bottom: 0, top: 20 };

  it('THE BUILDINGS ARE A DISTANCE FIELD: HOW FAR TO THE NEAREST, NEGATIVE INSIDE, NO FURTHER THAN ITS REACH', () => {
    const field = boxField([block], 16);
    /* 3 m past its +x face; 2 m in from its nearest face, its z sides; beyond the reach, 16. */
    expect(round(field(8, 5, 0))).toBe(3);
    expect(round(field(0, 10, 0))).toBe(-2);
    expect(field(100, 5, 100)).toBe(16);
    /* 12 m past its face and a bucket over, still found: every box within reach is listed. */
    expect(round(field(17, 5, 0))).toBe(12);
    /* 5 m above its top. */
    expect(round(field(0, 25, 0))).toBe(5);
    /* Past a corner, straight to it: (3, 4) away in x and z, 5. */
    expect(round(field(8, 5, 6))).toBe(5);
    /* Turned a quarter, its 10 m runs along the world's z: 3 m past it along z. */
    const turned = boxField([{ ...block, yaw: Math.PI / 2 }], 16);
    expect(round(turned(0, 5, 8))).toBe(3);
    expect(round(turned(8, 5, 0))).toBe(6);
    /* Turned an eighth, its x runs along the world's (1, −1): (5, 5, −5) is √50 = 7.071 along it,
       2.071 past its end. */
    const eighth = boxField([{ ...block, yaw: Math.PI / 4 }], 16);
    expect(round(eighth(5, 5, -5))).toBe(2.071);
    /* Two, the nearer: a second block 20 m along x, from 15 to 25, is 3 m from (12, 5, 0), which
       is 7 from the first. */
    const two = boxField([block, { ...block, x: 20 }], 16);
    expect(round(two(12, 5, 0))).toBe(3);
  });

  it('A BUILDING IS DARK INSIDE AND SHADOWS WHAT STANDS BEHIND IT FROM A LIGHT', () => {
    /* A lamp 6 m in front of the block's +x face, at 4 m; samples every 4 m along x at 4 m. */
    const lamp: CityLight = {
      position: [11, 4, 0],
      color: [1, 1, 1],
      intensity: 2,
      range: 40,
      night: true,
    };
    const bounds = [-16, 4, 0, 16, 4, 0];
    const lit = cityLightVolume([lamp], [], bounds, 4);
    const shadowed = cityLightVolume([lamp], [block], bounds, 4);
    const at = (v: typeof lit, x: number): [number, number] => {
      const i = (x + 16) / 4;
      return [v.light[i * 4] as number, v.light[i * 4 + 3] as number];
    };
    /* In front, 3 m from it: its colour times its intensity times the smooth falloff,
       (1 − 3/40)² = 0.8556, so 1.711 — and the same with the block behind. */
    expect(round(at(lit, 8)[0])).toBe(1.711);
    expect(at(shadowed, 8)).toEqual(at(lit, 8));
    /* Inside the block, no sample. */
    expect(at(shadowed, 0)[1]).toBe(0);
    /* Behind it, the lamp is hidden: darker than with no block at all. */
    expect(at(shadowed, -12)[0]).toBeLessThan(at(lit, -12)[0] * 0.5);
    expect(at(lit, -12)[0]).toBeGreaterThan(0);
  });

  it('A LIGHT GOES INTO THE CONTAINER AS THE SOURCE SAID IT, NAMED FOR WHEN IT SHINES', () => {
    const [light] = liteOf([
      { position: [1, 2, 3], color: [1, 0.5, 0], intensity: 6, range: 16, night: true },
    ]);
    expect(light).toEqual({
      kind: 'point',
      name: 'night',
      position: [1, 2, 3],
      direction: [0, -1, 0],
      color: [1, 0.5, 0],
      intensity: 6,
      range: 16,
      innerConeRad: 0,
      outerConeRad: 0,
    });
  });
});

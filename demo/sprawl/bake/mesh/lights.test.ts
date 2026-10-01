import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { instantiateAll, placement } from './instantiate.ts';
import { instanceLights, lightsOf } from './lights.ts';

const SCRIPT = [
  'template Lamp {',
  '  prop light: f32 = 6',
  '  head {',
  '    Position3: {1, 3, 0}',
  '    Scale3: {2, 2, 2}',
  '    bulb {',
  '      Position3: {0, 0.5, 0}',
  '      PointLight: {intensity: 0, range: 16}',
  '      NightLight: {strength: 1, light: light, offset: 0, flicker: 0}',
  '      Emissive: {strength: 0, color: {255, 128, 0, 255}}',
  '    }',
  '  }',
  '  beacon {',
  '    Position3: {0, 9, 0}',
  '    PointLight: {intensity: 30, range: 40}',
  '    NightLight: {strength: 1, light: 8, offset: 0, flicker: 0}',
  '    Rgba: {0, 0, 255, 255}',
  '  }',
  '  dark { PointLight: {intensity: 0, range: 8} }',
  '}',
  'template Bulb {',
  '  IcoSphere: {segments: 1, smooth: false, radius: 0.5}',
  '  Scale3: {0, 0, 0}',
  '  Emissive: {strength: 0, color: {100, 200, 255, 255}}',
  '  LightGlow: {pixels: 3, min_dist: 50, max_size: 9, scale: 0}',
  '}',
].join('\n');

const round = (xs: readonly number[]): number[] => xs.map((x) => Math.round(x * 1e4) / 1e4 + 0);

describe("the city's lights", () => {
  const read = readScripts(['l.flecs'], (f) => (f === 'l.flecs' ? SCRIPT : null));
  const at = (x: number, z: number, yaw: number) => ({
    name: 'Lamp',
    props: new Map(),
    position: [x, z] as const,
    y: 0,
    yaw,
    source: 'lamp',
  });

  it('A MARKER UNDER A SCALED PARENT LANDS WHERE ITS PART DOES; ONE OF AN INSTANCED COPY WHERE THE COPY STANDS', () => {
    const [bulb, beacon, ...rest] = lightsOf(instantiateAll(read, [at(0, 0, 0)]).markers);
    /* The head stands at (1, 3, 0), doubled: the bulb's half metre up it is a metre. */
    expect(round([...(bulb?.position ?? [])])).toEqual([1, 4, 0]);
    /* It shines at night, as bright as its lamp says, in its emission's colour, linear. */
    expect([bulb?.intensity, bulb?.range, bulb?.night]).toEqual([6, 16, true]);
    expect(round([...(bulb?.color ?? [])])).toEqual([1, 0.2159, 0]);
    /* The beacon shines always, at its own number whatever its night light says, in its own
       colour; a light with neither is no light. */
    expect([beacon?.intensity, beacon?.night]).toEqual([30, false]);
    expect(round([...(beacon?.color ?? [])])).toEqual([0, 0, 1]);
    expect(rest).toHaveLength(0);
    /* A lamp instanced is flattened once at the origin, then placed: turned a quarter at (10, 5),
       its (1, 4, 0) lands at (10, 4, 4). */
    const origin = instantiateAll(read, [at(0, 0, 0)]).markers;
    const [placed] = lightsOf(origin, placement(10, 0, 5, Math.PI / 2));
    expect(round([...(placed?.position ?? [])])).toEqual([10, 4, 4]);
  });

  it("A BULB LIT BY ITS HOST SHINES WHERE IT STANDS, AT THE HOST'S HEIGHT, IN ITS GLOW; A LAMP LIT BY ITS OWN TEMPLATE, ONCE", () => {
    const host = { intensity: 12, range: 30, y: 7 };
    const bulb = { ...at(3, 4, 0), name: 'Bulb', light: host };
    const [light, ...more] = instanceLights(bulb, instantiateAll(read, [bulb]).markers);
    expect(more).toHaveLength(0);
    expect(round([...(light?.position ?? [])])).toEqual([3, 7, 4]);
    expect([light?.intensity, light?.range, light?.night]).toEqual([12, 30, true]);
    expect(round([...(light?.color ?? [])])).toEqual([0.1274, 0.5776, 1]);
    /* A lamp whose template carries its lights keeps its two, whatever its host says. */
    const lamp = { ...at(0, 0, 0), light: host };
    expect(instanceLights(lamp, instantiateAll(read, [lamp]).markers)).toHaveLength(2);
  });
});

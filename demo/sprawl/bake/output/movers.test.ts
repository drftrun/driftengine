import { describe, expect, it } from 'vitest';

import type { MeshData } from '@driftengine/drft';

import type { Value } from '../script/values.ts';

import { readScripts } from '../script/reader.ts';
import { bakeMover } from './movers.ts';

const SCRIPT = [
  'template Walker {',
  '  torso { Position3: {0, 1.2, 0} Box: {0.4, 0.6, 0.2} NpcSlot: {slot: 1} }',
  '  leg {',
  '    Position3: {0.1, 0.9, 0}',
  '    Limb: {phase: 3.14159, swing: 0.6, lift: 1}',
  '    shin { Position3: {0, -0.45, 0} Box: {0.15, 0.9, 0.15} NpcSlot: {slot: 2} }',
  '  }',
  '}',
  'template Carriage {',
  '  prop stripe: Rgba = {96, 200, 255, 255}',
  '  side { Position3: {0, 1, 0} Box: {0.1, 1, 12} Rgba: stripe }',
  '  roof { Position3: {0, 2, 0} Box: {2.6, 0.2, 12} Rgba: {40, 42, 46, 255} }',
  '}',
  'template Drone {',
  '  frame { Box: {1, 0.2, 1} Rgba: {40, 40, 44, 255} }',
  '  strobe { Position3: {0, 0.44, 0} Box: {0.2, 0.14, 0.2}',
  '    Blink: {rate: 1.35, duty: 0.14}',
  '    Rgba: {255, 255, 255, 255}',
  '    Emissive: {strength: 8, color: {255, 255, 255, 255}} }',
  '}',
  'template Car {',
  '  body { Position3: {0, 0.6, 0} Box: {1.8, 0.5, 4} VehiclePart: {slot: PartBody}',
  '    Rgba: {60, 70, 100, 255} }',
  '  tyre { Position3: {0.8, 0.3, 1.3} Box: {0.2, 0.6, 0.6} Rgba: {26, 26, 29, 255} }',
  '}',
].join('\n');

const round = (x: number): number => Math.round(x * 1000) / 1000 + 0;
function bounds(mesh: MeshData): number[] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a] as number, mesh.positions[i + a] as number);
      hi[a] = Math.max(hi[a] as number, mesh.positions[i + a] as number);
    }
  }
  return [...lo, ...hi].map(round);
}

describe("the city's movers", () => {
  const read = readScripts(['m.flecs'], (f) => (f === 'm.flecs' ? SCRIPT : null));

  it('A LIMB HANGS FROM ITS PIVOT, IN THE PIVOT’S FRAME, AND SWINGS AS ITS TEMPLATE SAYS', () => {
    const walker = bakeMover(read, 'Walker', 'person');
    expect(walker?.limbs.map((l) => [...l.pivot, l.phase, l.swing, l.lift].map(round))).toEqual([
      [0.1, 0.9, 0, 3.142, 0.6, 1],
    ]);
    /* The torso on the body, tinted by its cloth; the shin on the leg, by its second cloth. */
    const body = walker?.meshes.find((m) => m.limb === -1);
    const leg = walker?.meshes.find((m) => m.limb === 0);
    expect([body?.tint, leg?.tint]).toEqual(['cloth', 'cloth2']);
    /* The shin runs from the pivot down its 0.9 m, square about it. */
    expect(bounds(leg?.mesh as MeshData)).toEqual([-0.075, -0.9, -0.075, 0.075, 0, 0.075]);
    expect(bounds(body?.mesh as MeshData)).toEqual([-0.2, 0.9, -0.1, 0.2, 1.5, 0.1]);
  });

  it('A VEHICLE’S PAINT IS WHITE FOR ITS INSTANCE TO TINT, AND ITS TYRES KEEP THEIR OWN COLOUR', () => {
    const car = bakeMover(read, 'Car', 'vehicle');
    const paint = car?.meshes.find((m) => m.tint === 'paint');
    const fixed = car?.meshes.find((m) => m.tint === null);
    expect(Math.min(...(paint?.mesh.colors ?? [0]))).toBe(1);
    /* 26 in sRGB is 0.0103 linear. */
    expect(round(fixed?.mesh.colors[0] ?? 0)).toBe(0.01);
    expect(car?.limbs).toEqual([]);
  });

  it('A PART WEARING THE SENTINEL HANDED IN AS A PROP IS THE PAINT; THE REST KEEPS ITS OWN', () => {
    const u8 = (v: number): Value => ({ k: 'num', type: 'u8', v });
    const sentinel: Value = {
      k: 'struct',
      fields: new Map([
        ['r', u8(255)],
        ['g', u8(0)],
        ['b', u8(255)],
        ['a', u8(255)],
      ]),
      items: [],
    };
    const car = bakeMover(read, 'Carriage', 'train', {
      as: 'Middle',
      props: new Map([['stripe', sentinel]]),
      sentinel: [255, 0, 255],
    });
    expect(car?.name).toBe('Middle');
    const paint = car?.meshes.find((m) => m.tint === 'paint');
    const fixed = car?.meshes.find((m) => m.tint === null);
    /* The stripe is white for its instance's line colour; the roof, 40 in sRGB, is 0.021 linear. */
    expect(Math.min(...(paint?.mesh.colors ?? [0]))).toBe(1);
    expect(bounds(paint?.mesh as MeshData)).toEqual([-0.05, 0.5, -6, 0.05, 1.5, 6]);
    expect(round(fixed?.mesh.colors[0] ?? 0)).toBe(0.021);
  });

  it('A BLINKING LIGHT IS A MESH OF ITS OWN THE RUNTIME SWITCHES, at its rate and duty', () => {
    /* The strobe carries Blink: its own mesh, tinted 'blink' so each drone switches it on its own
       beat, glowing in its own colour so the tint reaches its light; the frame keeps its own. */
    const drone = bakeMover(read, 'Drone', 'drone');
    expect(drone?.meshes.map((m) => m.tint).sort()).toEqual(['blink', null]);
    expect(drone?.blink?.map(round)).toEqual([1.35, 0.14]);
    const strobe = drone?.meshes.find((m) => m.tint === 'blink')?.mesh;
    /* No colour of its own for its light: the instance's tint is what it glows in. */
    const colours = Array.from(strobe?.emissiveColor ?? []);
    expect(colours.length, 'the attribute is there to say so').toBeGreaterThan(0);
    expect(colours.every((c) => c < 0)).toBe(true);
  });
});

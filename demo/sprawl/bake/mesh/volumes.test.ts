import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { instantiateAll, placement } from './instantiate.ts';
import { volumeOf } from './volumes.ts';

const SCRIPT = [
  'prefab Glow {',
  '  Rgba: {0, 0, 0, 26}',
  '  Emissive: {strength: 0, color: {255, 255, 255, 255}}',
  '  Additive',
  '  VolumeGlow: {edge_power: 2.2, axis_falloff: 1.05, head_fade: 0.06, near_fade: 2.5, intensity: 3.6}',
  '  MaterialAnim: {emissive_fade_start: 40, emissive_fade_end: 95}',
  '}',
  'template Lamp {',
  '  cone : Glow {',
  '    Position3: {0, 5, 2}',
  '    Frustum: {segments: 12, smooth: true, length: 8, radius_bottom: 3.4, radius_top: 0.4}',
  '    Emissive: {strength: 0, color: {255, 214, 160, 255}}',
  '    NightLight: {strength: 0.3, light: 0, offset: 0, flicker: 0}',
  '  }',
  '  post {',
  '    Frustum: {segments: 8, smooth: false, length: 5, radius_bottom: 0.2, radius_top: 0.1}',
  '    Rgba: {40, 40, 40, 255}',
  '  }',
  '  pool {',
  '    Quad: {x: 4, y: 4}',
  '    Rgba: {0, 0, 0, 40}',
  '    Additive',
  '  }',
  '}',
  'template BigLamp {',
  '  cone : Glow {',
  '    Scale3: {2, 2, 2}',
  '    Frustum: {segments: 12, smooth: true, length: 8, radius_bottom: 3.4, radius_top: 0.4}',
  '    NightLight: {strength: 0.3, light: 0, offset: 0, flicker: 0}',
  '  }',
  '}',
  'template Pylon {',
  '  beam {',
  '    Position3: {0, 20, 0}',
  '    Frustum: {segments: 12, smooth: true, length: 24, radius_bottom: 1.1, radius_top: 3.0}',
  '    Rgba: {120, 236, 255, 60}',
  '    Emissive: {strength: 0, color: {120, 236, 255, 255}}',
  '    Additive',
  '    NightLight: {strength: 0.9, light: 0, offset: 0, flicker: 0}',
  '    MaterialAnim: {emissive_pulse_hz: 0.5, emissive_pulse_depth: 0.35}',
  '  }',
  '}',
].join('\n');

const round = (xs: readonly number[]): number[] => xs.map((x) => Math.round(x * 1e4) / 1e4 + 0);

describe('light standing in the air', () => {
  const read = readScripts(['v.flecs'], (f) => (f === 'v.flecs' ? SCRIPT : null));
  const at = (name: string, x: number, z: number, yaw: number) => ({
    name,
    props: new Map(),
    position: [x, z] as const,
    y: 0,
    yaw,
    source: name,
  });

  it('A LAMP’S CONE OPENS DOWN FROM AN APEX ABOVE ITS HEAD, in its glow’s colour at its night strength', () => {
    const parts = instantiateAll(read, [at('Lamp', 10, 20, 0)]).parts;
    const volumes = parts.map((p) => volumeOf(p));
    /* The post is opaque and the pool is flat: neither is light in the air. */
    expect(volumes.filter((v) => v !== null)).toHaveLength(1);
    const cone = volumes.find((v) => v !== null);
    /*
     * The frustum is centred at (10, 5, 22): its narrow top at y 9, its wide foot at y 1. It
     * widens 3 m over 8, a spread of 0.375, so its apex stands 0.4 / 0.375 = 1.0667 m above the
     * top and the light reaches 9.0667 m from there.
     */
    expect(round([...(cone?.apex ?? [])])).toEqual([10, 10.0667, 22]);
    expect(round([...(cone?.axis ?? [])])).toEqual([0, -1, 0]);
    expect(round([cone?.near ?? 0, cone?.length ?? 0, cone?.spread ?? 0])).toEqual([
      1.0667, 9.0667, 0.375,
    ]);
    /*
     * Its glow, linear (1, 0.6724, 0.3515), times what the scripts give it: its night strength
     * 0.3, its alpha 26/255 and its volume's intensity 3.6 — 0.110118 in all.
     */
    expect(round([...(cone?.color ?? [])])).toEqual([0.1101, 0.074, 0.0387]);
    expect([cone?.fadeStart, cone?.fadeEnd, cone?.nearFade]).toEqual([40, 95, 2.5]);
    expect(cone?.pulse).toEqual([0, 0]);
  });

  it('A CONE TURNS AND STANDS WITH ITS LAMP, and an instanced copy’s where the copy stands', () => {
    /* A quarter turn takes the part's (0, _, 2) to (2, _, 0): the apex stands at (12, _, 20). */
    const turned = instantiateAll(read, [at('Lamp', 10, 20, Math.PI / 2)]).parts;
    const cone = turned.map((p) => volumeOf(p)).find((v) => v !== null);
    expect(round([...(cone?.apex ?? [])])).toEqual([12, 10.0667, 20]);
    expect(round([...(cone?.axis ?? [])])).toEqual([0, -1, 0]);
    /* Flattened at the origin and placed, as a repeating lamp is. */
    const origin = instantiateAll(read, [at('Lamp', 0, 0, 0)]).parts;
    const placed = origin
      .map((p) => volumeOf(p, placement(10, 0, 20, Math.PI / 2)))
      .find((v) => v !== null);
    expect(round([...(placed?.apex ?? [])])).toEqual([12, 10.0667, 20]);
  });

  it('A SCALED CONE IS AS WIDE AS ITS SCALE MAKES IT, and its apex as far', () => {
    /* Doubled, the frustum spans 16 m from a 0.8 m top to a 6.8 m foot: the same spread, 0.375,
       and an apex twice as far above the top, 2.1333 m. */
    const [cone] = instantiateAll(read, [at('BigLamp', 0, 0, 0)])
      .parts.map((p) => volumeOf(p))
      .filter((v) => v !== null);
    expect(round([cone?.near ?? 0, cone?.length ?? 0, cone?.spread ?? 0])).toEqual([
      2.1333, 18.1333, 0.375,
    ]);
  });

  it('A BEAM WIDENING UPWARD OPENS UP FROM AN APEX BELOW ITS FOOT, and keeps its pulse', () => {
    const [beam] = instantiateAll(read, [at('Pylon', 0, 0, 0)])
      .parts.map((p) => volumeOf(p))
      .filter((v) => v !== null);
    /*
     * Foot at y 8, radius 1.1; top at y 32, radius 3. A spread of 1.9 / 24 = 0.0791667 puts the
     * apex 13.8947 m below the foot, at y -5.8947, and the light reaches 37.8947 m.
     */
    expect(round([...(beam?.apex ?? [])])).toEqual([0, -5.8947, 0]);
    expect(round([...(beam?.axis ?? [])])).toEqual([0, 1, 0]);
    expect(round([beam?.near ?? 0, beam?.length ?? 0, beam?.spread ?? 0])).toEqual([
      13.8947, 37.8947, 0.0792,
    ]);
    /* Linear (0.1878, 0.8388, 1) times 0.9 and 60/255, with no volume to scale it: 0.211765. */
    expect(round([...(beam?.color ?? [])])).toEqual([0.0398, 0.1776, 0.2118]);
    expect([beam?.fadeStart, beam?.fadeEnd, beam?.nearFade]).toEqual([0, 0, 0]);
    expect(round([...(beam?.pulse ?? [])])).toEqual([0.5, 0.35]);
  });
});

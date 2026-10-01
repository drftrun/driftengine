import { describe, expect, it } from 'vitest';

import type { Surface, TextureRef } from '../mesh/materials.ts';
import { BLANK, planTextures } from './plan.ts';

const tex = (file: string, width = 256, height = 256): TextureRef => ({ file, width, height });

function surface(fields: Partial<Surface> = {}): Surface {
  return {
    color: [1, 1, 1],
    alpha: 1,
    emissive: 0,
    emissiveColor: null,
    windowSeed: 0,
    roughness: 0.8,
    metallic: 0,
    textures: { albedo: null, emissive: null, mr: null },
    rooms: null,
    tiling: null,
    transform: { sx: 1, sy: 1, ox: 0, oy: 0 },
    clamp: false,
    blend: 'opaque',
    effect: undefined,
    ...fields,
  };
}

describe('the texture plan', () => {
  it('A LAYER IS A PICTURE AND WHAT IT DOES: equal ones share, wear inside one step shares, an emissive twin shares its albedo’s index', () => {
    const brick = { albedo: tex('brick.svg'), emissive: null, mr: null };
    const sign = {
      albedo: tex('sign.svg', 512, 128),
      emissive: tex('sign.svg', 512, 128),
      mr: null,
    };
    const plan = planTextures([
      surface({ textures: brick, effect: { wear: { dust: 0.52 } } }),
      surface({ textures: brick, effect: { wear: { dust: 0.48 } } }),
      surface({ textures: brick, effect: { wear: { dust: 0.8 } } }),
      surface({ textures: sign }),
    ]);
    const at = (s: Surface) => plan.layerOf(s);
    /* 0.52 and 0.48 both round to the 0.1 step at 0.5; 0.8 does not. */
    expect(at(surface({ textures: brick, effect: { wear: { dust: 0.52 } } }))).toEqual({
      cls: 1,
      layer: 0,
    });
    expect(at(surface({ textures: brick, effect: { wear: { dust: 0.48 } } }))).toEqual({
      cls: 1,
      layer: 0,
    });
    expect(at(surface({ textures: brick, effect: { wear: { dust: 0.8 } } }))).toEqual({
      cls: 1,
      layer: 1,
    });
    /* 512 × 128 is the 512 class; its albedo and emissive are one layer's two pictures. */
    expect(at(surface({ textures: sign }))).toEqual({ cls: 2, layer: 0 });
    expect(plan.classes[2]?.layers[0]).toMatchObject({
      albedo: { file: 'sign.svg' },
      emissive: { file: 'sign.svg' },
    });
    expect(plan.classes.map((c) => c.size)).toEqual([BLANK, 256, 512]);
  });

  it('untextured surfaces are white layers of the blank class, one for each thing they do', () => {
    const plan = planTextures([surface(), surface({ effect: { dry: true } })]);
    expect(plan.layerOf(surface())).toEqual({ cls: 0, layer: 0 });
    expect(plan.layerOf(surface({ effect: { dry: true } }))).toEqual({ cls: 0, layer: 1 });
    expect(plan.classes[0]?.layers[0]).toMatchObject({ albedo: null, effect: undefined });
  });

  it('A FACADE’S ROOMS ARE A LAYER OF ITS OWN ARRAY, AND ITS EFFECT NAMES THAT LAYER', () => {
    const facade = surface({
      textures: { albedo: tex('facade.svg'), emissive: null, mr: null },
      rooms: tex('rooms.svg', 512, 512),
      effect: {
        windows: { cells: [4, 4], glass: true, glow: 1 },
        interior: { roomLayer: -1, depth: 0.63, lit: 0.3 },
      },
    });
    const plan = planTextures([facade]);
    const { cls, layer } = plan.layerOf(facade);
    const layers = plan.classes[cls]?.layers ?? [];
    /* The 512 room picture joins the facade's 256 array rather than an array of its own. */
    expect(cls).toBe(1);
    const room = layers.findIndex((l) => l.albedo?.file === 'rooms.svg');
    expect(room).toBeGreaterThanOrEqual(0);
    /* A second facade behind the same rooms shares the room layer. */
    const other = { ...facade, textures: { albedo: tex('facade2.svg'), emissive: null, mr: null } };
    const both = planTextures([facade, other]);
    const roomsIn = (both.classes[1]?.layers ?? []).filter((l) => l.albedo?.file === 'rooms.svg');
    expect(roomsIn).toHaveLength(1);
    /* Depth to the 0.1 step, the lit share to the quarter. */
    expect(layers[layer]?.effect?.interior).toEqual({ roomLayer: room, depth: 0.6, lit: 0.25 });
  });

  it('a flipbook is its sheet’s columns as successive layers, the first carrying the animation', () => {
    const flame = surface({
      textures: {
        albedo: tex('flame.svg', 512, 512),
        emissive: tex('flame.svg', 512, 512),
        mr: null,
      },
      effect: { animation: { flipbook: [4, 12] } },
    });
    const plan = planTextures([
      surface({ textures: { albedo: tex('other.svg', 512, 512), emissive: null, mr: null } }),
      flame,
    ]);
    const { cls, layer } = plan.layerOf(flame);
    const layers = plan.classes[cls]?.layers ?? [];
    expect(layer).toBe(1);
    expect(layers.slice(1, 5).map((l) => l.frame)).toEqual([
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
    ]);
    expect(layers[1]?.effect?.animation?.flipbook).toEqual([4, 12]);
  });
});

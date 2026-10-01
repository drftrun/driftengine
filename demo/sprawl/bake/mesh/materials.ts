/**
 * A part's material set as the surface a copy wears: its colour and emission as vertex constants,
 * the images it names, how its texture tiles, how it blends, and what its texture layer does
 * beyond its picture.
 *
 * **Colours are linear.** The scripts write sRGB bytes, as any colour picked by eye is; the engine
 * shades in linear light, so a byte is decoded through the sRGB curve on the way in.
 *
 * **Night light is the engine's night-gated emissive.** `Emissive.strength` is zero almost
 * everywhere, because `NightLight` raises it from nothing by day to its own strength at night —
 * which is exactly what `MeshData.emissive` means. What that gives up is `NightLight.offset`, each
 * light's place in the dusk ramp: every light comes on together. **Its flicker is kept**, as the
 * emission stuttering that `MaterialAnim`'s own flicker is — a street span's signs hung dead still
 * without it.
 *
 * **Where the windows are is the layer's; whose light is in them is the building's.** A facade's
 * `InteriorMap` becomes the texture layer's effect (`SurfaceLayerEffect`) — the window grid, the
 * glass, the rooms, whose image the texture plan gives a layer. But every facade of a style shares
 * that layer, and its `WindowLights` strength and colour differ building by building, so the light
 * rides the vertices as their emissive colour, strength folded in, which the engine reads as the
 * window's own light; its vertex emissive stays zero, or the whole wall would glow. The seed that
 * picks which windows are lit rides the copy, as a shift of whole repeats. `SurfaceWear`'s `edge`
 * and `burn` have no counterpart and are dropped; its `scratch` is the effect's streaks.
 *
 * **Tiling is in the piece's own units, before `Scale3`** — the spec's default for a question the
 * scripts leave open, to be checked against a capture.
 */
import type { SurfaceLayerEffect } from '@driftengine/core';

import type { Value } from '../script/values.ts';
import { effective } from '../script/world.ts';
import type { MaterialSet } from './flatten.ts';

export interface TextureRef {
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface Surface {
  /** Linear. */
  readonly color: readonly [number, number, number];
  readonly alpha: number;
  /** The night-gated emission. */
  readonly emissive: number;
  /** Linear, or null to glow in the surface's own colour. A facade's: its windows' light. */
  readonly emissiveColor: readonly [number, number, number] | null;
  /** Which of a facade's windows are lit, shifted per building by the copy; 0 for none. */
  readonly windowSeed: number;
  readonly roughness: number;
  readonly metallic: number;
  readonly textures: {
    readonly albedo: TextureRef | null;
    readonly emissive: TextureRef | null;
    readonly mr: TextureRef | null;
  };
  /** The rooms seen behind the windows, whose layer the texture plan chooses. */
  readonly rooms: TextureRef | null;
  /** Metres per repeat, or null for the piece's own coordinates. */
  readonly tiling: {
    readonly mx: number;
    readonly my: number;
    readonly cylinder: boolean;
    readonly fit: boolean;
  } | null;
  readonly transform: {
    readonly sx: number;
    readonly sy: number;
    readonly ox: number;
    readonly oy: number;
  };
  readonly clamp: boolean;
  /** How it covers what is behind it; `cutout` is a tree's leaves, cut out of their picture. */
  readonly blend: 'opaque' | 'additive' | 'blend' | 'cutout';
  /** What the texture layer does beyond its picture, or undefined for nothing. */
  readonly effect: SurfaceLayerEffect | undefined;
}

const field = (v: Value | undefined, key: string): Value | undefined =>
  v?.k === 'struct' ? v.fields?.get(key) : undefined;
const num = (v: Value | undefined, key: string, fallback: number): number => {
  const f = field(v, key);
  return f?.k === 'num' ? f.v : fallback;
};
const flag = (v: Value | undefined, key: string): boolean => {
  const f = field(v, key);
  return (f?.k === 'num' && f.v !== 0) || (f?.k === 'symbol' && f.name === 'true');
};

/** An sRGB byte as linear light. */
export function linear(byte: number): number {
  const c = Math.min(Math.max(byte / 255, 0), 1);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(v: Value | undefined): [number, number, number] | null {
  if (v?.k !== 'struct') return null;
  return [linear(num(v, 'r', 255)), linear(num(v, 'g', 255)), linear(num(v, 'b', 255))];
}

function texture(v: Value | undefined): TextureRef | null {
  if (v?.k !== 'entity' || v.entity === null) return null;
  const t = effective(v.entity, 'Texture');
  const file = field(t, 'file');
  if (file?.k !== 'str') return null;
  return { file: file.v, width: num(t, 'width', 256), height: num(t, 'height', 256) };
}

export function surfaceOf(material: MaterialSet): Surface {
  const c = material.components;
  const rgba = c.get('Rgba');
  const pbr = c.get('PbrMaterial');
  const emissive = c.get('Emissive');
  const night = c.get('NightLight');
  const windows = c.get('WindowLights');
  const maps = c.get('PbrTextures');
  const tiling = c.get('TextureTiling');
  const transform = c.get('TextureTransform');
  const wrap = field(c.get('TextureWrap'), 'mode');
  const interior = c.get('InteriorMap');
  const wear = c.get('SurfaceWear');
  const anim = c.get('MaterialAnim');
  const emissiveColor = rgb(field(emissive, 'color'));

  const effect: {
    -readonly [K in keyof SurfaceLayerEffect]: SurfaceLayerEffect[K];
  } = {};
  const lit = windows !== undefined && interior !== undefined;
  if (lit) {
    effect.windows = {
      cells: [num(interior, 'cells_x', 4), num(interior, 'cells_y', 4)],
      glass: true,
      glow: 1,
    };
  }
  const strength = num(windows, 'strength', 0);
  const light = emissiveColor ?? [1, 0.82, 0.55];
  if (interior !== undefined) {
    effect.interior = {
      roomLayer: -1,
      depth: num(interior, 'depth', 0.5),
      lit: num(interior, 'lit_ratio', 1),
    };
  }
  if (wear !== undefined) {
    effect.wear = {
      dust: num(wear, 'dust', 0),
      grime: num(wear, 'grime', 0),
      streaks: num(wear, 'scratch', 0),
      fade: 0,
    };
  }
  if (anim !== undefined) {
    effect.animation = {
      scroll: [num(anim, 'uv_scroll_x', 0), num(anim, 'uv_scroll_y', 0)],
      pulse: [num(anim, 'emissive_pulse_hz', 0), num(anim, 'emissive_pulse_depth', 0)],
      flicker: num(anim, 'flicker_depth', 0),
      flipbook: [num(anim, 'flipbook_frames', 0), num(anim, 'flipbook_fps', 0)],
      fade: num(anim, 'emissive_fade_end', 0),
    };
  }
  /* A night light's flicker is its emission stuttering, the larger of it and MaterialAnim's. */
  const nightFlicker = num(night, 'flicker', 0);
  if (nightFlicker > 0) {
    effect.animation = {
      ...effect.animation,
      flicker: Math.max(effect.animation?.flicker ?? 0, nightFlicker),
    };
  }
  if (material.tags.has('DryMaterial')) effect.dry = true;

  return {
    color: rgb(rgba) ?? [1, 1, 1],
    alpha: rgba === undefined ? 1 : num(rgba, 'a', 255) / 255,
    /* A facade's windows glow through its layer; everything else by night, as NightLight says. */
    emissive:
      windows !== undefined
        ? 0
        : night !== undefined
          ? num(night, 'strength', 0)
          : num(emissive, 'strength', 0),
    emissiveColor: lit
      ? [light[0] * strength, light[1] * strength, light[2] * strength]
      : emissiveColor,
    windowSeed: lit ? num(interior, 'seed', 0) : 0,
    roughness: num(pbr, 'roughness', 0.8),
    metallic: num(pbr, 'metallic', 0),
    textures: {
      albedo: texture(field(maps, 'albedo')),
      emissive: texture(field(maps, 'emissive')),
      mr: texture(field(maps, 'roughness')),
    },
    rooms: texture(field(interior, 'atlas')),
    tiling:
      tiling === undefined
        ? null
        : {
            mx: num(tiling, 'meters_x', 1),
            my: num(tiling, 'meters_y', 1),
            cylinder:
              field(tiling, 'shape')?.k === 'symbol' &&
              symbolName(field(tiling, 'shape')) === 'TilingCylinder',
            fit: flag(tiling, 'fit'),
          },
    transform: {
      sx: num(transform, 'scale_x', 1),
      sy: num(transform, 'scale_y', 1),
      ox: num(transform, 'offset_x', 0),
      oy: num(transform, 'offset_y', 0),
    },
    clamp: symbolName(wrap) === 'WrapClamp',
    /* A volume of light adds its light whether or not its material says so: the reference's one
       light cone carries `VolumeGlow` and no `Additive`, and drawn over it was a solid dark cone. */
    blend:
      material.tags.has('Additive') || c.has('VolumeGlow')
        ? 'additive'
        : material.tags.has('AlphaBlend')
          ? 'blend'
          : 'opaque',
    effect: Object.keys(effect).length === 0 ? undefined : effect,
  };
}

function symbolName(v: Value | undefined): string {
  if (v?.k === 'symbol') return v.name;
  if (v?.k === 'entity') return v.entity?.name ?? '';
  return '';
}

/**
 * How a copy's coordinates stretch, as `MSHC` carries it: u along each piece axis, v along each,
 * then the offset. `extents` is the piece's size in its own units along x, y and z — a box's three
 * sides; a round piece's diameter, length and diameter.
 *
 * A box repeats `size / tile` times along each axis, rounded to whole repeats where the tiling
 * fits and never to none. A round piece's coordinate runs once around, so around it repeats its
 * circumference over the tile, and along its axis its length over the tile. With no tiling the
 * piece keeps its own coordinates. `TextureTransform` then scales and offsets.
 */
export function uvStretch(
  surface: Surface,
  shape: 'box' | 'round',
  extents: readonly [number, number, number],
): Float32Array {
  const out = new Float32Array(8);
  const t = surface.tiling;
  const repeats = (size: number, tile: number): number => {
    const r = size / tile;
    return t?.fit === true ? Math.max(1, Math.round(r)) : r;
  };
  for (let a = 0; a < 3; a++) {
    let u = 1;
    let v = 1;
    if (t !== null && shape === 'box') {
      u = repeats(extents[a] as number, t.mx);
      v = repeats(extents[a] as number, t.my);
    } else if (t !== null) {
      const around = (Math.PI * ((extents[0] as number) + (extents[2] as number))) / 2;
      u = a === 1 ? repeats(extents[1], t.my) : repeats(around, t.mx);
      v = u;
    }
    out[a] = u * surface.transform.sx;
    out[3 + a] = v * surface.transform.sy;
  }
  out[6] = surface.transform.ox;
  out[7] = surface.transform.oy;
  return out;
}

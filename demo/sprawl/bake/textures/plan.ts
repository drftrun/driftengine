/**
 * Which layer of which texture array every surface wears.
 *
 * **A layer is a picture and what it does.** The effects table is per layer, so two surfaces
 * sharing an image but not its wear need two layers — and a layer is a whole image's worth of
 * memory. So what a layer does is quantised before it is compared: wear and flicker to a tenth,
 * a pulse to a quarter hertz, the lit share of rooms to a quarter. Measured on the city being
 * built, that takes 2,980 distinct effects to 319 layers; what it gives up is a difference of
 * less than a step, which no two neighbouring buildings show. What varies building by building
 * and would not quantise — a window's light, which windows are lit — is not the layer's at all:
 * it rides the vertices and the copy (`materials.ts`).
 *
 * **Arrays by size class.** Every layer of an array is one size, so an image goes to the class of
 * its larger side — 256 for anything up to it, 512 above, a 1024 image downsampled — and a class
 * past the 256 layers both backends promise is refused rather than split, since nothing here comes
 * near it. Untextured surfaces are white layers of a tiny blank class, one per effect they carry,
 * which is what lets an untextured wall wear dust. **A facade's rooms join the facade's own
 * array**, because the effect names the room by layer in the same array. **A flipbook is its
 * sheet's columns as successive layers**, as the engine plays one, the first carrying the
 * animation.
 */
import type { SurfaceLayerEffect } from '@driftengine/core';

import type { Surface, TextureRef } from '../mesh/materials.ts';

/** The blank class's layer size: white, so a few texels are enough. */
export const BLANK = 4;
const CLASSES = [BLANK, 256, 512] as const;
const MAX_LAYERS = 256;

export interface PlannedLayer {
  /** Null for white. */
  readonly albedo: TextureRef | null;
  /** Null for none: the emissive array holds black there. */
  readonly emissive: TextureRef | null;
  readonly mr: TextureRef | null;
  /** For a flipbook: which column of its sheet, of how many. */
  readonly frame: readonly [number, number] | null;
  readonly effect: SurfaceLayerEffect | undefined;
}

export interface TextureClass {
  readonly size: number;
  readonly layers: PlannedLayer[];
}

export interface TexturePlan {
  readonly classes: readonly TextureClass[];
  /** The array and layer a surface wears. */
  layerOf(surface: Surface): { cls: number; layer: number };
}

const step = (x: number | undefined, by: number): number =>
  x === undefined ? 0 : Math.round(Math.round(x / by) * by * 1000) / 1000;

/** What a layer does, as the plan compares it: quantised, with no room layer resolved yet. */
function quantised(effect: SurfaceLayerEffect | undefined): SurfaceLayerEffect | undefined {
  if (effect === undefined) return undefined;
  const out: { -readonly [K in keyof SurfaceLayerEffect]: SurfaceLayerEffect[K] } = {};
  if (effect.windows)
    out.windows = { cells: effect.windows.cells, glass: effect.windows.glass === true, glow: 1 };
  if (effect.interior) {
    out.interior = {
      roomLayer: -1,
      depth: step(effect.interior.depth, 0.1),
      lit: step(effect.interior.lit ?? 1, 0.25),
    };
  }
  if (effect.wear) {
    out.wear = {
      dust: step(effect.wear.dust, 0.1),
      grime: step(effect.wear.grime, 0.1),
      streaks: step(effect.wear.streaks, 0.1),
      fade: effect.wear.fade ?? 0,
    };
  }
  const a = effect.animation;
  if (a) {
    out.animation = {
      scroll: [step(a.scroll?.[0], 0.05), step(a.scroll?.[1], 0.05)],
      pulse: [step(a.pulse?.[0], 0.25), step(a.pulse?.[1], 0.1)],
      flicker: step(a.flicker, 0.1),
      flipbook: [a.flipbook?.[0] ?? 0, a.flipbook?.[1] ?? 0],
      fade: a.fade ?? 0,
    };
  }
  if (effect.dry === true) out.dry = true;
  return out;
}

function classOf(texture: TextureRef | null): number {
  if (texture === null) return 0;
  return Math.max(texture.width, texture.height) <= 256 ? 1 : 2;
}

const keyOf = (s: Surface): string =>
  JSON.stringify([
    s.textures.albedo?.file ?? null,
    s.textures.emissive?.file ?? null,
    s.textures.mr?.file ?? null,
    s.rooms?.file ?? null,
    quantised(s.effect) ?? null,
  ]);

export function planTextures(surfaces: Iterable<Surface>): TexturePlan {
  const classes: TextureClass[] = CLASSES.map((size) => ({ size, layers: [] }));
  const placed = new Map<string, { cls: number; layer: number }>();
  const rooms = new Map<string, number>();
  const push = (cls: number, layer: PlannedLayer): number => {
    const list = (classes[cls] as TextureClass).layers;
    if (list.length >= MAX_LAYERS) {
      throw new Error(`texture class ${CLASSES[cls]} needs more than ${MAX_LAYERS} layers`);
    }
    list.push(layer);
    return list.length - 1;
  };
  /* The white, plain layer every untextured surface without an effect wears, always first. */
  push(0, { albedo: null, emissive: null, mr: null, frame: null, effect: undefined });
  placed.set(keyOf(blankSurface), { cls: 0, layer: 0 });

  for (const s of surfaces) {
    const key = keyOf(s);
    if (placed.has(key)) continue;
    const cls = classOf(s.textures.albedo ?? s.textures.emissive);
    let effect = quantised(s.effect);
    if (effect?.interior !== undefined && s.rooms !== null) {
      const roomKey = `${cls}:${s.rooms.file}`;
      let room = rooms.get(roomKey);
      if (room === undefined) {
        room = push(cls, {
          albedo: s.rooms,
          emissive: null,
          mr: null,
          frame: null,
          effect: undefined,
        });
        rooms.set(roomKey, room);
      }
      effect = { ...effect, interior: { ...effect.interior, roomLayer: room } };
    }
    const frames = Math.max(1, effect?.animation?.flipbook?.[0] ?? 0);
    const first = push(cls, {
      albedo: s.textures.albedo,
      emissive: s.textures.emissive,
      mr: s.textures.mr,
      frame: frames > 1 ? [0, frames] : null,
      effect,
    });
    for (let f = 1; f < frames; f++) {
      push(cls, {
        albedo: s.textures.albedo,
        emissive: s.textures.emissive,
        mr: s.textures.mr,
        frame: [f, frames],
        effect,
      });
    }
    placed.set(key, { cls, layer: first });
  }

  return {
    classes,
    layerOf(surface) {
      const at = placed.get(keyOf(surface));
      if (at === undefined) throw new Error('a surface the plan was not given');
      return at;
    },
  };
}

const blankSurface = {
  textures: { albedo: null, emissive: null, mr: null },
  rooms: null,
  effect: undefined,
} as unknown as Surface;

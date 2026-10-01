/**
 * The texture plan as the page that draws the regions reads it: each array's size and, layer by
 * layer, the pictures it wears, the column of a flipbook it is, and what it does. The caller adds
 * which class each region's meshes are, since a mesh in the container does not say.
 *
 * Paths are relative to the data folder's `derived/`, where the pictures and this file both live.
 */
import { relative } from 'node:path';

import type { TextureRef } from '../mesh/materials.ts';
import { rasterKey } from '../textures/rasterize.ts';
import type { TexturePlan } from '../textures/plan.ts';

/** Every picture the plan names, once each. */
export function planPictures(plan: TexturePlan): TextureRef[] {
  const seen = new Map<string, TextureRef>();
  for (const cls of plan.classes) {
    for (const layer of cls.layers) {
      for (const t of [layer.albedo, layer.emissive, layer.mr])
        if (t !== null) seen.set(rasterKey(t), t);
    }
  }
  return [...seen.values()];
}

/** The pictures the plan wears as data — metalness and roughness — by raster key. */
export function dataMaps(plan: TexturePlan): Set<string> {
  const out = new Set<string>();
  for (const cls of plan.classes) {
    for (const layer of cls.layers) if (layer.mr !== null) out.add(rasterKey(layer.mr));
  }
  return out;
}

/** The plan with each picture named as the container's `TEXS` names it: its raster key. */
export function planByName(plan: TexturePlan): { classes: unknown[] } {
  return planWith(plan, (t) => (t === null ? null : rasterKey(t)));
}

export function planData(
  plan: TexturePlan,
  paths: ReadonlyMap<string, string>,
  derived: string,
): { classes: unknown[] } {
  return planWith(plan, (t) => {
    if (t === null) return null;
    const path = paths.get(rasterKey(t));
    if (path === undefined) throw new Error(`${t.file} was not rasterised`);
    return relative(derived, path);
  });
}

function planWith(
  plan: TexturePlan,
  at: (t: TextureRef | null) => string | null,
): { classes: unknown[] } {
  return {
    classes: plan.classes.map((c) => ({
      size: c.size,
      layers: c.layers.map((l) => ({
        albedo: at(l.albedo),
        emissive: at(l.emissive),
        mr: at(l.mr),
        frame: l.frame,
        effect: l.effect ?? null,
      })),
    })),
  };
}

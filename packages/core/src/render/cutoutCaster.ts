/**
 * Which shadow casters cut their shadow out of their texture's alpha, decided once for both backends.
 *
 * **A caster with an albedo and a cutoff above zero is a cutout**: a leaf card, a chain link, a
 * fence, whose shape is in its alpha and not in its geometry. The same test the colour pass makes
 * when it discards, so a surface that is a hole in the picture is a hole in its shadow. Written once,
 * here, because two backends deciding it separately is how they come to disagree about a leaf
 * (AGENTS.md, 2026-08-13).
 *
 * Called per draw, so the answer is written into one object and returned again: a draw allocates
 * nothing. What that gives up is holding two answers at once, which no caller does; the depth pass
 * reads it and binds before it asks again.
 */
import type { SurfaceMaterial } from './surfaceTexture.ts';

/** A cutout caster's texture, its cutoff and its UV scale and offset. */
export interface CutoutCaster<Texture> {
  readonly albedo: Texture;
  readonly cutoff: number;
  readonly u: number;
  readonly v: number;
  readonly uOffset: number;
  readonly vOffset: number;
}

const answer: {
  albedo: unknown;
  cutoff: number;
  u: number;
  v: number;
  uOffset: number;
  vOffset: number;
} = {
  albedo: null,
  cutoff: 0,
  u: 1,
  v: 1,
  uOffset: 0,
  vOffset: 0,
};

/** The cutout `material` casts, or null for an ordinary caster. */
export function cutoutOf<Texture>(
  material: SurfaceMaterial<Texture> | null | undefined,
): CutoutCaster<Texture> | null {
  if (material === null || material === undefined) return null;
  const albedo = material.albedo ?? null;
  const cutoff = material.cutout ?? 0;
  if (albedo === null || !(cutoff > 0)) return null;
  answer.albedo = albedo;
  answer.cutoff = cutoff;
  answer.u = material.uScale ?? 1;
  answer.v = material.vScale ?? 1;
  answer.uOffset = material.uOffset ?? 0;
  answer.vOffset = material.vOffset ?? 0;
  return answer as CutoutCaster<Texture>;
}

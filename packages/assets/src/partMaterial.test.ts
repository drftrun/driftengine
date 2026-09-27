import { expect, test } from 'vitest';
import { writePartMaterial } from './partMaterial.ts';
import type { DrftPart } from './loadProgress.ts';

/**
 * A loaded part's whole material, in the shape the renderer takes.
 *
 * **Written because a consumer copying it by hand left one field behind and got a black model.**
 * `SurfaceMaterial.occlusionStrength` defaults to 1; a glTF material with no occlusion texture is
 * carried as 0, and its ORM map's red channel is 0 everywhere, as glTF lets it be. So a caller who
 * copied the maps and not the strength multiplied every surface by nothing. Measured on a bought
 * courtyard: 30.9 mean against 72.1 with the strength passed.
 */

const texture = (name: string) => ({ name }) as never;
const textures = { at: (i: number) => [texture('t0'), texture('t1'), texture('t2')][i] ?? null };

function part(overrides: Partial<DrftPart>): DrftPart {
  return {
    mesh: {} as never,
    albedo: 0,
    orm: 1,
    normal: 2,
    emissive: -1,
    roughnessScale: 0.8,
    metallicScale: 0.3,
    occlusionStrength: 0,
    opacity: 1,
    reflectivity: 0.04,
    cutout: 0.5,
    reveal: 1,
    ...overrides,
  } as DrftPart;
}

test('EVERY FIELD THAT SHAPES THE SURFACE ARRIVES, THE OCCLUSION STRENGTH INCLUDED', () => {
  const out = {};
  writePartMaterial(part({}), textures as never, out);
  expect(out).toEqual({
    albedo: { name: 't0' },
    orm: { name: 't1' },
    normal: { name: 't2' },
    emissive: null,
    roughnessScale: 0.8,
    metallicScale: 0.3,
    occlusionStrength: 0,
    cutout: 0.5,
  });
});

test('a part with no maps, or no texture set yet, binds none', () => {
  const out = {};
  writePartMaterial(part({ albedo: -1, orm: -1, normal: -1 }), null, out);
  expect(out).toMatchObject({ albedo: null, orm: null, normal: null, emissive: null });
});

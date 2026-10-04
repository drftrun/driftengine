import { afterEach, expect, test, vi } from 'vitest';
import { materialHasMaps, noteMapsWithoutUvs } from './mapsWithoutUvs.ts';

afterEach(() => vi.restoreAllMocks());

/* The silence was the defect: a material's maps on a mesh with no coordinates drew exactly as if
   nothing were bound. Once per mesh, so a mesh drawn every frame is not a flood. */
test('a mesh with no coordinates drawn with maps is said once, and nothing else is said', () => {
  const said = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const bare = {};
  const textured = {};

  noteMapsWithoutUvs(bare, false, true);
  noteMapsWithoutUvs(bare, false, true);
  expect(said).toHaveBeenCalledTimes(1);
  expect(String(said.mock.calls[0]?.[0])).toContain('no texture coordinates');

  noteMapsWithoutUvs(textured, true, true);
  noteMapsWithoutUvs({}, false, false);
  expect(said, 'coordinates, or no maps, are nothing to say').toHaveBeenCalledTimes(1);
});

/* A one-colour ORM map read at one texel is a constant roughness and metalness, which is what it
   was bound for; a picture is not. */
test('an ORM map alone is not a picture, and an albedo, normal or emissive map is', () => {
  expect(materialHasMaps({ orm: {} })).toBe(false);
  expect(materialHasMaps({ albedo: {} })).toBe(true);
  expect(materialHasMaps({ normal: {} })).toBe(true);
  expect(materialHasMaps({ emissive: {} })).toBe(true);
  expect(materialHasMaps(null)).toBe(false);
});

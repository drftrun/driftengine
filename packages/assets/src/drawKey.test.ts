import { describe, expect, it } from 'vitest';
import type { DrftMaterial } from '@driftengine/drft';
import { drawKeyOf, resolveDrawGrouping } from './drawKey.ts';

/*
 * Why this file exists at all.
 *
 * `DrftLoader` merges parts whose material would set the same GPU state, on a key it used to build
 * inline. A consumer counting how many draws a baked part will cost rebuilt that key by hand —
 * their own comment said "`DrftLoader.uploadOne`'s own key, field for field" — and it went one
 * field stale the day `cutout` joined the key. So the test that matters here is not that the key
 * has a shape; it is that **every field which changes GPU state changes the key**, asserted field
 * by field, so a tenth field added to the loader and forgotten here fails rather than silently
 * merging two surfaces that differ.
 */

function material(fields: Partial<DrftMaterial> = {}): DrftMaterial {
  return {
    name: 'a',
    albedo: -1,
    ormMap: -1,
    normalMap: -1,
    emissiveMap: -1,
    opacity: 1,
    reflectivity: 0,
    roughnessScale: 1,
    metallicScale: 1,
    occlusionStrength: 0,
    cutout: 0,
    ...fields,
  } as DrftMaterial;
}

describe('drawKeyOf', () => {
  it('gives two materials that set the same state the same key', () => {
    expect(drawKeyOf(material({ name: 'body' }))).toBe(drawKeyOf(material({ name: 'glass' })));
  });

  /*
   * One case per field, because the defect this closes is a field going missing. A loop over the
   * ten names would read tidier and would not fail when an eleventh arrives.
   */
  it.each([
    ['albedo', { albedo: 3 }],
    ['ormMap', { ormMap: 3 }],
    ['normalMap', { normalMap: 3 }],
    ['emissiveMap', { emissiveMap: 3 }],
    ['opacity', { opacity: 0.5 }],
    ['reflectivity', { reflectivity: 0.5 }],
    ['roughnessScale', { roughnessScale: 0.5 }],
    ['metallicScale', { metallicScale: 0.5 }],
    ['occlusionStrength', { occlusionStrength: 0.5 }],
    ['cutout', { cutout: 0.5 }],
  ] as const)('separates two materials differing only in %s', (_name, fields) => {
    expect(drawKeyOf(material(fields))).not.toBe(drawKeyOf(material()));
  });

  it('takes the same defaults as the loader for a part with no material at all', () => {
    expect(drawKeyOf(undefined)).toBe(drawKeyOf(material()));
  });

  /* The override is what `DrftLoaderOptions.surface` returns, and the loader applies it first. */
  it('lets an override separate two parts that share a material', () => {
    const glass = material();
    expect(drawKeyOf(glass, { opacity: 0.4 })).not.toBe(drawKeyOf(glass));
    expect(drawKeyOf(glass, { reflectivity: 0.9 })).not.toBe(drawKeyOf(glass));
  });

  it('prefers the override to the material, which is the loader s order', () => {
    expect(drawKeyOf(material({ opacity: 0.2 }), { opacity: 0.7 })).toBe(
      drawKeyOf(material({ opacity: 0.7 })),
    );
  });
});

describe('resolveDrawGrouping', () => {
  it('reports the fields the loader stores on a group, resolved', () => {
    expect(
      resolveDrawGrouping(material({ albedo: 2, cutout: 0.5 }), { reflectivity: 0.3 }),
    ).toEqual({
      albedo: 2,
      orm: -1,
      normal: -1,
      emissive: -1,
      opacity: 1,
      reflectivity: 0.3,
      roughnessScale: 1,
      metallicScale: 1,
      occlusionStrength: 0,
      cutout: 0.5,
    });
  });

  it('answers for no material with the same defaults a missing field takes', () => {
    expect(resolveDrawGrouping(undefined)).toEqual({
      albedo: -1,
      orm: -1,
      normal: -1,
      emissive: -1,
      opacity: 1,
      reflectivity: 0,
      roughnessScale: 1,
      metallicScale: 1,
      occlusionStrength: 0,
      cutout: 0,
    });
  });
});

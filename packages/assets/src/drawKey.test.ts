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
    ['transmission', { transmission: 0.5 }],
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
      blend: false,
      doubleSided: false,
      transmission: 0,
      frost: 0,
      tint: [1, 1, 1],
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
      blend: false,
      doubleSided: false,
      transmission: 0,
      frost: 0,
      tint: [1, 1, 1],
    });
  });
});

it('A BLENDED SURFACE IS NEVER MERGED WITH AN OPAQUE ONE THAT SHARES ITS MAPS', () => {
  /*
   * A leaf and the bark it grows from can wear one atlas. Merged, one of them would take the other's
   * draw: the leaf drawn opaque and its shape lost, or the bark drawn blended and sorted with glass.
   */
  const leaf = material({ albedo: 1, blend: true });
  const bark = material({ albedo: 1 });
  expect(resolveDrawGrouping(leaf).blend).toBe(true);
  expect(drawKeyOf(leaf)).not.toBe(drawKeyOf(bark));
});

it('A TWO-SIDED SURFACE IS NEVER MERGED WITH A ONE-SIDED ONE THAT SHARES ITS MAPS', () => {
  /*
   * A curtain and the stone behind it can wear one atlas. Merged, one draw culls both or neither:
   * the curtain a hole from behind, or the wall drawn with its inside faces showing.
   */
  const curtain = material({ albedo: 1, doubleSided: true });
  const wall = material({ albedo: 1 });
  expect(resolveDrawGrouping(curtain).doubleSided).toBe(true);
  expect(drawKeyOf(curtain)).not.toBe(drawKeyOf(wall));
});

it('AN OVERRIDE MAY SAY A SURFACE IS NOT METAL, whatever its map says', () => {
  /*
   * A bought courtyard's stone maps carry up to 0.37 in the metallic channel, on the clean stone:
   * shaded, each such patch swapped its diffuse light for a reflection of a dark gallery and read
   * as a black blotch. Stone is a dielectric; a consumer who can name the material says so here.
   */
  const stone = material({ albedo: 1, metallicScale: 1 });
  expect(resolveDrawGrouping(stone, { metallicScale: 0 }).metallicScale).toBe(0);
  expect(resolveDrawGrouping(stone).metallicScale).toBe(1);
  expect(drawKeyOf(stone, { metallicScale: 0 })).not.toBe(drawKeyOf(stone));
});

it('AN OVERRIDE MAY SAY A SURFACE IS GLASS, and glass is drawn blended', () => {
  /*
   * A bought model's lantern panes arrive as an opaque dark material: the file cannot say glass.
   * A consumer who can name the material says it here, and the part is then drawn over what is
   * behind it, so it cannot share a draw with the opaque surface it was.
   */
  const pane = material({ albedo: 1 });
  const glass = resolveDrawGrouping(pane, { transmission: 0.9, frost: 0.5 });
  expect(glass.blend).toBe(true);
  expect(glass.transmission).toBeCloseTo(0.9, 6);
  expect(glass.frost).toBeCloseTo(0.5, 6);
  expect(glass.tint).toEqual([1, 1, 1]);
  expect(drawKeyOf(pane, { transmission: 0.9, frost: 0.5 })).not.toBe(drawKeyOf(pane));
  /* Two glasses differing in how much passes, how milky or how coloured are two draws. Blend
     alone separates glass from what it was, so each of these is asserted between two glasses. */
  expect(drawKeyOf(pane, { transmission: 0.5 })).not.toBe(drawKeyOf(pane, { transmission: 0.9 }));
  expect(drawKeyOf(pane, { transmission: 0.9, frost: 0.2 })).not.toBe(
    drawKeyOf(pane, { transmission: 0.9, frost: 0.5 }),
  );
  expect(drawKeyOf(pane, { transmission: 0.9, tint: [1, 0.8, 0.6] })).not.toBe(
    drawKeyOf(pane, { transmission: 0.9 }),
  );
});

it('A FILE THAT SAYS GLASS IS KEPT AS GLASS, and frost without transmission is nothing', () => {
  const bottle = material({ transmission: 0.8, frost: 0.3, tint: [0.9, 1, 0.9] });
  const read = resolveDrawGrouping(bottle);
  expect(read.transmission).toBeCloseTo(0.8, 6);
  expect(read.frost).toBeCloseTo(0.3, 6);
  expect(read.tint).toEqual([0.9, 1, 0.9]);
  expect(read.blend).toBe(true);
  /* Letting nothing through is not glass, so a stray frost or tint must not split a draw. */
  expect(drawKeyOf(material({ frost: 0.7, tint: [0.5, 0.5, 0.5] }))).toBe(drawKeyOf(material()));
});

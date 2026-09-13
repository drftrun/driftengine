import { expect, test } from 'vitest';
import { TextureSet, textureColorSpaces } from './drftTextures.ts';
import { CODEC_RAW } from '@driftengine/drft';
import type { DrftTexture } from '@driftengine/drft';

/**
 * Addressing a texture by name, which exists to stop callers holding an index.
 *
 * The contract worth protecting is not that a lookup works — it is that a *failed* lookup
 * is loud. An index that has gone stale still resolves, to the wrong surface, with nothing
 * raised anywhere; that is the failure being replaced, and a name that quietly returned
 * nothing would reintroduce it in a new spelling.
 */

const texture = (name: string): DrftTexture => ({
  name,
  codec: CODEC_RAW,
  width: 1,
  height: 1,
  bytes: new Uint8Array([255, 255, 255, 255]),
});

const setOf = (...names: string[]): TextureSet<string> =>
  TextureSet.from(names.map(texture), (t) => `gpu:${t.name}`);

test('a texture answers to its declared path and to its bare filename', () => {
  const set = setOf('textures\\Tire_05_DM.jpg', 'maps/brick.png');
  /* The spelling the file used. */
  expect(set.get('textures\\Tire_05_DM.jpg')).toBe('gpu:textures\\Tire_05_DM.jpg');
  /* And the one a person would actually type, which is the point. */
  expect(set.get('Tire_05_DM.jpg')).toBe('gpu:textures\\Tire_05_DM.jpg');
  expect(set.get('brick.png')).toBe('gpu:maps/brick.png');
  expect(set.has('nothing.png')).toBe(false);
});

test('an unknown name throws at the call and says what the asset has', () => {
  const set = setOf('body.png');
  /* Loud, and informative: the message has to make the right name obvious. */
  expect(() => set.get('boddy.png')).toThrow(/no texture called "boddy.png"/);
  expect(() => set.get('boddy.png')).toThrow(/body\.png/);
});

test('an image that could not be decoded keeps the others addressable', () => {
  /*
   * The middle texture fails. Everything after it must still resolve, which is exactly what
   * dropping the entry and renumbering would break.
   */
  const set = TextureSet.from(
    [texture('first.png'), texture('broken.png'), texture('last.png')],
    (t) => (t.name === 'broken.png' ? null : `gpu:${t.name}`),
  );
  expect(set.size).toBe(2);
  expect(set.get('last.png')).toBe('gpu:last.png');
  expect(() => set.get('broken.png')).toThrow();
});

test('a nameless texture is still reachable by the index its material carries', () => {
  /* A file written before names existed reads them as empty, and must still draw. */
  const set = setOf('', '');
  expect(set.size).toBe(2);
  expect(set.at(1)).toBe('gpu:');
  expect(set.at(-1)).toBeNull();
  expect(set.at(9)).toBeNull();
});

test('a failed decode leaves a gap rather than shifting the ones after it', () => {
  /*
   * The ordinal hazard reappearing inside the class that exists to remove it, which is
   * exactly where nobody would look for it. A material stores the index its *file* gave the
   * map, so packing the successes together hands it whichever texture moved up into that
   * slot: the model still draws, wearing its neighbour's image.
   */
  const set = TextureSet.from([texture('a.png'), texture('broken.png'), texture('c.png')], (t) =>
    t.name === 'broken.png' ? null : `gpu:${t.name}`,
  );
  expect(set.at(0)).toBe('gpu:a.png');
  expect(set.at(1)).toBeNull();
  /* The one that matters: c.png is still index 2, not index 1. */
  expect(set.at(2)).toBe('gpu:c.png');
  expect(set.all()).toEqual(['gpu:a.png', 'gpu:c.png']);
});

/** A material naming the four images it may name. */
function material(albedo: number, normalMap = -1, ormMap = -1, emissiveMap = -1) {
  return { albedo, normalMap, ormMap, emissiveMap };
}

/*
 * **A colour map and a data map need opposite treatment**, and every texture used to be created
 * `linear` — right for a normal or ORM map by accident, and wrong for a base colour, which glTF
 * specifies as sRGB-encoded. An undecoded colour map hands display values to the shader as though
 * they were light, and it stays invisible until an output transform washes the surface out.
 */
test('a colour map is sRGB and a data map is linear', () => {
  const spaces = textureColorSpaces([material(0, 1, 2, 3)], 4);
  expect(spaces[0], 'base colour').toBe('srgb');
  expect(spaces[1], 'normal map').toBe('linear');
  expect(spaces[2], 'ORM map').toBe('linear');
  expect(spaces[3], 'emissive map').toBe('srgb');
});

test('an image nothing names falls to linear', () => {
  expect(textureColorSpaces([material(0)], 3)).toEqual(['srgb', 'linear', 'linear']);
});

/*
 * Of the two ways to be wrong about an image nobody meant to write, this is the milder: an
 * sRGB-decoded ORM map bends roughness and metallic toward zero and turns the whole surface to
 * polished chrome, where an undecoded colour map is merely pale.
 */
test('an image named as both resolves to linear', () => {
  const spaces = textureColorSpaces([material(0), material(-1, -1, 0)], 1);
  expect(spaces[0]).toBe('linear');
});

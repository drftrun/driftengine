import { describe, expect, it } from 'vitest';

import {
  SKIN_MEAN_EXIT,
  anisotropicModel,
  eyeAxisInWorld,
  eyeModel,
  hairModel,
  packModel,
  skinModel,
  skinProfileDistance,
} from './surfaceModel.ts';

const packed = (...args: Parameters<typeof packModel>): number[] => {
  packModel(...args);
  return Array.from(args[2], (v) => Math.round(v * 1e6) / 1e6);
};

/*
 * **Each model in the two vectors the lit stage reads**, laid out as `packModel` says and the
 * shader's models read them, with the map's presence last. A rotation of a quarter turn is its
 * cosine and sine, 0 and 1, so the shader takes no trigonometry per pixel.
 */
describe('packModel', () => {
  it('PACKS EACH MODEL WHERE THE LIT STAGE READS IT, THE MAP LAST', () => {
    const out = new Float32Array(8);
    expect(packed(null, true, out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(packed(anisotropicModel({ strength: 0.5, rotation: Math.PI / 2 }), false, out)).toEqual([
      0.5, 0, 1, 0, 0, 0, 0, 0,
    ]);
    expect(packed(hairModel({ shift: -0.05, scatter: 0.25, backlit: 2 }), true, out)).toEqual([
      -0.05, 0.25, 2, 0, 0, 0, 0, 1,
    ]);
    expect(
      packed(
        skinModel({
          scatterColor: [0.5, 0.25, 0.125],
          radius: 0.01,
          transmission: 0.75,
          profile: 3,
        }),
        true,
        out,
      ),
    ).toEqual([0.5, 0.25, 0.125, 0.004, 0.75, 3, 0, 1]);
    expect(
      packed(
        eyeModel({
          irisRadius: 0.2,
          irisDepth: 0.004,
          ior: 1.4,
          corneaRoughness: 0.05,
          axis: [0, 2, 0],
        }),
        false,
        out,
      ),
    ).toEqual([0.2, 0.004, 1.4, 0.05, 0, 1, 0, 0]);
  });

  /*
   * **A physical highlight rides the lane the models that read it leave free**: the standard
   * model's, the anisotropic one's and a lightmap's sixth float. Skin, hair and the eye shade their
   * own and never take it, and the eye's axis is in that lane.
   */
  it('PUTS A PHYSICAL HIGHLIGHT IN THE SIXTH FLOAT, AND ONLY WHERE A MODEL READS IT', () => {
    const out = new Float32Array(8);
    expect(packed(null, false, out, true)).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    expect(packed(anisotropicModel({ strength: 0.5 }), true, out, true)).toEqual([
      0.5, 1, 0, 0, 0, 0, 1, 1,
    ]);
    expect(packed(hairModel(), false, out, true)[6]).toBe(0);
    expect(packed(skinModel(), false, out, true)[6]).toBe(0);
    expect(packed(null, false, out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses a number out of its range by name, and freezes what it makes', () => {
    expect(() => anisotropicModel({ strength: 1.5 })).toThrow(/anisotropicModel: strength/);
    expect(() => skinModel({ profile: 8 })).toThrow(/skinModel: profile/);
    expect(() => skinModel({ profile: 1.5 })).toThrow(/whole number/);
    expect(() => eyeModel({ axis: [0, 0, 0] })).toThrow(/eyeModel: axis/);
    expect(() => eyeModel({ joint: -2 })).toThrow(/eyeModel: joint/);
    expect(Object.isFrozen(hairModel())).toBe(true);
  });
});

/*
 * **An eye's axis follows its joint and its draw.** An eye looking along +Z on joint 1, whose
 * palette entry turns a quarter about Y (+Z to +X), drawn by a model turned a quarter about Z (+X
 * to +Y): it looks along +Y. Joint 0 is left identity, so reading the wrong entry looks along +Z
 * turned about Z, which stays +Z. Without a palette, only the draw turns it.
 */
it("TURNS AN EYE'S AXIS BY ITS JOINT AND THEN ITS DRAW", () => {
  const quarterY = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const palette = new Float32Array([...identity, ...quarterY]);
  palette[16 + 12] = 5; // a joint's translation does not turn a direction
  const quarterZ = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 9, 9, 9, 1];
  const out = new Float32Array(3);
  eyeAxisInWorld(eyeModel({ joint: 1 }), quarterZ, palette, out, 0);
  expect(Array.from(out, (v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0]);
  eyeAxisInWorld(eyeModel({ joint: 1 }), quarterZ, null, out, 0);
  expect(Array.from(out, (v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1]);
  eyeAxisInWorld(eyeModel({ axis: [1, 0, 0] }), quarterZ, palette, out, 0);
  expect(Array.from(out, (v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0]);
  /* A palette carries its joint's scale; the axis is a direction, so it comes back unit length. */
  for (let k = 0; k < 11; k++) palette[16 + k] = (palette[16 + k] as number) * 2;
  eyeAxisInWorld(eyeModel({ joint: 1 }), quarterZ, palette, out, 0);
  expect(Array.from(out, (v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0]);
});

/*
 * **A skin's `radius` is how far its light travels, and Burley's profile carries it two and a half
 * of its own distances on average**, so the profile both paths scatter by is at `radius / 2.5`.
 * The 2.5 is held to the profile itself rather than to the code: its radial density
 * `(e^(−r/d) + e^(−r/3d)) / 4d`, integrated by hand, has the mean `(d² + 9d²) / 4d`. Summed here
 * numerically at d = 1, out to where nothing is left. Until 4.8.7 the radius was `d`, and light went
 * two and a half times as far as the model said: a face at arm's length blurred over sixty pixels.
 */
it('A SKIN’S LIGHT TRAVELS ITS RADIUS ON AVERAGE, SO THE PROFILE IS AT TWO FIFTHS OF IT', () => {
  let mass = 0;
  let moment = 0;
  const dr = 1e-3;
  for (let r = dr / 2; r < 80; r += dr) {
    const density = (Math.exp(-r) + Math.exp(-r / 3)) / 4;
    mass += density * dr;
    moment += r * density * dr;
  }
  expect(mass).toBeCloseTo(1, 6);
  expect(moment / mass).toBeCloseTo(2.5, 6);
  expect(SKIN_MEAN_EXIT).toBe(2.5);
  /* Red at 0.707 of a 1.2 cm radius: 8.484 mm travelled, a profile at 3.3936 mm. */
  const skin = skinModel({ scatterColor: [0.707, 0.48, 0.36], radius: 0.012 });
  expect(skinProfileDistance(skin, 0)).toBeCloseTo(0.0033936, 9);
});

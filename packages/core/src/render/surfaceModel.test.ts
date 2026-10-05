import { describe, expect, it } from 'vitest';

import {
  anisotropicModel,
  eyeAxisInWorld,
  eyeModel,
  hairModel,
  packModel,
  skinModel,
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
    ).toEqual([0.5, 0.25, 0.125, 0.01, 0.75, 3, 0, 1]);
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

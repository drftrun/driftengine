import { expect, it } from 'vitest';

import { gradeColorInto } from './gradeColor.ts';
import type { Vec3 } from '../math/color.ts';

const out: Vec3 = [0, 0, 0];
const near = (v: number) => expect.closeTo(v, 6);

/*
 * **A CLEAR COLOUR IS GRADED EXACTLY AS A SHADER GRADES A COLOUR**, each code against values worked
 * out by hand from the shader's constants: the sRGB encode, 0.5 to 1.055 · 0.5^(1/2.4) − 0.055 =
 * 0.735357 and 0.002 to 0.002 · 12.92 on the straight segment; ACES at exposure 1 taking a grey of
 * 0.18 to 0.105591 before the encode, 0.358457 after, as `rrtAndOdtFit` between the two matrices
 * gives; ACES at 1.5 keeping a warm colour warm; and the shoulder taking (1.6, 0.4, 0.2) to
 * (0.96, 0.24, 0.12) before the encode. Code 0 is the colour untouched.
 */
it('GRADES A COLOUR AS THE FORWARD SHADERS DO, CODE BY CODE', () => {
  expect(gradeColorInto(0, 1, [0.5, 0.25, 2], out)).toEqual([0.5, 0.25, 2]);
  expect(gradeColorInto(1, 1, [0.5, 0.002, 1], out)).toEqual([
    near(0.735357),
    near(0.02584),
    near(1),
  ]);
  expect(gradeColorInto(2, 1, [0.18, 0.18, 0.18], out)).toEqual([
    near(0.358457),
    near(0.358457),
    near(0.358456),
  ]);
  expect(gradeColorInto(2, 1.5, [0.8, 0.3, 0.1], out)).toEqual([
    near(0.863483),
    near(0.631655),
    near(0.384792),
  ]);
  expect(gradeColorInto(3, 1, [1.6, 0.4, 0.2], out)).toEqual([
    near(0.982207),
    near(0.527113),
    near(0.381092),
  ]);
});

/* Written into the colour it was handed, which is how a renderer grades its clear without a copy. */
it('GRADES IN PLACE', () => {
  const colour: Vec3 = [0.5, 0.5, 0.5];
  expect(gradeColorInto(1, 1, colour, colour)).toBe(colour);
  expect(colour).toEqual([near(0.735357), near(0.735357), near(0.735357)]);
});

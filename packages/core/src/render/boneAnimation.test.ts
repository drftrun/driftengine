import { describe, expect, it } from 'vitest';

import { createMeshInstances } from './instances.ts';
import {
  animateBoneVertex,
  boneFrame,
  boneOf,
  packBoneAnimation,
  packInstanceClocks,
} from './boneAnimation.ts';

const S = Math.SQRT1_2;

/** One bone over two frames: still at the origin, then a quarter turn about y and a metre up. */
function quarterTurn(second = [0, S, 0, S]) {
  return packBoneAnimation({
    bones: 1,
    frames: 2,
    framesPerSecond: 1,
    places: new Float32Array([0, 0, 0, 0, 1, 0]),
    turns: new Float32Array([0, 0, 0, 1, ...second]),
  });
}

describe('bone animation', () => {
  it('PICKS THE TWO FRAMES A MOMENT FALLS BETWEEN, LOOPED, AND HOW FAR', () => {
    const out = { first: -1, second: -1, blend: -1 };
    boneFrame(2.5, 4, out);
    expect(out).toEqual({ first: 2, second: 3, blend: 0.5 });
    boneFrame(3.75, 4, out);
    expect(out, 'the last frame blends into the first').toEqual({
      first: 3,
      second: 0,
      blend: 0.75,
    });
    boneFrame(9, 4, out);
    expect(out, 'past the end, around again').toEqual({ first: 1, second: 2, blend: 0 });
    boneFrame(-0.5, 4, out);
    expect(out, 'before the start, back from the end').toEqual({ first: 3, second: 0, blend: 0.5 });
  });

  it('TURNS A VERTEX ABOUT THE ORIGIN AND THEN PLACES IT, AS ITS BONE DOES', () => {
    const clip = quarterTurn();
    const out = new Float32Array(3);
    animateBoneVertex(clip, 0, [1, 0, 0], 0, 0, 1, out);
    expect(Array.from(out)).toEqual([1, 0, 0]);
    /* A quarter turn about y takes +x to −z, and the place lifts it a metre. */
    animateBoneVertex(clip, 0, [1, 0, 0], 1, 0, 1, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(-1, 6);
    /* Half way: an eighth of a turn and half a metre. */
    animateBoneVertex(clip, 0, [1, 0, 0], 0.5, 0, 1, out);
    expect(out[0]).toBeCloseTo(S, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(-S, 6);
  });

  it('READS EACH INSTANCE’S MOMENT AS THE SCENE’S TIME TIMES ITS RATE, PLUS ITS PHASE', () => {
    const clip = quarterTurn();
    const out = new Float32Array(3);
    /* 0.25 s at twice the speed, from a quarter of a second in: the half-way frame. */
    animateBoneVertex(clip, 0, [1, 0, 0], 0.125, 0.25, 2, out);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  /* A quaternion and its negation are one turn; blending toward the far one turns the long way. */
  it('BLENDS TWO TURNS ALONG THE SHORTER ARC, HOWEVER THE SECOND WAS SIGNED', () => {
    const near = new Float32Array(3);
    const far = new Float32Array(3);
    animateBoneVertex(quarterTurn(), 0, [1, 0, 0], 0.5, 0, 1, near);
    animateBoneVertex(quarterTurn([0, -S, 0, -S]), 0, [1, 0, 0], 0.5, 0, 1, far);
    for (let k = 0; k < 3; k++) expect(far[k]).toBeCloseTo(near[k] as number, 6);
  });

  it('NAMES A VERTEX’S BONE BY ITS SECOND COORDINATES’ U', () => {
    expect(boneOf(5 / 64, 64)).toBe(5);
    expect(boneOf(5 / 64 - 1e-6, 64), 'a hair short still names it').toBe(5);
    expect(boneOf(0, 64)).toBe(0);
  });

  it('REFUSES A CLIP WHOSE NUMBERS ARE NOT ITS SIZE, AND TAKES A ZERO TURN AS NONE', () => {
    expect(() =>
      packBoneAnimation({
        bones: 2,
        frames: 2,
        framesPerSecond: 30,
        places: new Float32Array(9),
        turns: new Float32Array(16),
      }),
    ).toThrow(/12 places/);
    const still = packBoneAnimation({
      bones: 1,
      frames: 1,
      framesPerSecond: 30,
      places: new Float32Array(3),
      turns: new Float32Array(4),
    });
    expect(Array.from(still.turns)).toEqual([0, 0, 0, 1]);
    expect(still.boneScale, 'a bone a unit of u divided by the bones').toBe(1);
  });

  it('GIVES AN INSTANCE WITH NO CLOCK THE CLIP’S OWN SPEED, IN STEP', () => {
    const data = createMeshInstances(3);
    data.count = 3;
    const out = new Float32Array(6).fill(9);
    packInstanceClocks(data, out);
    expect(Array.from(out)).toEqual([0, 1, 0, 1, 0, 1]);
    const timed = { ...data, clocks: new Float32Array([0.5, 2, 1, 0.5]) };
    packInstanceClocks(timed, out);
    expect(Array.from(out)).toEqual([0.5, 2, 1, 0.5, 0, 1]);
  });
});

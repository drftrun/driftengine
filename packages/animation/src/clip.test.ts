import { describe, expect, it, vi } from 'vitest';

import type { AnimationClip } from './clip.ts';
import { sampleClip } from './clip.ts';
import { createPose } from './pose.ts';

/** One joint, sliding from x=0 to x=4 over one second. Hand-written, not generated. */
function slideClip(): AnimationClip {
  return {
    name: 'slide',
    durationSec: 1,
    tracks: [
      {
        joint: 0,
        path: 'translation',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 4, 0, 0]),
      },
    ],
  };
}

/** One joint, rotating a half turn about Y over one second. */
function halfTurnClip(): AnimationClip {
  return {
    name: 'halfTurn',
    durationSec: 1,
    tracks: [
      {
        joint: 0,
        path: 'rotation',
        /* identity, then 180 degrees about Y: (0, 1, 0, 0) */
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]),
      },
    ],
  };
}

describe('sampling a clip', () => {
  /*
   * The assertion the whole engine's replay story rests on. Animation is the subsystem where every
   * other engine reaches for a clock, and a clock here would mean a recorded run plays back a
   * different pose on a different machine.
   */
  it('is a pure function of time and reads no clock', () => {
    const now = vi.spyOn(performance, 'now');
    const random = vi.spyOn(Math, 'random');
    const a = createPose(1);
    const b = createPose(1);
    sampleClip(slideClip(), 0.37, a);
    sampleClip(slideClip(), 0.37, b);
    expect(Array.from(a.translation)).toEqual(Array.from(b.translation));
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });

  /* Hand-derived: linear from 0 to 4 over one second, so a quarter of the way is exactly 1. */
  it('interpolates translation linearly between keys', () => {
    const out = createPose(1);
    sampleClip(slideClip(), 0.25, out);
    expect(out.translation[0]).toBeCloseTo(1, 6);
  });

  it('wraps past the end rather than clamping', () => {
    const at = createPose(1);
    const wrapped = createPose(1);
    sampleClip(slideClip(), 0.25, at);
    sampleClip(slideClip(), 1.25, wrapped);
    expect(Array.from(wrapped.translation)).toEqual(Array.from(at.translation));
  });

  /* `%` would answer -0.75 here and read the wrong pair of keys. A negative time is what a
     transition running backwards hands in, so it is not hypothetical. */
  it('wraps a negative time forwards', () => {
    const at = createPose(1);
    const negative = createPose(1);
    sampleClip(slideClip(), 0.25, at);
    sampleClip(slideClip(), -0.75, negative);
    expect(Array.from(negative.translation)).toEqual(Array.from(at.translation));
  });

  /* Halfway through a half turn about Y is a quarter turn: (0, sin 45deg, 0, cos 45deg). */
  it('interpolates rotation between keys', () => {
    const out = createPose(1);
    sampleClip(halfTurnClip(), 0.5, out);
    expect(out.rotation[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(out.rotation[3]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  /*
   * Quaternions take the short way round or a limb rotates the long way through the body, which is
   * the most recognisable animation defect there is.
   *
   * **The keys have to be on opposite hemispheres for this to test anything**, which the test
   * above is not: identity against a half turn has a dot product of exactly zero, so the flip
   * never fires and the assertion passes with the correction deleted. Found by perturbing it.
   *
   * Here the second key is a quarter turn about Y *negated* — the same orientation, the opposite
   * hemisphere, dot -0.7071. Hand-derived: with the correction the halfway point is an eighth turn,
   * |w| = cos 22.5deg = 0.92388; without it the interpolation goes the long way round and lands at
   * |w| = cos 67.5deg = 0.38268. The two are far apart, so this cannot pass by accident.
   */
  it('takes the shorter arc when two keys sit on opposite hemispheres', () => {
    const c = Math.SQRT1_2;
    const clip: AnimationClip = {
      name: 'oppositeHemisphere',
      durationSec: 1,
      tracks: [
        {
          joint: 0,
          path: 'rotation',
          times: new Float32Array([0, 1]),
          values: new Float32Array([0, 0, 0, 1, 0, -c, 0, -c]),
        },
      ],
    };
    const out = createPose(1);
    sampleClip(clip, 0.5, out);
    expect(Math.abs(out.rotation[3] as number)).toBeCloseTo(0.92388, 4);
  });

  /*
   * A joint no track mentions keeps whatever the caller left in `out`, which is what lets a clip
   * animating one arm be layered over a pose holding the rest of the body.
   */
  it('leaves untouched joints alone', () => {
    const out = createPose(2);
    out.translation[3] = 7;
    sampleClip(slideClip(), 0.5, out);
    expect(out.translation[3]).toBe(7);
  });

  /* A single-key track is a constant, and it must not divide by a zero key interval. */
  it('holds a single-key track at its one value', () => {
    const held: AnimationClip = {
      name: 'held',
      durationSec: 1,
      tracks: [
        {
          joint: 0,
          path: 'translation',
          times: new Float32Array([0]),
          values: new Float32Array([3, 0, 0]),
        },
      ],
    };
    const out = createPose(1);
    sampleClip(held, 0.6, out);
    expect(out.translation[0]).toBe(3);
  });

  /* Before the first key and after the last, a track holds rather than extrapolating. */
  it('holds at the ends rather than running past them', () => {
    const late: AnimationClip = {
      name: 'late',
      durationSec: 4,
      tracks: [
        {
          joint: 0,
          path: 'translation',
          times: new Float32Array([1, 2]),
          values: new Float32Array([10, 0, 0, 20, 0, 0]),
        },
      ],
    };
    const before = createPose(1);
    const after = createPose(1);
    sampleClip(late, 0, before);
    sampleClip(late, 3.5, after);
    expect(before.translation[0]).toBe(10);
    expect(after.translation[0]).toBe(20);
  });
});

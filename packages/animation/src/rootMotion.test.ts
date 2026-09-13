import { describe, expect, it, vi } from 'vitest';

import type { AnimationClip } from './clip.ts';
import { sampleClip } from './clip.ts';
import { createPose } from './pose.ts';
import { createRootMotion, extractRootMotion, stripRootMotion } from './rootMotion.ts';

/** One joint sliding from x=0 to x=4 over one second. Hand-written, not generated. */
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

/** One joint turning a half turn about Y over one second, standing still. */
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

/**
 * One joint facing 90 degrees about Y for the whole clip, sliding from x=0 to x=4.
 *
 * The clip that separates "the delta in the clip's space" from "the delta in the root's own
 * frame", which is the convention this module has to commit to and which nothing else here can
 * tell apart: both answers have the same magnitude and point along different axes.
 */
function turnedSlideClip(): AnimationClip {
  const c = Math.SQRT1_2;
  return {
    name: 'turnedSlide',
    durationSec: 1,
    tracks: [
      {
        joint: 0,
        path: 'translation',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 4, 0, 0]),
      },
      {
        joint: 0,
        path: 'rotation',
        times: new Float32Array([0]),
        values: new Float32Array([0, c, 0, c]),
      },
    ],
  };
}

describe('extracting root motion', () => {
  /*
   * The assertion the replay story rests on, in the same form `clip.test.ts` makes it. A clock
   * here would mean a recorded run moves a character a different distance on a different machine.
   */
  it('is a pure function of the clip and two times, and reads no clock', () => {
    const now = vi.spyOn(performance, 'now');
    const random = vi.spyOn(Math, 'random');
    const a = createRootMotion();
    const b = createRootMotion();
    extractRootMotion(slideClip(), 0, 0.13, 0.41, a);
    extractRootMotion(slideClip(), 0, 0.13, 0.41, b);
    expect(Array.from(a.translation)).toEqual(Array.from(b.translation));
    expect(Array.from(a.rotation)).toEqual(Array.from(b.rotation));
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });

  /* Linear from 0 to 4 over a second: a quarter is 1 and a half is 2, so the interval is 1. */
  it('answers the translation between two times inside the clip', () => {
    const out = createRootMotion();
    extractRootMotion(slideClip(), 0, 0.25, 0.5, out);
    expect(out.translation[0]).toBeCloseTo(1, 6);
    expect(out.translation[1]).toBeCloseTo(0, 6);
    expect(out.translation[2]).toBeCloseTo(0, 6);
    expect(Array.from(out.rotation)).toEqual([0, 0, 0, 1]);
  });

  /*
   * **The test that separates root motion from subtracting two samples.** Across the loop the
   * root snaps from x=4 back to x=0, so `sampleClip(1.25) - sampleClip(0.75)` is -2 and the
   * character walks backwards once a cycle. The distance actually travelled is 1 to the end of
   * the cycle plus 1 into the next: +2.
   */
  it('accumulates across a loop rather than subtracting two samples', () => {
    const out = createRootMotion();
    extractRootMotion(slideClip(), 0, 0.75, 1.25, out);
    expect(out.translation[0]).toBeCloseTo(2, 5);
  });

  it('answers a negative interval inside the clip', () => {
    const out = createRootMotion();
    extractRootMotion(slideClip(), 0, 0.5, 0.25, out);
    expect(out.translation[0]).toBeCloseTo(-1, 6);
  });

  /* The mirror of the loop case: 0.25 back to 0 is -1, and 1 back to 0.75 is another -1. */
  it('accumulates backwards across a loop', () => {
    const out = createRootMotion();
    extractRootMotion(slideClip(), 0, 0.25, -0.25, out);
    expect(out.translation[0]).toBeCloseTo(-2, 5);
  });

  /* Two whole cycles of a 4-unit stride. Hand-derived: 4 + 4, with nothing left over. */
  it('counts whole cycles', () => {
    const out = createRootMotion();
    extractRootMotion(slideClip(), 0, 0, 2, out);
    expect(out.translation[0]).toBeCloseTo(8, 4);
  });

  /*
   * Additivity is the contract that makes this usable per frame: a caller stepping the clip in
   * sixtieths and applying each delta must arrive where a single query over the whole span says.
   */
  it('composes over adjacent intervals', () => {
    const first = createRootMotion();
    const second = createRootMotion();
    const whole = createRootMotion();
    extractRootMotion(slideClip(), 0, 0.1, 0.4, first);
    extractRootMotion(slideClip(), 0, 0.4, 0.7, second);
    extractRootMotion(slideClip(), 0, 0.1, 0.7, whole);
    expect((first.translation[0] as number) + (second.translation[0] as number)).toBeCloseTo(
      whole.translation[0] as number,
      5,
    );
  });

  /* Half of a half turn about Y is a quarter turn: (0, sin 45deg, 0, cos 45deg). */
  it('answers the rotation between two times', () => {
    const out = createRootMotion();
    extractRootMotion(halfTurnClip(), 0, 0, 0.5, out);
    expect(out.rotation[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(out.rotation[3]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(out.translation[0]).toBeCloseTo(0, 6);
  });

  /*
   * **The delta is in the root's own frame at the earlier time, not in the clip's space.**
   *
   * Hand-derived: the root faces +90 degrees about Y for the whole clip and slides +2 along the
   * clip's x between t=0 and t=0.5. Rotating (2, 0, 0) by -90 degrees about Y gives (0, 0, 2), so
   * a caller applying `position += worldRotation * delta` moves the character along its own
   * forward axis. The rejected convention would answer (2, 0, 0) and drag every turned character
   * sideways.
   */
  it('answers the translation in the root frame at the earlier time', () => {
    const out = createRootMotion();
    extractRootMotion(turnedSlideClip(), 0, 0, 0.5, out);
    expect(out.translation[0]).toBeCloseTo(0, 5);
    expect(out.translation[1]).toBeCloseTo(0, 5);
    expect(out.translation[2]).toBeCloseTo(2, 5);
    /* The facing never changes, so the rotation delta is identity however far it slid. */
    expect(Math.abs(out.rotation[3] as number)).toBeCloseTo(1, 5);
  });

  /* A root nothing animates is a character that does not move, not a NaN. */
  it('answers identity for a root no track mentions', () => {
    const out = createRootMotion();
    extractRootMotion(slideClip(), 3, 0.2, 0.9, out);
    expect(Array.from(out.translation)).toEqual([0, 0, 0]);
    expect(Array.from(out.rotation)).toEqual([0, 0, 0, 1]);
  });

  /* A zero duration wraps every time to the same instant, so nothing moves. */
  it('answers identity for a clip with no duration', () => {
    const still: AnimationClip = { ...slideClip(), durationSec: 0 };
    const out = createRootMotion();
    extractRootMotion(still, 0, 0, 5, out);
    expect(Array.from(out.translation)).toEqual([0, 0, 0]);
  });

  /* The target is the caller's, written in place: a second call replaces rather than accumulates. */
  it('overwrites the target rather than accumulating into it', () => {
    const out = createRootMotion();
    const target = out.translation;
    extractRootMotion(slideClip(), 0, 0, 0.5, out);
    extractRootMotion(slideClip(), 0, 0, 0.5, out);
    expect(out.translation).toBe(target);
    expect(out.translation[0]).toBeCloseTo(2, 5);
  });
});

describe('stripping root motion from a pose', () => {
  /*
   * The other half of the capability: the caller moves the character with the delta, so the pose
   * has to leave the root where the clip authored it or the motion is applied twice.
   */
  it('pins the root to the clip value at time zero', () => {
    const pose = createPose(1);
    sampleClip(slideClip(), 0.5, pose);
    expect(pose.translation[0]).toBeCloseTo(2, 6);
    stripRootMotion(slideClip(), 0, pose);
    expect(pose.translation[0]).toBeCloseTo(0, 6);
  });

  it('pins the root rotation too', () => {
    const pose = createPose(1);
    sampleClip(halfTurnClip(), 0.5, pose);
    expect(pose.rotation[1]).toBeCloseTo(Math.SQRT1_2, 5);
    stripRootMotion(halfTurnClip(), 0, pose);
    expect(pose.rotation[1]).toBeCloseTo(0, 5);
    expect(pose.rotation[3]).toBeCloseTo(1, 5);
  });

  /* Everything below the root is placed by its parent and must be left exactly as sampled. */
  it('leaves every other joint alone', () => {
    const pose = createPose(2);
    pose.translation[3] = 7;
    pose.rotation[4] = 0.5;
    stripRootMotion(slideClip(), 0, pose);
    expect(pose.translation[3]).toBe(7);
    expect(pose.rotation[4]).toBe(0.5);
  });
});

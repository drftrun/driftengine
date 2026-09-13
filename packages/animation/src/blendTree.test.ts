import { describe, expect, it, vi } from 'vitest';

import type { AnimationClip } from './clip.ts';
import { BlendTree } from './blendTree.ts';
import { createPose } from './pose.ts';

/** A clip holding joint 0 at a constant x. Hand-written. */
function held(x: number): AnimationClip {
  return {
    name: `held${x}`,
    durationSec: 1,
    tracks: [
      {
        joint: 0,
        path: 'translation',
        times: new Float32Array([0]),
        values: new Float32Array([x, 0, 0]),
      },
    ],
  };
}

describe('a blend tree', () => {
  /* Hand-derived: a quarter of the way from 0 to 10 is 2.5. */
  it('lerps between two clips on a named parameter', () => {
    const tree = new BlendTree(
      {
        kind: 'lerp',
        a: { kind: 'clip', clip: held(0) },
        b: { kind: 'clip', clip: held(10) },
        parameter: 'speed',
      },
      1,
    );
    const out = createPose(1);
    tree.set('speed', 0.25);
    tree.evaluate(0, out);
    expect(out.translation[0]).toBeCloseTo(2.5, 6);
  });

  /* Between the second and third stop of a one-dimensional set, and nowhere near the first. */
  it('picks the bracketing pair of a one-dimensional set', () => {
    const tree = new BlendTree(
      {
        kind: 'oneDimensional',
        parameter: 'speed',
        children: [
          { at: 0, node: { kind: 'clip', clip: held(0) } },
          { at: 1, node: { kind: 'clip', clip: held(10) } },
          { at: 2, node: { kind: 'clip', clip: held(30) } },
        ],
      },
      1,
    );
    const out = createPose(1);
    tree.set('speed', 1.5);
    tree.evaluate(0, out);
    expect(out.translation[0]).toBeCloseTo(20, 6);
  });

  /*
   * Clamped, wherever the clamping happens. The early returns in `walk` are a shortcut that skips
   * a child; the guarantee is `blendPoses`, which clamps its own weight — so this asserts the
   * behaviour rather than the mechanism, and stays true if the shortcut is ever removed.
   */
  it('clamps outside the set rather than extrapolating', () => {
    const tree = new BlendTree(
      {
        kind: 'oneDimensional',
        parameter: 'speed',
        children: [
          { at: 0, node: { kind: 'clip', clip: held(0) } },
          { at: 1, node: { kind: 'clip', clip: held(10) } },
        ],
      },
      1,
    );
    const out = createPose(1);
    tree.set('speed', 9);
    tree.evaluate(0, out);
    expect(out.translation[0]).toBeCloseTo(10, 6);
  });

  /*
   * A typo in a parameter name silently does nothing otherwise, and presents as an animation that
   * will not respond — which is a long way from the name that caused it. So it throws, naming it.
   */
  it('refuses an unknown parameter by name at set', () => {
    const tree = new BlendTree({ kind: 'clip', clip: held(0) }, 1);
    expect(() => tree.set('nonesuch', 1)).toThrow(/nonesuch/);
  });

  it('accepts a parameter any node in the tree declares', () => {
    const tree = new BlendTree(
      {
        kind: 'lerp',
        parameter: 'speed',
        a: { kind: 'clip', clip: held(0) },
        b: {
          kind: 'oneDimensional',
          parameter: 'turn',
          children: [{ at: 0, node: { kind: 'clip', clip: held(1) } }],
        },
      },
      1,
    );
    expect(() => tree.set('turn', 0.5)).not.toThrow();
  });

  it('refuses a one-dimensional set whose stops are not ascending', () => {
    expect(
      () =>
        new BlendTree(
          {
            kind: 'oneDimensional',
            parameter: 'speed',
            children: [
              { at: 1, node: { kind: 'clip', clip: held(0) } },
              { at: 0, node: { kind: 'clip', clip: held(10) } },
            ],
          },
          1,
        ),
    ).toThrow(/ascending/i);
  });

  it('refuses an empty one-dimensional set rather than answering nothing', () => {
    expect(
      () => new BlendTree({ kind: 'oneDimensional', parameter: 'speed', children: [] }, 1),
    ).toThrow(/at least one/i);
  });

  /* The determinism contract, carried up from sampling into the graph over it. */
  it('reads no clock', () => {
    const now = vi.spyOn(performance, 'now');
    const tree = new BlendTree({ kind: 'clip', clip: held(3) }, 1);
    tree.evaluate(0.5, createPose(1));
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  /* Evaluated twice with the same inputs, the same pose — which is what a replay needs. */
  it('is a pure function of its time and its parameters', () => {
    const tree = new BlendTree(
      {
        kind: 'lerp',
        a: { kind: 'clip', clip: held(0) },
        b: { kind: 'clip', clip: held(10) },
        parameter: 'speed',
      },
      1,
    );
    const first = createPose(1);
    const second = createPose(1);
    tree.set('speed', 0.3);
    tree.evaluate(0.4, first);
    tree.evaluate(0.4, second);
    expect(Array.from(first.translation)).toEqual(Array.from(second.translation));
  });
});

/**
 * A rotation-only clip through a tree keeps the bind pose's translations.
 *
 * **The sharp edge this exists to blunt.** `sampleClip` leaves a channel no track mentions exactly
 * as it found it, so a rotation-only clip — which is most of them — preserves whatever the pose
 * held. `blendPoses` cannot: it interpolates every channel of two poses. So a tree whose scratch
 * poses start at zero translation collapses every joint onto its parent's origin the moment it
 * blends anything, and the failure is a figure folded in on itself rather than an error.
 *
 * Found by building `demo/character.ts` on it and looking at the result.
 */
describe('a tree given a bind pose', () => {
  const bind = () => {
    const pose = createPose(1);
    pose.translation[1] = 1.6;
    return pose;
  };

  /** A clip that drives rotation and says nothing about translation, like most clips. */
  const turn: AnimationClip = {
    name: 'turn',
    durationSec: 1,
    tracks: [
      {
        joint: 0,
        path: 'rotation',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]),
      },
    ],
  };

  it('keeps the bind translation through a blend', () => {
    const tree = new BlendTree(
      {
        kind: 'lerp',
        a: { kind: 'clip', clip: turn },
        b: { kind: 'clip', clip: turn },
        parameter: 'w',
      },
      1,
      bind(),
    );
    const out = createPose(1);
    tree.set('w', 0.5);
    tree.evaluate(0.25, out);
    expect(out.translation[1]).toBeCloseTo(1.6, 6);
  });

  /* Without one, the same tree zeroes it — which is the behaviour the parameter exists to fix. */
  it('zeroes it without one, which is what the bind pose is for', () => {
    const tree = new BlendTree(
      {
        kind: 'lerp',
        a: { kind: 'clip', clip: turn },
        b: { kind: 'clip', clip: turn },
        parameter: 'w',
      },
      1,
    );
    const out = createPose(1);
    out.translation[1] = 1.6;
    tree.set('w', 0.5);
    tree.evaluate(0.25, out);
    expect(out.translation[1]).toBe(0);
  });
});

/**
 * **Reported from outside 2026-08-28.** A tree walked every node with one `timeSec`, so a set whose
 * members must be sampled on *different* clocks could not be written as one tree — and that is the
 * canonical locomotion blend space rather than an exotic case. A stride advances with **distance
 * travelled** or the foot slides while the body passes over it, which is the fact `rootMotion`
 * exists for; an idle advances with **time**, because somebody standing still is still breathing.
 * In one tree on one clock, one of the two is wrong: share the distance and the idle freezes when
 * nobody moves, share the time and the walk skates.
 *
 * A moving clip stands in for a stride here: sampling it at 0.5 gives 5 and at 0 gives 0, so a test
 * can read which clock reached it.
 */
describe('a clip sampled on a clock of its own', () => {
  /** A clip whose joint 0 travels from 0 to 10 over its second. Hand-written. */
  const travelling = (): AnimationClip => ({
    name: 'travelling',
    durationSec: 1,
    tracks: [
      {
        joint: 0,
        path: 'translation',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 10, 0, 0]),
      },
    ],
  });

  it('reads the named parameter instead of the frame clock', () => {
    const tree = new BlendTree({ kind: 'clip', clip: travelling(), clock: 'stride' }, 1);
    const out = createPose(1);
    tree.set('stride', 0.25);
    /* The frame clock says 0.75 and the stride says 0.25; the stride is what must arrive. */
    tree.evaluate(0.75, out);
    expect(out.translation[0]).toBeCloseTo(2.5, 6);
  });

  it('and a clip with no clock still takes the frame clock', () => {
    const tree = new BlendTree({ kind: 'clip', clip: travelling() }, 1);
    const out = createPose(1);
    tree.evaluate(0.75, out);
    expect(out.translation[0]).toBeCloseTo(7.5, 6);
  });

  /**
   * The whole point, in one tree: an idle on the frame clock and a gait on a distance clock, under
   * one `oneDimensional` over speed. Neither clock reaches the other's clip.
   */
  it('lets one set hold a time-clocked idle and a distance-clocked gait', () => {
    const tree = new BlendTree(
      {
        kind: 'oneDimensional',
        parameter: 'speed',
        children: [
          { at: 0, node: { kind: 'clip', clip: travelling() } },
          { at: 1, node: { kind: 'clip', clip: travelling(), clock: 'stride' } },
        ],
      },
      1,
    );
    const out = createPose(1);
    tree.set('stride', 0.2);
    tree.set('speed', 0);
    /* Parked at the idle end: the frame clock decides, so 0.9 of the clip is 9. */
    tree.evaluate(0.9, out);
    expect(out.translation[0]).toBeCloseTo(9, 6);

    tree.set('speed', 1);
    /* Parked at the gait end: the stride decides, and the frame clock is ignored. */
    tree.evaluate(0.9, out);
    expect(out.translation[0]).toBeCloseTo(2, 6);

    tree.set('speed', 0.5);
    /* Halfway between the two, which is the case a hand-rolled `blendPoses` was written for:
       half of 9 and half of 2 is 5.5, and each half came off its own clock. */
    tree.evaluate(0.9, out);
    expect(out.translation[0]).toBeCloseTo(5.5, 6);
  });

  it('takes the clock by name, and refuses a misspelling of it', () => {
    const tree = new BlendTree({ kind: 'clip', clip: travelling(), clock: 'stride' }, 1);
    expect(() => tree.set('stride', 1)).not.toThrow();
    expect(() => tree.set('strides', 1)).toThrow(/no node in this tree takes a parameter/);
  });

  /**
   * A name cannot be a blend input and a clock at once. It is a plausible slip — writing
   * `clock: 'speed'` while meaning "the speed drives the blend" — and one number doing both jobs
   * produces a rig that responds to the wrong dial rather than an error.
   */
  it('refuses a name used as both a blend parameter and a clock', () => {
    expect(
      () =>
        new BlendTree(
          {
            kind: 'lerp',
            parameter: 'speed',
            a: { kind: 'clip', clip: travelling(), clock: 'speed' },
            b: { kind: 'clip', clip: travelling() },
          },
          1,
        ),
    ).toThrow(/"speed"/);
  });

  /* The same collision the other way round, which a depth-first walk meets in the other order:
     a clock declared in one subtree and a blend parameter of that name in its sibling. */
  it('refuses the collision whichever side declares the name first', () => {
    expect(
      () =>
        new BlendTree(
          {
            kind: 'lerp',
            parameter: 'blend',
            a: { kind: 'clip', clip: travelling(), clock: 'stride' },
            b: {
              kind: 'oneDimensional',
              parameter: 'stride',
              children: [{ at: 0, node: { kind: 'clip', clip: travelling() } }],
            },
          },
          1,
        ),
    ).toThrow(/"stride"/);
  });

  it('starts a clock at zero, so a tree evaluates before anything is set', () => {
    const tree = new BlendTree({ kind: 'clip', clip: travelling(), clock: 'stride' }, 1);
    const out = createPose(1);
    tree.evaluate(5, out);
    expect(out.translation[0]).toBeCloseTo(0, 6);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { AnimationStateMachine } from './stateMachine.ts';
import { BlendTree } from './blendTree.ts';
import type { AnimationClip } from './clip.ts';
import { createPose } from './pose.ts';

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

function machine(durationSec: number) {
  return new AnimationStateMachine(
    [
      { name: 'idle', tree: new BlendTree({ kind: 'clip', clip: held(0) }, 1) },
      { name: 'run', tree: new BlendTree({ kind: 'clip', clip: held(10) }, 1) },
    ],
    [{ from: 'idle', to: 'run', durationSec, when: (p) => (p['speed'] ?? 0) > 0.5 }],
    1,
  );
}

describe('an animation state machine', () => {
  it('starts in the first state it was given', () => {
    expect(machine(0.2).current).toBe('idle');
  });

  it('stays put until its condition is met', () => {
    const m = machine(0.2);
    m.advance(1);
    expect(m.current).toBe('idle');
  });

  /*
   * A transition is crossfaded, not switched. Dropping one state and enabling the other in a
   * single frame is a visible on/off bug — the same thing AGENTS.md says about a light changing
   * ownership, one subsystem over.
   */
  it('crossfades rather than snapping', () => {
    const m = machine(0.2);
    const out = createPose(1);
    m.set('speed', 1);
    m.advance(0.1); /* half way through a 0.2s transition */
    m.evaluate(out);
    expect(out.translation[0]).toBeGreaterThan(0);
    expect(out.translation[0]).toBeLessThan(10);
  });

  it('arrives, and stops blending once it has', () => {
    const m = machine(0.2);
    const out = createPose(1);
    m.set('speed', 1);
    m.advance(0.3);
    m.evaluate(out);
    expect(m.current).toBe('run');
    expect(out.translation[0]).toBeCloseTo(10, 6);
  });

  /* A transition of zero duration is a switch, and must not divide by its own duration. */
  it('survives a zero-duration transition', () => {
    const m = machine(0);
    const out = createPose(1);
    m.set('speed', 1);
    m.advance(0);
    m.evaluate(out);
    expect(Number.isFinite(out.translation[0])).toBe(true);
    expect(m.current).toBe('run');
  });

  /*
   * A condition that goes false mid-transition does not rewind: the fade completes. A transition
   * that could be interrupted by the parameter it was triggered on would stutter whenever that
   * parameter sat on its threshold, which is exactly where a speed parameter spends its time.
   */
  it('completes a transition whose condition stopped holding', () => {
    /*
     * **Both ways round, or this tests nothing.** With only idle→run, a machine that re-evaluated
     * transitions mid-fade would find none out of `run` and behave identically — which is what the
     * first version of this test did, and it passed with the guard deleted. The return transition
     * is what makes a re-entrant check observable: it would fire the moment speed drops, replacing
     * the fade in flight.
     */
    const m = new AnimationStateMachine(
      [
        { name: 'idle', tree: new BlendTree({ kind: 'clip', clip: held(0) }, 1) },
        { name: 'run', tree: new BlendTree({ kind: 'clip', clip: held(10) }, 1) },
      ],
      [
        { from: 'idle', to: 'run', durationSec: 0.2, when: (p) => (p['speed'] ?? 0) > 0.5 },
        { from: 'run', to: 'idle', durationSec: 0.2, when: (p) => (p['speed'] ?? 0) <= 0.5 },
      ],
      1,
    );
    m.set('speed', 1);
    m.advance(0.1);
    m.set('speed', 0);
    /* Still mid-fade: the machine must not turn round here. */
    m.advance(0.05);
    expect(m.current, 'a fade in flight is not re-evaluated').toBe('run');
    /* And once it has arrived, the return transition is free to fire. */
    m.advance(0.1);
    m.advance(0.3);
    expect(m.current).toBe('idle');
  });

  it('refuses a transition naming a state that does not exist', () => {
    expect(
      () =>
        new AnimationStateMachine(
          [{ name: 'idle', tree: new BlendTree({ kind: 'clip', clip: held(0) }, 1) }],
          [{ from: 'idle', to: 'nonesuch', durationSec: 0.2, when: () => true }],
          1,
        ),
    ).toThrow(/nonesuch/);
  });

  it('refuses being built with no states at all', () => {
    expect(() => new AnimationStateMachine([], [], 1)).toThrow(/state/i);
  });

  /* The determinism contract, one level up from sampling and from the tree. */
  it('reads no clock', () => {
    const now = vi.spyOn(performance, 'now');
    const random = vi.spyOn(Math, 'random');
    const m = machine(0.2);
    m.set('speed', 1);
    m.advance(0.1);
    m.evaluate(createPose(1));
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });

  /*
   * A state's own clock advances with the machine, so a looping clip does not restart every time
   * something else changes. Asserted through a clip whose value moves with time.
   */
  it('advances the active state’s own time', () => {
    const sliding: AnimationClip = {
      name: 'slide',
      durationSec: 1,
      tracks: [
        {
          joint: 0,
          path: 'translation',
          times: new Float32Array([0, 1]),
          values: new Float32Array([0, 0, 0, 8, 0, 0]),
        },
      ],
    };
    const m = new AnimationStateMachine(
      [{ name: 'only', tree: new BlendTree({ kind: 'clip', clip: sliding }, 1) }],
      [],
      1,
    );
    const out = createPose(1);
    m.advance(0.25);
    m.evaluate(out);
    expect(out.translation[0]).toBeCloseTo(2, 5);
  });
});

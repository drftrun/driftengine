import { SceneNode } from '@driftengine/core';
import { describe, expect, it, vi } from 'vitest';

import type { AnimationClip } from './clip.ts';
import { RigidAnimation, applyPoseToNode } from './rigid.ts';
import { createPose } from './pose.ts';

/** The translation column of a column-major 4x4, which is how `node.test.ts` reads one. */
const translationOf = (m: Float32Array): number[] => Array.from(m.subarray(12, 15));

/** One joint sliding from x=0 to x=8 over one second. Hand-written. */
function slideClip(): AnimationClip {
  return {
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
}

describe('rigid TRS', () => {
  it('writes a pose joint onto a node', () => {
    const pose = createPose(1);
    pose.translation[0] = 5;
    const node = new SceneNode();
    applyPoseToNode(pose, 0, node);
    node.updateWorld();
    expect(translationOf(node.worldMatrix)).toEqual([5, 0, 0]);
  });

  /* Hand-derived: a quarter of the way from 0 to 8 is exactly 2. */
  it('drives a node from a clip at a caller-supplied time', () => {
    const node = new SceneNode();
    new RigidAnimation(slideClip(), [node]).apply(0.25);
    node.updateWorld();
    expect(translationOf(node.worldMatrix)[0]).toBeCloseTo(2, 6);
  });

  /*
   * The hierarchy is core's and this must not take it back. A node driven by a clip is still
   * placed by its parent, which is what lets a turning wheel sit on a moving cart.
   */
  it('leaves the parent composing the child', () => {
    const cart = new SceneNode();
    const wheel = new SceneNode();
    cart.attachChild(wheel);
    cart.setPosition(10, 0, 0);
    new RigidAnimation(slideClip(), [wheel]).apply(0.25);
    cart.updateWorld();
    expect(translationOf(wheel.worldMatrix)[0]).toBeCloseTo(12, 6);
  });

  /*
   * Writing a node's transform in place does not mark it dirty — `SceneNode` says so at the field
   * — so a driver that forgot `markMoved` would move a node whose world matrix never caught up.
   * The failure is invisible on the first frame, because a fresh node is dirty anyway; it appears
   * on the second, which is why this asserts across two updates.
   */
  it('marks the node moved, so a second frame is not stale', () => {
    const node = new SceneNode();
    const animation = new RigidAnimation(slideClip(), [node]);
    animation.apply(0.25);
    node.updateWorld();
    animation.apply(0.5);
    node.updateWorld();
    expect(translationOf(node.worldMatrix)[0]).toBeCloseTo(4, 6);
  });

  /*
   * A track whose node is null is skipped rather than throwing. An imported clip names joints a
   * scene may not have instantiated, and the correct behaviour is the parts that exist moving —
   * not a frame loop that throws, which the reliability rules forbid outright.
   */
  it('skips a track whose node is absent', () => {
    expect(() => new RigidAnimation(slideClip(), [null]).apply(0.25)).not.toThrow();
  });

  it('reads no clock', () => {
    const now = vi.spyOn(performance, 'now');
    new RigidAnimation(slideClip(), [new SceneNode()]).apply(0.25);
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });
});

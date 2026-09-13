import type { SceneNode } from '@driftengine/core';

import type { AnimationClip } from './clip.ts';
import { sampleClip } from './clip.ts';
import type { Pose } from './pose.ts';
import { createPose } from './pose.ts';

/**
 * Rigid TRS: a clip driving a node's transform, with no skeleton and no palette anywhere.
 *
 * A door swinging, a lift rising, a turntable turning — geometry that moves as a whole rather than
 * deforming. It is the cheapest thing animation offers and the one most games reach for first, and
 * it needs no shader change at all.
 *
 * **This module is the only place this package touches core**, which is what makes the peer
 * dependency load-bearing rather than declared. A node is core's, a pose is this package's, and
 * this is the one line between them — kept in a module of its own so the rest of the package
 * stays a pure function of time over typed arrays and could be tested with core absent.
 */

/**
 * Write one joint of a pose onto a node's local transform. Allocates nothing.
 *
 * `markMoved` is called because `SceneNode` says at its own fields that writing a transform in
 * place does not mark it dirty. Omitting it is invisible on the first frame — a fresh node is
 * dirty already — and shows on the second as a node whose world matrix never catches up, which
 * reads as an animation that plays once and freezes.
 */
export function applyPoseToNode(pose: Pose, joint: number, node: SceneNode): void {
  const t = joint * 3;
  const r = joint * 4;
  node.position[0] = pose.translation[t] as number;
  node.position[1] = pose.translation[t + 1] as number;
  node.position[2] = pose.translation[t + 2] as number;
  node.rotation[0] = pose.rotation[r] as number;
  node.rotation[1] = pose.rotation[r + 1] as number;
  node.rotation[2] = pose.rotation[r + 2] as number;
  node.rotation[3] = pose.rotation[r + 3] as number;
  node.scale[0] = pose.scale[t] as number;
  node.scale[1] = pose.scale[t + 1] as number;
  node.scale[2] = pose.scale[t + 2] as number;
  node.markMoved();
}

/**
 * A clip bound to a list of nodes, one per joint the clip's tracks name.
 *
 * The pose is claimed once at construction and reused, so `apply` allocates nothing however often
 * it runs.
 */
export class RigidAnimation {
  private readonly pose: Pose;

  /**
   * The distinct joints this clip drives, collected once.
   *
   * Iterating `tracks` directly would write a joint's node once per track it has — three times for
   * a joint carrying translation, rotation and scale — which is correct and is three times the
   * work every frame. Collected here because the set cannot change: a clip is immutable.
   */
  private readonly driven: number[] = [];

  /**
   * @param nodes Indexed by joint. `null` for a joint this scene did not instantiate.
   */
  constructor(
    private readonly clip: AnimationClip,
    private readonly nodes: readonly (SceneNode | null)[],
  ) {
    /*
     * Sized to the highest joint the clip names, not to `nodes.length`, so a caller passing a
     * short list still gets a pose the sampler can write every track into — the skipping happens
     * at the node, which is where the caller's intent is, rather than silently at the sample.
     */
    let highest = -1;
    for (const track of clip.tracks) {
      highest = Math.max(highest, track.joint);
      if (!this.driven.includes(track.joint)) this.driven.push(track.joint);
    }
    this.pose = createPose(highest + 1);
  }

  /**
   * Sample at a caller-supplied time and write every bound node. Reads no clock.
   *
   * A joint with no node is skipped rather than refused. An imported clip names joints a scene may
   * not have instantiated, and the right behaviour is the parts that exist moving — the
   * reliability rules forbid throwing in a frame loop outright, and a missing prop is not a reason
   * to stop a scene.
   */
  apply(timeSec: number): void {
    sampleClip(this.clip, timeSec, this.pose);
    for (const joint of this.driven) {
      const node = this.nodes[joint];
      if (node === null || node === undefined) continue;
      applyPoseToNode(this.pose, joint, node);
    }
  }
}

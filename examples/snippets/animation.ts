/**
 * The parts of animation the example's figure does not use: a state machine, a clip played on a
 * second rig, root motion, springs, a clip driving scene nodes, and morph targets.
 *
 * A snippet, typechecked with the examples and quoted by the manual's animation chapter.
 */
import {
  AnimationStateMachine,
  BlendTree,
  RigidAnimation,
  buildRetargetMap,
  createRootMotion,
  extractRootMotion,
  retargetPose,
  sampleClip,
  sampleSpring,
  sampleSpringChain,
  stripRootMotion,
} from '@driftengine/animation';
import type { AnimationClip, Pose, Skeleton, SpringLink } from '@driftengine/animation';
import type { MeshData, MeshHandle, RendererApi, SceneNode } from '@driftengine/core';

// #region machine
/** Ground and air: a locomotion tree, a jump clip, and the fades between them. */
export function locomotion(
  walk: AnimationClip,
  run: AnimationClip,
  jump: AnimationClip,
  jointCount: number,
  bind: Pose,
): { machine: AnimationStateMachine; gait: BlendTree } {
  const gait = new BlendTree(
    {
      kind: 'lerp',
      parameter: 'speed',
      a: { kind: 'clip', clip: walk },
      b: { kind: 'clip', clip: run },
    },
    jointCount,
    bind,
  );
  const air = new BlendTree({ kind: 'clip', clip: jump }, jointCount, bind);
  const machine = new AnimationStateMachine(
    [
      { name: 'ground', tree: gait },
      { name: 'air', tree: air },
    ],
    [
      { from: 'ground', to: 'air', durationSec: 0.1, when: (p) => (p.grounded ?? 1) === 0 },
      { from: 'air', to: 'ground', durationSec: 0.2, when: (p) => (p.grounded ?? 1) === 1 },
    ],
    jointCount,
    bind,
  );
  return { machine, gait };
}

/** Each tick: the machine reads its own parameters, and each tree reads its own. */
export function animateLocomotion(
  rig: { machine: AnimationStateMachine; gait: BlendTree },
  speed: number,
  grounded: boolean,
  dt: number,
  out: Pose,
): void {
  rig.gait.set('speed', Math.min(1, speed / 4));
  rig.machine.set('grounded', grounded ? 1 : 0);
  rig.machine.advance(dt);
  rig.machine.evaluate(out);
}
// #endregion

// #region retarget
/** A clip authored on one rig, worn by another of different proportions. */
export function wear(
  clip: AnimationClip,
  source: Skeleton,
  target: Skeleton,
  at: number,
  scratch: Pose,
  out: Pose,
): void {
  const map = buildRetargetMap(source, target);
  if (map.unmatched.length > 0) console.warn('joints the target lacks:', map.unmatched);
  sampleClip(clip, at, scratch);
  retargetPose(map, source, scratch, target, out);
}
// #endregion

// #region root
/** A walk whose clip carries the travel: the body is moved by it, and the pose stays put. */
const motion = createRootMotion();
export function stepWithRootMotion(
  clip: AnimationClip,
  from: number,
  to: number,
  body: { x: number; z: number; heading: number },
  pose: Pose,
): void {
  extractRootMotion(clip, 0, from, to, motion);
  /* The step is in the root's own frame at `from`, so turn it by the body's heading first. */
  const c = Math.cos(body.heading);
  const s = Math.sin(body.heading);
  const dx = motion.translation[0] ?? 0;
  const dz = motion.translation[2] ?? 0;
  body.x += c * dx + s * dz;
  body.z += -s * dx + c * dz;
  sampleClip(clip, to, pose);
  /* Without this the root moves in the pose as well, and the character goes twice as far. */
  stripRootMotion(clip, 0, pose);
}
// #endregion

// #region spring
/** A ponytail's tip, two hertz and a little under critical, trailing a head that sways. */
export function ponytail(time: number, out: Float32Array): void {
  sampleSpring(
    { frequencyHz: 2, damping: 0.6, maxOffsetM: 0.3 },
    (t, at) => {
      /* A pure function of the time it is handed: called for times before `time` too. */
      at[0] = Math.sin(t * 1.5) * 0.2;
      at[1] = 1.7;
      at[2] = 0;
    },
    time,
    out,
  );
}

/** A chain of four links hanging from the same head: a braid, three floats a link. */
const BRAID: SpringLink[] = [0, 1, 2, 3].map(() => ({
  frequencyHz: 3,
  damping: 0.5,
  restOffsetM: [0, -0.08, -0.02],
}));
export function braid(time: number, out: Float32Array): void {
  sampleSpringChain(
    BRAID,
    (t, at) => {
      at[0] = Math.sin(t * 1.5) * 0.2;
      at[1] = 1.7;
      at[2] = 0;
    },
    time,
    out,
  );
}
// #endregion

// #region rigid
/** A door on a hinge node: a clip with one rotation track drives the node, no skeleton at all. */
export function swingDoor(clip: AnimationClip, hinge: SceneNode): RigidAnimation {
  return new RigidAnimation(clip, [hinge]);
}
/* Each frame, at the door's own time: `door.apply(seconds)`. */
// #endregion

// #region morph
/** A face with two expressions: deltas per vertex, interleaved, and a weight for each per draw. */
export function face(
  renderer: RendererApi,
  head: MeshData,
  smile: Float32Array,
  blink: Float32Array,
): MeshHandle {
  const vertices = head.positions.length / 3;
  const deltas = new Float32Array(vertices * 2 * 3);
  for (let v = 0; v < vertices; v += 1) {
    deltas.set(smile.subarray(v * 3, v * 3 + 3), (v * 2 + 0) * 3);
    deltas.set(blink.subarray(v * 3, v * 3 + 3), (v * 2 + 1) * 3);
  }
  return renderer.createMesh({ ...head, morphTargets: deltas, morphTargetCount: 2 });
}

const weights = new Float32Array(2);
export function drawFace(
  renderer: RendererApi,
  mesh: MeshHandle,
  model: Float32Array,
  time: number,
): void {
  weights[0] = 0.8;
  weights[1] = time % 4 < 0.15 ? 1 : 0;
  renderer.setMorphWeights(weights);
  renderer.drawMesh(mesh, model);
  renderer.setMorphWeights(null);
}
// #endregion

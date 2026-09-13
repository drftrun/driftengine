/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * Animation: skeletons, clips, poses, and the graphs over them.
 *
 * **Nothing here touches a GPU, and that is the boundary rather than an omission.**
 * `RendererApi` is a fixed surface a package cannot extend, so the palette upload and the skinned
 * draw live in core; this package produces a `Float32Array` and knows nothing about how it reaches
 * a shader. That line is also the determinism boundary `docs/ARCHITECTURE.md` §5 names: everything
 * in here is a pure function of a time the caller supplies, and nothing reads a clock.
 *
 * What it costs is that a consumer wanting skinned characters imports two packages rather than
 * one. What would make it wrong is a renderer surface a package could extend, which nothing
 * proposes and which `render/backend/api.ts` argues against at its own definition.
 */
export type { Joint } from './skeleton.ts';
export { Skeleton } from './skeleton.ts';
export type { Pose } from './pose.ts';
export { createPose, restPose } from './pose.ts';
export type { AnimationClip, JointTrack, TrackPath } from './clip.ts';
export { sampleClip } from './clip.ts';
export type { RootMotion } from './rootMotion.ts';
export { createRootMotion, extractRootMotion, stripRootMotion } from './rootMotion.ts';
export { RigidAnimation, applyPoseToNode } from './rigid.ts';
export { addPose, blendPoses, setJoint } from './blend.ts';
export { BlendTree } from './blendTree.ts';
export type { BlendNode } from './blendTree.ts';
export { AnimationStateMachine } from './stateMachine.ts';
export type { AnimationState, AnimationTransition } from './stateMachine.ts';
export { solveTwoBone } from './ik.ts';
export { buildRetargetMap, retargetPose } from './retarget.ts';
export type { RetargetMap } from './retarget.ts';
export {
  sampleSpring,
  sampleSpringChain,
  springChainSettleSec,
  springSettleSec,
} from './spring.ts';
export type { SpringAnchor, SpringLink, SpringSettings } from './spring.ts';

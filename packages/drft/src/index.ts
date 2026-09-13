/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * The `.drft` container, and nothing else.
 *
 * This package declares no runtime dependency, which is the assertion it exists to make: a
 * file written by this engine can be read by something that never draws. `MeshData` lives
 * here for the same reason — it is what the container carries.
 */

export type { MeshData } from './meshData.ts';
export { validateMeshData } from './meshData.ts';

/* What a rig and its clips are. Here because `SKIN` and `ANIM` are chunks — see the module. */
export type { AnimationClip, DrftSkin, Joint, JointTrack, TrackPath } from './animationData.ts';
/* The hierarchy `NODE` carries, and the three chunk codecs that read and write a rig. */
export type { DrftMorph, DrftNode } from './drftSkin.ts';
export type { DrftSubs, DrftSubstanceEntry } from './drftSubs.ts';
export { buildSubs, readSubs } from './drftSubs.ts';
export {
  buildClip,
  buildMorph,
  buildNodes,
  buildSkin,
  readClip,
  readMorph,
  readNodes,
  readSkin,
} from './drftSkin.ts';

/*
 * The `.drft` asset container. See docs/FORMAT.md for the format and its compatibility rules.
 *
 * The reader is runtime code; the writer is not — it lives here because the baker imports
 * the engine as a library, and shipping both from one module is what keeps the two halves
 * of the format unable to disagree about a byte.
 */
export {
  MAX_COLLIDER_HULLS,
  MAX_COLLIDER_POINTS,
  buildColliders,
  readColliders,
} from './drftColliders.ts';
export { readDrft } from './drftRead.ts';
export type { DrftAsset, DrftTexture } from './drftRead.ts';
/* Reading one while it is still arriving, for a scene that would rather show a model build. */
export { DrftStream, streamDrft } from './drftStream.ts';
export type { DrftManifest, DrftStreamHandlers } from './drftStream.ts';
export { writeDrft } from './drftWrite.ts';
export type { DrftSource, DrftTextureSource } from './drftWrite.ts';
export { DrftError, DRFT_VERSION_MAJOR, DRFT_VERSION_MINOR } from './drftFormat.ts';
/* A consumer decoding an embedded texture has to know which codec it is holding. */
export { CODEC_PNG, CODEC_JPEG, CODEC_WEBP, CODEC_RAW, codecName } from './drftFormat.ts';
export type { DrftHead, DrftMaterial, DrftSplatBlock, DrftSplats } from './drftFormat.ts';
/* The order a capture is written in, so a baker outside this package can lay one out the same
   way — it is the whole reason a capture streams into a recognisable place. */
export { coarseFirstOrder } from './coarseFirst.ts';

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
export type { DrftSdfv, DrftSdfvEntry } from './sdfv.ts';
export { buildSdfv, readSdfv, SDFV_ENTRY_BYTES, SDFV_MAX_SAMPLES } from './sdfv.ts';
export {
  NNET_ENTRY_BYTES,
  NNET_MAX_HIDDEN,
  NNET_MAX_WIDTH,
  buildNnet,
  nnetWeightCount,
  readNnet,
} from './nnet.ts';
export type { DrftNetwork, DrftNnet } from './nnet.ts';
export { buildNgrf, readNgrf } from './ngrf.ts';
export type {
  DrftAttribute,
  DrftGraph,
  DrftGraphNode,
  DrftGraphTensor,
  DrftGraphValue,
} from './ngrf.ts';
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
/*
 * **`DTEX`: a material as a decode program over a latent, rather than as pictures.** The chunk
 * carries no semantics — this package is the container and does not know what a channel means —
 * so a channel crosses as `(semanticIndex << 4) | component` and `@driftengine/texture` owns the
 * numbering.
 */
export { buildDtex, readDtex, DTEX_ADDRESS_MODES, DTEX_MAX_TILES, DTEX_REGISTERS } from './dtex.ts';
export type { DtexEntry, DtexMaterial } from './dtex.ts';
/*
 * **`NAVM`: a way across the scene, with the placement it was built at.** The numbers in a polygon
 * mesh are cell indices, so the origin and the cell size travel inside the chunk — a mesh that
 * arrives without them is in the wrong units at the wrong place, and looks loaded.
 *
 * **`ENTS`: the things in the scene, as the entity model wrote them.** Text, in a binary container,
 * because the values are a consumer's own component fields and this package does not know their
 * types — see `ents.ts` for why encoding them would be worse than carrying them.
 */
export { buildNavm, readNavm } from './navm.ts';
export type { NavPolyMesh } from './navm.ts';
export { buildEnts, readEnts } from './ents.ts';
export type { EntsScene } from './ents.ts';
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

export { MAX_CLUSTERS, buildMeshlets, readMeshlets } from './drftMeshlets.ts';
export type { MeshletLevel } from './drftMeshlets.ts';

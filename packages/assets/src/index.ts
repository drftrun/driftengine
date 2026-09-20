/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * Reading a model, and getting it onto the GPU.
 *
 * Separate from `@driftengine/drft` because these need a renderer: the loader uploads, and
 * the readers exist to produce something the loader can upload. A procedurally generated
 * world imports none of this and pays for none of it.
 */

/*
 * And the whole load as one object: streamed, uploaded within a per-frame budget, faded in, and
 * merged down to one draw per material at the end. What it reports is *phases as data* — a
 * consumer writes the words, because what to call a stage is a decision about an audience.
 */
export { DrftLoader } from './drftLoader.ts';
/*
 * **A `DTEX` chunk's tile table as the grid residency asks about.** The other constructor of a
 * `MaterialTileGrid` — `latentTileGrid` cuts one from a latent a baker holds, and this reads one a
 * consumer downloaded. The hashes are the file's, over the bytes a fetch returns, which is what
 * makes a tile that arrived for one material already resident for another.
 */
export { dtexTileBytes, tileGridFromDtex } from './dtexTiles.ts';
export type { DrftFit, DrftLoaderOptions } from './drftLoader.ts';
/*
 * The loader's own draw-call grouping, exported because a consumer counting draws needs it and was
 * keeping a copy that could not be kept in step. See `drawKey.ts`.
 */
export { drawKeyOf, resolveDrawGrouping } from './drawKey.ts';
export type { DrawGrouping, DrawSurfaceOverride } from './drawKey.ts';
export type { DrftLoadPhase, DrftLoadProgress, DrftPart } from './loadProgress.ts';
/* Addressing a texture by name, so a consumer never holds an ordinal. */
export { TextureSet, textureColorSpaces } from './drftTextures.ts';
export { assetCandidates, basenameOf } from './assetPath.ts';
/* An image identified from its own header, because a declared mime type is optional in glTF
   and wrong often enough that reading the bytes is the only reliable answer. */
export { describeImage } from './imageInfo.ts';
export type { ImageInfo } from './imageInfo.ts';
export type { AssetReference } from './assetPath.ts';
export { readGlb, gltfToMeshes } from './gltf.ts';
export type { GltfDocument } from './gltf.ts';
export { parseObj, parseMtl } from './obj.ts';
export { parseStl } from './stl.ts';
/*
 * Radiance RGBE, for an environment a scene did not photograph.
 *
 * Opt-in on exactly the terms SDF text is: a consumer that never loads an environment never
 * imports this, ships none of it, and the engine still carries no image of its own. That is what
 * keeps the zero-texture-files rule met on its own terms rather than waived.
 */
export { readRadianceHdr } from './radianceHdr.ts';
/**
 * The material bake, exported for the GPU-driven pipeline's rig: it encodes a material to the
 * decode programs that pipeline samples on the device.
 */
export { encodeMaterial, latentImageOf } from './bake/latent.ts';
/* An encoded material as the chunk a file carries it in: the one place that knows both packages. */
export { dtexFromEncoded } from './bake/dtexChunk.ts';
export type { DtexTiles } from './bake/dtexChunk.ts';
export type { ChannelInput, EncodeMaterialOptions, EncodedMaterial } from './bake/latent.ts';
/* IESNA LM-63, on the same opt-in terms: a consumer that loads no profile ships no parser. */
export { readIesProfile } from './iesPhotometry.ts';
export type { IesProfile } from './iesPhotometry.ts';
export type { RadianceImage } from './radianceHdr.ts';
export type { StlAppearance } from './stl.ts';
/*
 * The zip-container formats and the recognise-only tier, exported for the same reason as
 * the readers above: every one of them is pure, takes its decompressor as a parameter and
 * touches no filesystem, so a consumer that wants to open a dropped file in a worker can.
 * See docs/FORMAT.md §3.3 for what that costs and why it is not the default.
 */
export { parseUsda, usdzToMeshes } from './usd.ts';
export type { UsdResult } from './usd.ts';
export { parseThreeMfModel, threeMfToMeshes } from './threemf.ts';
export type { ThreeMfResult } from './threemf.ts';
export { readZip, findEntry } from './zip.ts';
export type { ZipEntry } from './zip.ts';
export { recognise, describeRecognised } from './recognise.ts';
export type { Recognised } from './recognise.ts';
export { fbxToMeshes } from './fbx.ts';
export type { Inflate } from './fbx.ts';
/*
 * One dispatcher from a file to meshes, so a browser and the baker cannot disagree about which
 * reader a `.glb` needs. Every capability it may want is a parameter: the filesystem, the two
 * decompressors and the resolution of a name a file states are all the caller's to supply.
 */
export { readModel, readerFor, extensionOf, MODEL_FORMATS } from './readModel.ts';
export type { ModelSource, ModelImport } from './readModel.ts';
/*
 * The browser's decompressor, and the two-pass trick that makes an async one usable by a
 * synchronous parser. `DecompressionStream` is all a page has and it only works as a stream, so
 * every compressed span is recorded on one walk, expanded concurrently, and looked up on the
 * next. See `fbxInflate.ts` for why neither making the reader async nor shipping a DEFLATE
 * implementation was the answer.
 */
export {
  browserInflate,
  browserInflateRaw,
  prepareFbxInflate,
  prepareZipInflate,
} from './fbxInflate.ts';
export type { AsyncInflate } from './fbxInflate.ts';
/*
 * Turning what a reader produced into what the GPU wants: one vertex per distinct corner, and
 * no array holding one repeated number. An importer emits a vertex per triangle corner, which
 * on a real asset is roughly six times more than the model has.
 */
export { weldMesh, dropDefaultAttributes } from './weld.ts';
/*
 * The frame is derived after the weld and not inside a reader, for the reason `tangentOrder.ts`
 * measures: a soup carrying a frame per corner has nothing left to merge.
 */
export { deriveTangentsFor } from './tangentOrder.ts';
/*
 * One coarse mesh standing in for a whole asset, so a load can open on an outline rather than on
 * nothing. Baked, because a coarse model has to exist as geometry before it can be drawn, and
 * built for the whole subject at once: a decimated body reads as a car, 187 coarse parts do not.
 */
export { buildCoarseLevel, isOutlineWorthWriting, DEFAULT_COARSE_CELLS } from './coarseLevel.ts';
export type { CoarseLevelOptions } from './coarseLevel.ts';
/*
 * Which way is up, applied as one format-agnostic turn on the shared intermediate. Told rather
 * than guessed: every rule for measuring it from the geometry is wrong on something ordinary,
 * and guessing is what put a car upside down and reported it as verified.
 */
export { orientMeshes, parseUpAxis, describeUpAxis } from './orient.ts';
export type { UpAxis } from './orient.ts';

/* Skins and clips out of a glTF document. See the module for why it is not part of `gltf.ts`. */
export { readGltfSkins } from './gltfSkin.ts';
export type { GltfAnimated, GltfSkin } from './gltfSkin.ts';

/*
 * The tier 2 vehicle-container reader is deliberately **not** re-exported here.
 *
 * The barrel is the documented public surface, and `readModel` is how every format in this
 * directory is meant to be reached: it dispatches by content, applies the orientation and
 * handedness the file declared, and returns one shape whichever reader answered. Exporting a
 * single format's entry point would document a second way in that no consumer needs, and this
 * one has a further reason to stay behind the dispatcher. `scripts/kn5-check.mjs` imports the
 * module directly, which is what an in-repo probe is for.
 */
/*
 * The mirror an up-axis rotation deliberately cannot express, kept beside the rotations so the
 * next left-handed format gets the same conversion instead of writing its own.
 */
export { convertHandedness } from './orient.ts';
export type { Handedness } from './orient.ts';
/*
 * The hierarchy's half of the up-axis turn. Kept beside `orientMeshes` because calling one
 * without the other leaves a file whose graph and geometry disagree about where every part is.
 */
export { orientNodes } from './orient.ts';
/*
 * And the hierarchy's half of a mirror, which is the same pairing one step further out: a format
 * that declares itself left-handed gets `convertHandedness` over its meshes and this over its
 * graph, or the two desynchronise while each stays individually well formed.
 */
export { mirrorNodes } from './orient.ts';
/*
 * **World-space meshes into parts a consumer can turn, and `docs/HANDBOOK.md` §10.1 has told
 * people to import it from here since it was written.** It was not exported, so the one consumer
 * that followed the handbook reached the module by sub-path — the exception this repository
 * reserves for the chemistry library — and `scripts/docs.test.mjs` now checks every import the
 * documentation prints against the barrel it names.
 */
export { localiseNodes } from './localise.ts';
export type { Localised } from './localise.ts';
/*
 * The collision hull a vehicle folder ships beside its model, found by convention so a consumer
 * does not have to know the convention.
 */
export { colliderBeside, levelsBeside } from './readModel.ts';
/*
 * DDS block decoding, for the block-compressed textures a vehicle model carries. Baker work: RGBA
 * is larger than the source and nothing ships a block decoder into a frame.
 */
export { ddsToRgba, isDds } from './dds.ts';
export type { DdsImage } from './dds.ts';
/*
 * **The offline half of the GPU-driven pipeline, which nothing outside this package could reach.**
 *
 * `bake/cluster.ts` and `bake/clusterLod.ts` produce exactly what `@driftengine/core`'s
 * `buildGpuDrivenScene` consumes, and until this line neither was exported — so a consumer could
 * hold the pipeline and had no way to make its input. Every other gate was green about it: the
 * modules are tested, the package is sized, the licence is in place. Nothing asks whether a thing
 * with no route out of the package is reachable, and the first scene that tried to use one found
 * it by failing the demo boundary test.
 *
 * Baker work rather than frame work, and the split is the same one `ddsToRgba` above makes: a
 * million triangles cluster in 648 ms, which is a build step and not a mount.
 */
export { buildClusters } from './bake/cluster.ts';
export type { ClusterOptions, ClusterSet } from './bake/cluster.ts';
export { buildClusterDag } from './bake/clusterLod.ts';
export type { ClusterDag, ClusterLevel } from './bake/clusterLod.ts';
/*
 * The offline half of global illumination, exported for the same reason and against the same
 * mistake: `bake/sdf.ts` produces what `globalField.ts` composes and what the `SDFV` chunk
 * carries, and a field a consumer cannot bake is a pipeline with no input.
 */
export { bakeObjectSdf } from './bake/sdf.ts';
/*
 * **The third time, and the one that got furthest before anybody noticed.** `bake/hlod.ts` builds
 * the proxies and impostors `docs/CAPABILITIES.md` lists as shipping, it is tested, it is sized and
 * it carries the licence — and until this line its only importer in the whole repository was its
 * own test. A consumer following "the barrel is the contract" could read the row, believe the
 * capability, and find no way to call it.
 *
 * The paragraph above says a demo boundary test caught the cluster case. Nothing caught this one,
 * because no scene tried to bake an impostor — which is what the two paragraphs above are worth
 * together: **a module reached only by its own test is not shipped, and no gate here asks.** Found
 * by censusing what three consumers could adopt and what they could not.
 */
export {
  IMPOSTOR_GUTTER,
  IMPOSTOR_TILE,
  PROXY_BASE_CELLS,
  PROXY_MIN_CELLS,
  buildImpostor,
  buildProxy,
  frameOf,
  octahedralCoord,
  octahedralDirection,
  proxyResolution,
  rasteriseView,
  sampleImpostor,
} from './bake/hlod.ts';
export type { Impostor, ProxyCell, ViewFrame } from './bake/hlod.ts';
export type { ObjectSdf } from './bake/sdf.ts';

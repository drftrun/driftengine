/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/capture` — a video to a playable scene, on the player's own device.
 *
 * **What is here so far is the models a capture runs**, each written as a definition the engine's
 * one neural runtime builds a graph from: `@driftengine/texture` holds the operators and the rule
 * that every weight is read or set aside by name, and this package says which weights a model reads
 * and how. A definition is run over a checkpoint once, when it is converted, and over the converted
 * file afterwards whenever a clip needs the graph at a new size — every device kernel bakes its
 * shapes, and a clip's aspect ratio decides the patch grid.
 *
 * **Depth Anything 3**: depth, its confidence and a camera per view, from one view or several at
 * once. **Depth Anything V2 Small**, the lighter fallback: relative depth from one view.
 * **MobileSAM**: masks from a point or a box, an encoder run once an image and a decoder once a
 * prompt. **SAM 2.1**: the same, and objects tracked through a video by a memory of the frames before.
 * **OWLv2**: boxes for things named in words, an image graph and a text graph joined on the host,
 * with CLIP's tokenizer. Each answers as its upstream's own code does on a seeded miniature of its
 * layout, the fixtures shipped beside them.
 */
export { eachFrame, selectFrames } from './frames.ts';
export type { FrameChoice, FrameSize, FrameSource } from './frames.ts';
export {
  cholesky,
  choleskySolve,
  levenbergMarquardt,
  svd3,
  svdN,
  symmetricEigen,
} from './math/dense.ts';
export type { FitOptions, LeastSquares } from './math/dense.ts';
export { schurSolve } from './math/schur.ts';
export type { BlockNormals } from './math/schur.ts';
export {
  DESCRIPTOR_BYTES,
  createFeatureSet,
  describeFeatures,
  detectFeatures,
  matchFeatures,
} from './features.ts';
export type { Descriptors, FeatureSet } from './features.ts';
export { estimatePoses } from './poses.ts';
export type { CaptureFrame, PoseOptions, PoseResult } from './poses.ts';
export { relativePose, triangulate } from './twoView.ts';
export type { RelativePoseOut, RelativePoseResult } from './twoView.ts';
export { lookAt, renderTestScene } from './testScene.ts';
export type { TestBox, TestCamera, TestPlane, TestScene } from './testScene.ts';
export { createDepthEstimator } from './depth.ts';
export type { DepthEstimate, DepthEstimator, DepthView, RawFrame } from './depth.ts';
export type { GraphRun } from './run.ts';
export {
  DEPTH_PIXEL_MEAN,
  DEPTH_PIXEL_STD,
  longestSideSize,
  prepareDepthFrame,
  prepareOwlv2Frame,
  prepareSam2Frame,
  prepareSamFrame,
} from './prepare.ts';
export type { PreparedFrame } from './prepare.ts';
export { areaResize, triangleResize, PILLOW_PRECISION, TORCHVISION_PRECISION } from './resample.ts';
export { browserFrameSource } from './browserFrames.ts';
export type { BrowserClip } from './browserFrames.ts';
export {
  DEPTH_ANYTHING_3,
  decodeCamera,
  decodeDepth,
  depthAnything3,
} from './models/depthAnything3.ts';
export type { DepthAnything3Config } from './models/depthAnything3.ts';
export { DEPTH_ANYTHING_2_SMALL, depthAnything2 } from './models/depthAnything2.ts';
export type { DepthAnything2Config } from './models/depthAnything2.ts';
export type { HeadConfig } from './models/dualDpt.ts';
export type { VitConfig } from './models/vit.ts';
export {
  MINIATURE_CASES,
  MINIATURE_DEPTH_ANYTHING_2,
  MINIATURE_DEPTH_ANYTHING_3,
  MINIATURE_SEED,
  miniatureCheckpoint,
  miniatureCheckpoint2,
  miniatureImages,
} from './models/miniature.ts';
export {
  MOBILE_SAM,
  SAM_PIXEL_MEAN,
  SAM_PIXEL_STD,
  mobileSamDecoder,
  mobileSamEncoder,
  samMasksToImage,
} from './models/mobileSam.ts';
export type { MobileSamConfig } from './models/mobileSam.ts';
export type { SamDecoderConfig } from './models/samDecoder.ts';
export {
  SAM2_PROMPT,
  SAM2_VIDEO_PROMPT,
  SAM_PROMPT,
  samGridPositions,
  samInputSize,
  samPromptTokens,
  samTokenCount,
  stabilityScore,
} from './models/samPrompt.ts';
export type { SamPrompt, SamPromptLayout } from './models/samPrompt.ts';
export {
  MINIATURE_MOBILE_SAM,
  MINIATURE_SAM_IMAGE,
  MINIATURE_SAM_PROMPTS,
  miniatureSamCheckpoint,
} from './models/samMiniature.ts';
export type { TinyVitConfig } from './models/tinyVit.ts';
export { SAM_21_TINY, sam21Decoder, sam21Encoder } from './models/sam21.ts';
export type { Sam21Config, Sam21MemoryConfig } from './models/sam21.ts';
export {
  sam21MasksToImage,
  sam21MemoryAttention,
  sam21MemoryEncoder,
  sam21Upscale,
} from './models/sam21Video.ts';
export { Sam21Tracker } from './models/sam2Tracker.ts';
export type { Sam21Frame, Sam21Video, Sam21Weights } from './models/sam2Tracker.ts';
export type { HieraConfig } from './models/hiera.ts';
export {
  MINIATURE_SAM_21,
  MINIATURE_SAM_21_IMAGE,
  MINIATURE_SAM_21_PROMPTS,
  miniatureSam21Checkpoint,
} from './models/sam21Miniature.ts';
export {
  OWLV2_BASE,
  OWLV2_PIXEL_MEAN,
  OWLV2_PIXEL_STD,
  owlv2BoxBias,
  owlv2Image,
  owlv2Text,
} from './models/owlv2.ts';
export type { Owlv2Config } from './models/owlv2.ts';
export type { ClipTowerConfig } from './models/clipTower.ts';
export { owlv2Detections, owlv2Logits } from './models/owlv2Detect.ts';
export type { Owlv2Detection, Owlv2Patches } from './models/owlv2Detect.ts';
export { clipTokenizer, owlv2Tokens } from './models/clipTokenizer.ts';
export type { ClipTokenizer } from './models/clipTokenizer.ts';
export {
  MINIATURE_OWLV2,
  MINIATURE_OWLV2_IMAGE,
  MINIATURE_OWLV2_MERGES,
  MINIATURE_OWLV2_QUERIES,
  miniatureOwlv2Checkpoint,
} from './models/owlv2Miniature.ts';
/*
 * **Gaussians.** A reference rasteriser that projects the way `@driftengine/splats`' shader does,
 * its analytic gradients, and the fit that descends them into a `SplatSource` the engine draws.
 * `optimiseGaussians` is what a caller wants; the rest is exported because a caller measuring or
 * extending a fit needs the same pieces the fit is built from.
 */
export { optimiseGaussians } from './gaussians/optimise.ts';
export type { OptimiseOptions } from './gaussians/optimise.ts';
export { projectGaussian, visibleGaussians, LOW_PASS, REACH } from './gaussians/project.ts';
export type { GaussianSet, Projected, RasterCamera } from './gaussians/project.ts';
export { rasteriseGaussians } from './gaussians/rasterise.ts';
export type { Frame } from './gaussians/rasterise.ts';
export { accumulateGradients, createGradients, imageLoss } from './gaussians/gradients.ts';
export type { GaussianGradients } from './gaussians/gradients.ts';
export { sh1Basis, splatColour, SH1_COEFFICIENTS, SH_C1 } from './gaussians/harmonics.ts';
export { structuralSimilarity, SIMILARITY_WINDOW } from './gaussians/similarity.ts';
/*
 * **Splats to a surface.** A cloud's depth, many views of it fused into one volume, that volume's
 * crossing as a mesh facing outwards, and the mesh brought down to a budget — which is what a game
 * stands on, rather than the cloud, which only draws.
 */
export { renderDepth } from './gaussians/depth.ts';
export { createVolume, fuseDepth } from './fusion.ts';
export type { FuseOptions, SurfaceView, Volume } from './fusion.ts';
export { marchVolume } from './marching.ts';
export type { MarchOptions } from './marching.ts';
export { decimate } from './decimate.ts';
export type { DecimateOptions } from './decimate.ts';
/*
 * **A surface to stand on.** The drawn mesh cleaned for collision, and a prop's convex hulls inside
 * the container's own caps — which is where a capture stops being a picture.
 */
export { collisionMesh, propHulls } from './collide.ts';
export type { CollisionOptions, CollisionSource, PropHulls } from './collide.ts';
/*
 * **A surface's material, separated from the light it was photographed under.** Multi-view inverse
 * rendering with a classical separation: what stays the same across views is the material, what
 * moves is the light, and a chromaticity that holds across an intensity jump is a shadow. Every
 * surface gets a confidence, and `delight.ts` states plainly what that confidence does and does not
 * grade. `renderLit` is the lit fixture the measurements are made against.
 */
export { createDelightOut, delight } from './delight.ts';
export type { DelightOptions, DelightOut, DelightView } from './delight.ts';
export { interpolate, nearestHit, renderLit } from './delightScene.ts';
export type { Light, LitScene, MeshHit } from './delightScene.ts';
/*
 * **A mesh cut into regions, and each region proposed as something a scene could hold.** Stage four
 * and labelled as such: with a model loaded the masks are voted onto the mesh, and with none the
 * geometry answers on its own. Nothing here decides what an object *is* — a region nobody labelled
 * comes back as scenery, which is drawn, solid, and doing nothing.
 */
export { segmentGeometry } from './segment.ts';
export type { Region, SegmentOptions } from './segment.ts';
export { labelMasks, liftMasks, promptGrid } from './masks.ts';
export type { MaskView } from './masks.ts';
export {
  MOVABLE_COMPONENTS,
  SCENERY_COMPONENTS,
  WALKABLE_COMPONENTS,
  proposeEntities,
} from './propose.ts';
export type { EntityProposal, ProposeOptions } from './propose.ts';
/*
 * **Every stage in one file.** A capture that arrives as six files is a capture somebody has to
 * reassemble; this writes the mesh, its materials and decode program, the cloud, a prop's hulls,
 * the way across the scene and the proposals into one `.drft`. The proposals travel under a
 * component this package declares — a capture proposes in its own words, and what a scene ends up
 * holding is the consumer's decision.
 */
export {
  PROPOSAL_COMPONENT,
  PROPOSAL_SCHEMA,
  captureFile,
  proposalScene,
  readProposals,
} from './scene.ts';
export type { CaptureScene } from './scene.ts';

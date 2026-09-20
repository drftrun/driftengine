/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * DriftTexture: a texture as a compiled, sampled field rather than an image.
 *
 * Every engine in the world treats a texture as a bag of texels. This one treats it as a small
 * program sampled at `(uv, t, params)` — one object per *material* rather than per channel,
 * carrying every channel, every level and its own decoder.
 *
 * Three consequences fall out of that shape and none of them is available to an image:
 *
 * - **Channels compress together**, because they are correlated and compressing them apart throws
 *   that correlation away.
 * - **Time is an argument, not a clock**, so an animated texture sampled at simulation time is
 *   byte-exact under replay — which no other engine's animated texture can claim.
 * - **The decoder is data walked by one shader**, never a permutation. `ARCHITECTURE.md` measured
 *   what the other way costs at 196,910 gzipped bytes for a single flag.
 *
 * What ships here is the format, the reference decode, the material binding, predictive
 * residency and the writable overlay. The device interpreter the GPU-driven pipeline samples with
 * is `@driftengine/core`'s, checked against `decodeCpu` by `scripts/gpu-parity.mjs`.
 */
export {
  CHANNEL_SEMANTICS,
  isColour,
  linearToSrgb,
  needsVarianceMips,
  normaliseSample,
  semanticAt,
  semanticIndex,
  srgbToLinear,
} from './semantics.ts';
export type { ChannelSemantic, ChannelSpec } from './semantics.ts';
export { reduceNormalMip, toksvigRoughness } from './mipNdf.ts';
export { createTileIndex, hashTile, internTile, tileSlotCount } from './tileHash.ts';
export type { TileIndex } from './tileHash.ts';
export {
  activationBound,
  evalNetwork,
  evalNetworkHalf,
  halfPrecisionErrorBound,
  networkWeightCount,
} from './inference.ts';
export { HALF_MAX, fromHalfBits, halfWeights, roundHalf, toHalfBits } from './half.ts';
/*
 * The operators a small transformer is built from, as references the device kernels are held to:
 * the second half of the one inference runtime, beside the perceptron's evaluation above.
 */
export { addBias, erf, gelu, layerNorm, matmul, softmax } from './tensor/linear.ts';
export { attention } from './tensor/attention.ts';
export { resize } from './tensor/resize.ts';
export { conv2d, convTranspose2d, maxPool2d, patchEmbed } from './tensor/spatial.ts';
export {
  createGraphEvaluator,
  graphForDevice,
  graphFromStored,
  graphShapes,
  validateGraph,
} from './tensor/graph.ts';
export { CONSTANT_PREFIX, graphFromWeights } from './tensor/architecture.ts';
export type { Architecture, GraphBuilder, WeightSource, Weights } from './tensor/architecture.ts';
export type {
  GraphEvaluator,
  GraphNode,
  GraphTensor,
  GraphValue,
  NetworkGraph,
  StoredGraph,
} from './tensor/graph.ts';
export { OPERATORS } from './tensor/operators.ts';
export type { AttributeValue, Attributes, Operator } from './tensor/operators.ts';
export type { NetworkShape } from './inference.ts';
export { flipbookFrame, latentLerpWeights } from './timeNodes.ts';
export type { LerpWeights } from './timeNodes.ts';
export {
  ADDRESS_MODE,
  ADDRESS_MODE_COUNT,
  DECODE_OP,
  MAX_REGISTERS,
  NODE_STRIDE,
  addDecodeNode,
  createDecodeGraph,
  decodeDecodeGraph,
  encodeDecodeGraph,
  graphRegisterCount,
  nodeA,
  nodeB,
  nodeOp,
  nodeOut,
  validateDecodeGraph,
} from './decodeGraph.ts';
export type { DecodeGraph, DecodeOp } from './decodeGraph.ts';
export { REMAP_SEMANTICS, createDecodeRegisters, decodeCpu } from './decodeCpu.ts';
export type { DecodeResources, LatentImage, LatentLevel } from './decodeCpu.ts';
export { progressiveOrder, usableAt } from './progressive.ts';
export { arrayDescriptor, assignLayer, createMaterialArray, layerOf } from './materialArray.ts';
export type { MaterialArray } from './materialArray.ts';

/*
 * Predictive residency: the half that needs the simulation's save and restore rather than the
 * renderer. See `residency/predict.ts` for why looking ahead is available here and nowhere else.
 */
export { predictViews } from './residency/predict.ts';
export type { SimulationHandle } from './residency/predict.ts';
export {
  TILE_ABSENT,
  TILE_REQUESTED,
  TILE_RESIDENT,
  createResidencyTable,
  evict,
  leastRecentlyUsed,
  markRequested,
  markResident,
  residentCount,
  slotFor,
  tileState,
  touchTile,
} from './residency/table.ts';
export type { ResidencyTable } from './residency/table.ts';
export { createPrefetchQueue, enqueue, queueSize, takeBatch } from './residency/queue.ts';
export type { PrefetchQueue } from './residency/queue.ts';
export {
  acquirePage,
  beginCacheFrame,
  createPageCache,
  decodeMode,
  ensurePageDecoded,
  occupiedPages,
  pageDecoded,
  pageSlot,
  releasePage,
  setDecodeMode,
  takeEvicted,
} from './residency/pageCache.ts';
export type { DecodeMode, PageCache, PageCacheOptions, PageDecode } from './residency/pageCache.ts';
export {
  clearMissing,
  createStreamer,
  forgetMissing,
  pumpStreamer,
  streamerInFlight,
} from './residency/stream.ts';
export type { Streamer, StreamerOptions, TileSource } from './residency/stream.ts';
export {
  ADDRESS_CLAMP,
  ADDRESS_WRAP,
  OVERLAY_CHANNELS,
  compositeOverlay,
  createOverlay,
  overlayTileCount,
  overlayTiles,
  sampleOverlay,
  writeOverlay,
  writtenMaskAt,
} from './overlay/sparse.ts';
export type { Overlay, OverlayOptions, OverlayTile } from './overlay/sparse.ts';
export {
  JOURNAL_ENTRY_BYTES,
  JOURNAL_MAGIC,
  JOURNAL_VERSION,
  applyOverlayJournal,
  clearOverlay,
  createOverlayJournal,
  decodeOverlayJournal,
  emptyLike,
  encodeOverlayJournal,
  journalLength,
  recordOverlayWrite,
  rewindOverlay,
  truncateJournalFrom,
} from './overlay/journal.ts';
export type { OverlayJournal } from './overlay/journal.ts';
export { runPrediction } from './residency/predictor.ts';
export { LEVEL_MARGIN, latentTileGrid, tilesForView } from './residency/viewTiles.ts';
export type { InstanceTileInfo, MaterialTileGrid } from './residency/viewTiles.ts';
export type { Predictor } from './residency/predictor.ts';

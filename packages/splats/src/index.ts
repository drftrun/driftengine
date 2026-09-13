/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/splats` — Gaussian splat captures, read and drawn into the scene.
 *
 * **The barrel is the contract.** Anything not exported here is private to this package, whatever
 * its file permissions suggest.
 *
 * This package owns its readers, its sort, its shaders and its GPU resources, and it reaches the
 * frame through `registerPass` rather than through a verb on `RendererApi` — which is what makes
 * it a package at all. A consumer that never imports it carries none of it, and
 * `scripts/size-gate.test.mjs` asserts that rather than claiming it.
 */
export { packSplats, SPLAT_SH1_COEFFICIENTS, SPLAT_WORDS, SPLAT_WORDS_SH1 } from './splatData.ts';
export type { SplatData, SplatSource } from './splatData.ts';
export { readSplat, SPLAT_RECORD_BYTES } from './splat.ts';
export { readSplatPly } from './splatPly.ts';
/*
 * The `.sog` container: a ZIP of lossless WebP images and a manifest, which is what newer capture
 * tools emit.
 *
 * **Four exports rather than one, because the read has two halves a consumer may want separately.**
 * A bundle unpacks to files and files decode to Gaussians, and an *unbundled* capture — a
 * `meta.json` beside its images, which is what `splat-transform` writes to a directory — arrives at
 * the second half without the first. `browserWebpDecoder` is the ordinary decoder and is separate
 * from both, for the reason `splatSog.ts` opens with: Node has none, and vendoring one is a
 * thousand lines of VP8L this package will not carry.
 */
export { browserWebpDecoder } from './splatSogDecoder.ts';
export { SOG_VERSION, readSogMeta, readSogSource, readSplatSog, unbundleSog } from './splatSog.ts';
export type { DecodedImage, SogFiles, SogMeta, WebpDecoder } from './splatSog.ts';
export { createSplatPass } from './splatPass.ts';
export type { SplatPass, SplatView } from './splatPass.ts';
export { SPLAT_STRIDE } from './splatLayout.ts';
export {
  createSplatSortScratch,
  sortSplatsByDepth,
  SPLAT_SIZE_BUCKETS,
  SPLAT_SORT_BUCKETS,
} from './splatSort.ts';
export type {
  SplatSortFn,
  SplatSortRequest,
  SplatSortResult,
  SplatSortScratch,
} from './splatSort.ts';
export { SplatSorter, createDefaultSplatSort, sortOnMainThread } from './splatSorter.ts';
export type { SplatSorterOptions } from './splatSorter.ts';
export { createSplatViewLocal, resolveSplatView } from './splatView.ts';
export type { SplatViewLocal } from './splatView.ts';
export { defaultSplatBudget, SPLAT_BUDGET_DEFAULT, SPLAT_BUDGET_WEAK } from './splatBudget.ts';
export { splatBoundsVisible } from './splatCull.ts';
/* A capture that fills up as its container blocks arrive, and the one-shot form of the same
   assembly for a caller that read the whole file. */
export { SplatCapture, splatsFromRecords } from './splatCapture.ts';
export type { SplatAppend, SplatCaptureOptions } from './splatCapture.ts';

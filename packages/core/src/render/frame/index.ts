/**
 * The frame graph's pure half: what a frame touches, how a draw is recorded, and how records
 * become passes.
 *
 * Nothing here imports WebGL or WebGPU. The scheduler is arithmetic, which is what lets the
 * only novel logic in the design be proven by assertion before any renderer is rewritten
 * around it.
 *
 * Deliberately not on the package barrel. Nothing outside `render/` may reach these yet;
 * Phase B is what decides their public shape.
 */
export type { FrameResource } from './resources.ts';
export { FRAME_RESOURCES, RESOURCE_COUNT, maskOf, namesIn, resourceBit } from './resources.ts';
export type { Arena } from './arena.ts';
export {
  NODE_STRIDE,
  createArena,
  nodeCount,
  nodeMatrix,
  nodeReads,
  nodeState,
  nodeVerb,
  nodeWrites,
  recordNode,
  resetArena,
} from './arena.ts';
export type { ScheduledPass } from './schedule.ts';
export { schedule } from './schedule.ts';
export { keptNodes, scratchFor } from './replay.ts';

/*
 * The identifier-addressed half, for a frame whose composition is not fixed. See `virtual.ts`
 * for why there are two representations and why neither converts into the other.
 */
export type {
  VirtualBufferDesc,
  VirtualDesc,
  VirtualTable,
  VirtualTextureDesc,
} from './virtual.ts';
export {
  createVirtualTable,
  declareVirtual,
  resetVirtualTable,
  virtualBytes,
  virtualCount,
  virtualKind,
} from './virtual.ts';
export type { Deps } from './deps.ts';
export {
  createDeps,
  depsNodeCount,
  readsOf,
  recordDeps,
  recordMaskDeps,
  resetDeps,
  writesOf,
} from './deps.ts';
export type { Lifetimes } from './lifetime.ts';
export { computeLifetimes, createLifetimes, firstWrite, lastRead } from './lifetime.ts';
export type { AliasPlan } from './alias.ts';
export { createAliasPlan, offsetOf, planAliases } from './alias.ts';
export type { GraphPass, GraphScratch } from './graphSchedule.ts';
export { createGraphPasses, createGraphScratch, scheduleGraph } from './graphSchedule.ts';
export type { FlushSchedule } from './flushGraph.ts';
export { createFlushSchedule, scheduleFlush } from './flushGraph.ts';
export { validateGraph } from './validate.ts';

/*
 * Per-pass timings, which are the one thing here that *is* on the package barrel — see the note
 * beside its export in `src/index.ts`. A readout is not the graph.
 */
export type { PassTimings } from './passTimings.ts';
export {
  createPassTimings,
  passLabel,
  passMs,
  recordPassLabel,
  recordPassSample,
  resetPassTimings,
} from './passTimings.ts';

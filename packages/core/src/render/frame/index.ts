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

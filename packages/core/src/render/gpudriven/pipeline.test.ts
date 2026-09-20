import { expect, test } from 'vitest';

import { createDeps, readsOf, writesOf } from '../frame/deps.ts';
import { createGraphPasses, scheduleGraph } from '../frame/graphSchedule.ts';
import { validateGraph } from '../frame/validate.ts';
import {
  GPU_DRIVEN_PASSES,
  GPU_DRIVEN_RESOURCES,
  GPU_DRIVEN_ORDERED,
  gpuDrivenImports,
  gpuDrivenLive,
  gpuDrivenRefusal,
  gpuDrivenSupported,
  recordGpuDrivenFrame,
} from './pipeline.ts';
import type { GpuDrivenPassName } from './pipeline.ts';

const RES = GPU_DRIVEN_RESOURCES;

function frame(shadowed = true, blended = true) {
  const deps = createDeps(GPU_DRIVEN_PASSES.length, 256);
  return { deps, nodes: recordGpuDrivenFrame(deps, RES, { shadowed, blended }) };
}

function reads(pass: GpuDrivenPassName, shadowed = true): number[] {
  const { deps, nodes } = frame(shadowed);
  return Array.from(readsOf(deps, nodes[pass]));
}

function writes(pass: GpuDrivenPassName): number[] {
  const { deps, nodes } = frame();
  return Array.from(writesOf(deps, nodes[pass]));
}

/**
 * Which named passes a schedule of this frame keeps, in the order it runs them, and how many
 * passes it grouped them into.
 */
function schedule(shadowed: boolean): { kept: GpuDrivenPassName[]; passes: number } {
  const { deps } = frame(shadowed);
  const out = createGraphPasses(deps.count);
  const passes = scheduleGraph(deps, deps.count, gpuDrivenLive(RES), GPU_DRIVEN_ORDERED, out);
  const kept: GpuDrivenPassName[] = [];
  for (let p = 0; p < passes; p += 1) {
    const pass = out[p] as { first: number; count: number };
    for (let node = pass.first; node < pass.first + pass.count; node += 1) {
      kept.push(GPU_DRIVEN_PASSES[node] as GpuDrivenPassName);
    }
  }
  return { kept, passes };
}

test('WEBGL2 CANNOT RUN THIS PIPELINE AND SAYS SO IN WORDS', () => {
  expect(gpuDrivenSupported('webgl2')).toBe(false);
  expect(gpuDrivenRefusal('webgl2')).toContain('indirect');
  expect(gpuDrivenRefusal('webgl2')).toContain('readback');
});

test('and webgpu can, so there is nothing to say', () => {
  expect(gpuDrivenSupported('webgpu')).toBe(true);
  expect(gpuDrivenRefusal('webgpu')).toBe('');
});

test('the frame records one node per named pass, in the order the names are given', () => {
  const { deps, nodes } = frame();
  expect(deps.count).toBe(GPU_DRIVEN_PASSES.length);
  expect(GPU_DRIVEN_PASSES.map((pass) => nodes[pass])).toEqual(
    GPU_DRIVEN_PASSES.map((_pass, index) => index),
  );
});

test('every resource is its own identifier, so no two stages share one by accident', () => {
  const ids = Object.values(RES);
  expect(new Set(ids).size).toBe(ids.length);
  expect(Math.min(...ids)).toBe(0);
  expect(Math.max(...ids)).toBe(ids.length - 1);
});

test('THE INSTANCE CULL RUNS BEFORE THE CUT, and the cut reads what it decided', () => {
  /*
   * A mesh wholly outside the view is dropped once, before anything reads its clusters: the cut
   * leaves them unselected, and the cluster cull skips what the cut did not select.
   */
  expect(reads('instanceCull')).toEqual([RES.clusters]);
  expect(writes('instanceCull')).toEqual([RES.instances]);
  expect(reads('cut')).toContain(RES.instances);
  expect(GPU_DRIVEN_PASSES.indexOf('instanceCull')).toBe(GPU_DRIVEN_PASSES.indexOf('cut') - 1);
  /*
   * **Only the cut reads the flags, and the cut runs twice.** It read them once until transparency
   * arrived; `blendCull` is the same three dispatches over the other half of the scene, so a mesh
   * outside the view is dropped for the blended set exactly as it is for the opaque one. Nothing
   * further along reads them: by then they have said everything they have to say.
   */
  for (const pass of GPU_DRIVEN_PASSES) {
    if (pass !== 'cut' && pass !== 'blendCull') {
      expect(reads(pass), pass).not.toContain(RES.instances);
    }
  }
});

test('OCCLUSION READS DEPTH THIS FRAME WROTE, which is the whole reason for two halves', () => {
  expect(writes('phaseOneDraw')).toContain(RES.depth);
  expect(reads('pyramid')).toContain(RES.depth);
  expect(writes('pyramid')).toEqual([RES.hzb]);
  expect(reads('phaseTwoCull')).toContain(RES.hzb);
  /* Phase one reads no pyramid at all: the one it could read is last frame's. */
  expect(reads('cut')).not.toContain(RES.hzb);
});

test('THE HISTORY DECIDES WHICH HALF JUDGES A CLUSTER, and both halves write the next one', () => {
  expect(reads('cut')).toContain(RES.history);
  expect(reads('phaseTwoCull')).toContain(RES.history);
  expect(writes('cut')).toContain(RES.drawn);
  expect(writes('phaseTwoCull')).toContain(RES.drawn);
  /* And each half draws its own list, which is what keeps a cluster from being drawn twice. */
  expect(writes('cut')).toContain(RES.listOne);
  expect(reads('phaseOneDraw')).toContain(RES.listOne);
  expect(writes('phaseTwoCull')).toContain(RES.listTwo);
  expect(reads('phaseTwoDraw')).toContain(RES.listTwo);
  expect(reads('phaseTwoDraw')).not.toContain(RES.listOne);
});

test('phase two draws over phase one, so it reads the depth and visibility it adds to', () => {
  for (const pass of ['phaseOneDraw', 'phaseTwoDraw'] as const) {
    expect(writes(pass)).toEqual([RES.depth, RES.visibility]);
  }
  expect(reads('phaseTwoDraw')).toContain(RES.depth);
  expect(reads('phaseTwoDraw')).toContain(RES.visibility);
  expect(reads('phaseOneDraw')).not.toContain(RES.depth);
});

test('THE BINNING READS A COPY, because a render attachment is not a buffer', () => {
  expect(reads('visibilityCopy')).toEqual([RES.visibility]);
  expect(writes('visibilityCopy')).toEqual([RES.visibilityCopy]);
  expect(reads('bin')).toEqual([RES.visibilityCopy]);
  expect(reads('bin')).not.toContain(RES.visibility);
});

test('THE SCATTER CANNOT START BEFORE THE SUM, and its cursors are a copy of the offsets', () => {
  expect(writes('bin')).toEqual([RES.binCounts, RES.binOffsets]);
  expect(reads('cursorCopy')).toEqual([RES.binOffsets]);
  expect(writes('cursorCopy')).toEqual([RES.binCursors]);
  expect(reads('shade')).toContain(RES.binCursors);
  expect(reads('shade')).toContain(RES.binOffsets);
});

test('the shading reads the cleared colour and the bins, writes the colour, and reads no depth', () => {
  expect(writes('clearColour')).toEqual([RES.colour]);
  expect(reads('shade')).toContain(RES.colour);
  expect(reads('shade')).toContain(RES.visibilityCopy);
  expect(writes('shade')).toEqual([RES.binPixels, RES.colour]);
  expect(reads('shade')).not.toContain(RES.depth);
});

test('THE SHADING READS THE MAP ONLY WHERE THE FRAME IS SHADOWED', () => {
  expect(writes('shadow')).toEqual([RES.shadowMap]);
  expect(reads('shade', true)).toContain(RES.shadowMap);
  expect(reads('shade', false)).not.toContain(RES.shadowMap);
});

test('THE COLOUR AND THE HISTORY SURVIVE THE FRAME, and nothing else does', () => {
  /*
   * The depth, the pyramid, the visibility buffer and every bin are this frame's working set.
   * Naming more than that keeps memory alive that `alias.ts` could have reused; naming less culls
   * a pass that was doing something — and the history is next frame's phase one.
   */
  expect(gpuDrivenLive(RES)).toEqual([RES.colour, RES.drawn]);
  expect(gpuDrivenImports(RES)).toEqual([RES.clusters, RES.history]);
});

test('a frame reads nothing it did not write or import, shadowed or not', () => {
  for (const shadowed of [true, false]) {
    const { deps } = frame(shadowed);
    expect(validateGraph(deps, deps.count, gpuDrivenImports(RES))).toBeNull();
  }
});

test('EVERY PASS OF A SHADOWED FRAME IS LIVE, and each is its own pass, in the order named', () => {
  /*
   * A pass whose output nothing reads is dropped by `scheduleGraph`, silently and correctly — so a
   * frame that records a pass into a resource no later pass consumes has written a pass that never
   * runs. And every stage is timed by its own pair of timestamps, so none may merge.
   */
  const { kept, passes } = schedule(true);
  expect(kept).toEqual([...GPU_DRIVEN_PASSES]);
  expect(passes).toBe(GPU_DRIVEN_PASSES.length);
});

test('AN UNSHADOWED FRAME SCHEDULES THE MAP AWAY, and nothing else', () => {
  const { kept, passes } = schedule(false);
  expect(kept).toEqual(GPU_DRIVEN_PASSES.filter((pass) => pass !== 'shadow'));
  expect(passes).toBe(kept.length);
});

test('A FRAME WITH NOTHING BLENDED RECORDS THE THREE TRANSPARENT STAGES AS DEAD', () => {
  /*
   * **Culled by having no edges, which is the only way that works for this one.** The shadow map
   * is culled by filtering the read that keeps it alive; `blendResolve` writes the colour, and the
   * colour is what the frame is kept for, so a stage that writes it survives any filtering of
   * reads. Recorded with neither reads nor writes it is read by nothing and the scheduler drops it.
   */
  const { deps, nodes } = frame(true, false);
  for (const stage of ['blendCull', 'blendDraw', 'blendResolve'] as const) {
    expect(Array.from(readsOf(deps, nodes[stage])), `${stage} reads`).toEqual([]);
    expect(Array.from(writesOf(deps, nodes[stage])), `${stage} writes`).toEqual([]);
  }
});

test('and a frame that does blend records them reading and writing', () => {
  const { deps, nodes } = frame(true, true);
  expect(Array.from(writesOf(deps, nodes.blendDraw))).toEqual([RES.oitAccum, RES.oitReveal]);
  /* The resolve composites over the opaque picture, so the colour is both what it reads and what
     it writes — which is also what puts it after the shading rather than beside it. */
  expect(Array.from(readsOf(deps, nodes.blendResolve))).toContain(RES.colour);
  expect(Array.from(writesOf(deps, nodes.blendResolve))).toEqual([RES.colour]);
});

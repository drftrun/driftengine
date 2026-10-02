/**
 * A real clip through DriftCapture: frames chosen and decoded, a depth model run on the device for
 * poses, depth and a confidence, and the views fused, marched and decimated.
 *
 * A snippet, typechecked with the examples and quoted by the manual's DriftCapture chapter. The
 * model's weights do not ship with the engine: a game converts and ships the file it is licensed to.
 */
import {
  DEPTH_ANYTHING_3,
  browserFrameSource,
  createDepthEstimator,
  createVolume,
  decimate,
  fuseDepth,
  marchVolume,
  selectFrames,
} from '@driftengine/capture';
import type { DepthEstimate, GraphRun, RawFrame, SurfaceView } from '@driftengine/capture';
import { createGraphRunner } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';
import { readDrft } from '@driftengine/drft';
import { graphForDevice, graphFromStored } from '@driftengine/texture';
import type { NetworkGraph, WeightSource } from '@driftengine/texture';

// #region frames
/** Six frames of a clip, spaced by equal motion, decoded to pixels. */
export async function framesOf(clip: Blob): Promise<RawFrame[]> {
  const source = await browserFrameSource(clip);
  const kept = await selectFrames(source, { budget: 6 });
  const frames: RawFrame[] = [];
  for (const index of kept) {
    const probe = await source.frameAt(index, new Uint8Array(0));
    const pixels = new Uint8Array(probe.width * probe.height * 4);
    const size = await source.frameAt(index, pixels);
    frames.push({ pixels, width: size.width, height: size.height });
  }
  return frames;
}
// #endregion

// #region model
/** A converted model file's weights, by tensor name, as a definition reads them. */
export function weightsOf(file: ArrayBuffer): WeightSource {
  const stored = readDrft(file).graphs[0];
  if (stored === undefined) throw new Error('the model file holds no graph');
  const tensors = graphFromStored(stored).tensors;
  return { get: (name) => tensors.get(name), names: () => tensors.keys() };
}

/** Each graph run on the device, its runner built once a size and reused. */
export function onDevice(device: GPUDevice, half: boolean): GraphRun {
  const runners = new Map<NetworkGraph, Awaited<ReturnType<typeof createGraphRunner>>>();
  return async (graph, inputs) => {
    let runner = runners.get(graph);
    if (runner === undefined) {
      runner = await createGraphRunner({ device, half }, graphForDevice(graph));
      runners.set(graph, runner);
    }
    return runner.run(inputs);
  };
}

/** Depth, a confidence and a camera for every frame, from Depth Anything 3 Small. */
export function estimate(
  frames: RawFrame[],
  weights: WeightSource,
  run: GraphRun,
): Promise<DepthEstimate> {
  return createDepthEstimator(DEPTH_ANYTHING_3.small, weights, run).estimate(frames);
}
// #endregion

// #region fuse
/** The estimate as views the fusion reads: the model's confidence stands in for coverage. */
export function surfaceOf(estimate: DepthEstimate, volumeSide: number): MeshData {
  const views: SurfaceView[] = estimate.views.map((view) => ({
    depth: view.depth,
    coverage: view.confidence,
    camera: {
      width: estimate.width,
      height: estimate.height,
      intrinsics: [
        view.intrinsics[0] ?? 0,
        view.intrinsics[4] ?? 0,
        view.intrinsics[2] ?? 0,
        view.intrinsics[5] ?? 0,
      ],
      worldToCamera: Float64Array.from(view.worldToCamera),
    },
  }));
  /* A box round the room; a clip has no scale of its own until a length in it is known. */
  const spacing = volumeSide / 96;
  const half = volumeSide / 2;
  const volume = createVolume([96, 96, 96], [-half, -half, -half], spacing);
  fuseDepth(views, volume);
  const marched = marchVolume(volume);
  return decimate(marched, Math.max(512, Math.floor(marched.indices.length / 6)));
}
// #endregion

/**
 * Depth, its confidence and a camera per view, from a clip's frames rather than from tensors.
 *
 * **The frames arrive as a host hands them over** — RGBA bytes at whatever size the clip is — and
 * this prepares them as Depth Anything 3's own processor does, runs the views together so the
 * model's across-view blocks see each other, and decodes what comes back. A graph bakes its shapes,
 * so one is built per count of views and prepared size and kept: a clip's frames are all the same
 * size, so the second estimate over the same clip builds nothing.
 *
 * **It answers with its own arrays rather than filling the caller's**, which the engine's hot paths
 * never do: the prepared size is not known until the frames are prepared, so a caller cannot have
 * sized anything, and this runs once a clip rather than once a frame.
 */
import { graphFromWeights, type NetworkGraph, type WeightSource } from '@driftengine/texture';

import {
  decodeCamera,
  decodeDepth,
  depthAnything3,
  type DepthAnything3Config,
} from './models/depthAnything3.ts';
import { prepareDepthFrame } from './prepare.ts';
import type { GraphRun } from './run.ts';

/** A frame as a host hands it over: RGBA bytes, and the size they are. */
export interface RawFrame {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface DepthView {
  /** `[height, width]` metres, and one confidence each. */
  readonly depth: Float32Array;
  readonly confidence: Float32Array;
  /** 3 × 4 row-major, world to camera. */
  readonly worldToCamera: Float32Array;
  /** 3 × 3 row-major. */
  readonly intrinsics: Float32Array;
}

export interface DepthEstimate {
  /** The size the frames were prepared at, which the maps and the cameras are in. */
  readonly width: number;
  readonly height: number;
  readonly views: readonly DepthView[];
}

export interface DepthEstimator {
  estimate(frames: readonly RawFrame[]): Promise<DepthEstimate>;
}

/** An estimator over one model's weights, running its graphs through `run`. */
export function createDepthEstimator(
  config: DepthAnything3Config,
  weights: WeightSource,
  run: GraphRun,
  options: { readonly size?: number } = {},
): DepthEstimator {
  const size = options.size ?? 504;
  const graphs = new Map<string, NetworkGraph>();
  return {
    async estimate(frames) {
      if (frames.length === 0) throw new RangeError('a depth estimate needs a frame');
      const prepared = frames.map((frame) =>
        prepareDepthFrame(frame.pixels, frame.width, frame.height, size),
      );
      const { width, height } = prepared[0] as { width: number; height: number };
      for (const [at, one] of prepared.entries()) {
        if (one.width !== width || one.height !== height) {
          throw new RangeError(
            `frame ${at} prepares to ${one.width}×${one.height} and the first to ${width}×${height}` +
              ': one estimate is one clip, at one size',
          );
        }
      }
      const key = `${frames.length}.${height}x${width}`;
      let graph = graphs.get(key);
      if (graph === undefined) {
        graph = graphFromWeights(weights, depthAnything3(config, frames.length, height, width));
        graphs.set(key, graph);
      }
      const out = await run(
        graph,
        new Map(prepared.map((one, view) => [`image${view}`, one.pixels])),
      );
      const pose = out.get('pose') as Float32Array;
      const views = prepared.map((_, view) => {
        const depth = new Float32Array(width * height);
        const confidence = new Float32Array(width * height);
        decodeDepth(out.get(`logits${view}`) as Float32Array, depth, confidence);
        const worldToCamera = new Float32Array(12);
        const intrinsics = new Float32Array(9);
        decodeCamera(pose, view, height, width, worldToCamera, intrinsics);
        return { depth, confidence, worldToCamera, intrinsics };
      });
      return { width, height, views };
    },
  };
}

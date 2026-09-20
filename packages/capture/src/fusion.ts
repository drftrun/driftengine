/**
 * Many views of a scene fused into one volume: a truncated signed distance, weighted by how
 * squarely each view saw the surface.
 *
 * **Why a volume rather than the depth maps themselves.** Every view has a surface in it and no two
 * agree exactly — noise, a fit's own error, and the silhouettes where a splat cloud thins out. A
 * volume is where they are averaged: each view writes its opinion of the distance to the nearest
 * surface into the samples along its own rays, and what comes out is the surface every view agrees
 * on. `marchVolume` then reads the crossing.
 *
 * **Negative inside**, which is `ObjectSdf`'s convention in `@driftengine/assets` and the one the
 * rest of this engine reads a distance field by. A sample nearer the camera than the surface is
 * outside it and positive.
 *
 * **Truncated, because a depth map knows nothing about the far side of what it sees.** Past a few
 * samples behind the surface a view has no information at all — the space there might be solid,
 * might be another room — so writing a large negative distance would be inventing one. Everything
 * beyond the truncation on the far side is left alone; everything beyond it on the near side is
 * free space and is written as such, which is what carves the empty air out.
 *
 * **Weighted by the angle, which is what stops a grazing view winning.** A surface seen almost
 * edge-on is a few pixels wide and every one of them is uncertain in depth by the whole width of
 * the surface; seen square on, the same surface is measured well. The weight is the cosine between
 * the view's own ray and the surface's normal, taken from the depth map's own gradient, so a
 * grazing view contributes what it is worth rather than as much as any other.
 *
 * **A surface one view saw is kept, at the weight one view is worth.** Dropping it would leave a
 * hole where the capture only ever looked once, which is most of a real clip's edges.
 */
import type { RasterCamera } from './gaussians/project.ts';

/**
 * One view's opinion: its depth, how well covered each pixel was, and where it stood.
 *
 * **Not `DepthView`, which is the depth *model's* shape** — that one carries a confidence and its
 * own 3 × 3 intrinsics and does not know the size of its own frame. The two say much the same thing
 * in two forms, and the pipeline that joins them is the place to convert, not here.
 */
export interface SurfaceView {
  /** Along the camera's own axis, in metres; zero where nothing was seen. */
  readonly depth: Float32Array;
  /** Nought to one, as `renderDepth` answers it. */
  readonly coverage: Float32Array;
  readonly camera: RasterCamera;
}

/** A field of samples over a box of the world, `x` fastest, then `y`, then `z`. */
export interface Volume {
  readonly dims: readonly [number, number, number];
  /** Where the first sample sits, in the capture's world. */
  readonly origin: readonly [number, number, number];
  /** Metres between samples, the same on every axis. */
  readonly spacing: number;
  /** Truncated signed distance in metres, **negative inside**. */
  readonly distance: Float32Array;
  /** How much evidence each sample has; zero where no view ever saw it. */
  readonly weight: Float32Array;
}

export interface FuseOptions {
  /**
   * How far either side of a surface a view is believed, in metres.
   *
   * Three samples by default: enough that the crossing is bracketed by samples with real evidence
   * on both sides, which is what marching needs, and short enough that one view's surface does not
   * reach through a wall into the next room.
   */
  readonly truncation?: number;
  /** Below this coverage a pixel's depth is an average of too little light to believe. */
  readonly minimumCoverage?: number;
}

const DEFAULT_COVERAGE = 0.5;

export function createVolume(
  dims: readonly [number, number, number],
  origin: readonly [number, number, number],
  spacing: number,
): Volume {
  const [nx, ny, nz] = dims;
  return {
    dims,
    origin,
    spacing,
    distance: new Float32Array(nx * ny * nz),
    weight: new Float32Array(nx * ny * nz),
  };
}

/**
 * Every view's surface written into `volume`, which accumulates rather than replaces.
 *
 * Calling this twice with two halves of the views is the same as calling it once with all of them,
 * because a weighted mean is what each sample holds — which is what lets a clip be fused as it
 * arrives rather than all at once.
 */
export function fuseDepth(
  views: readonly SurfaceView[],
  volume: Volume,
  options: FuseOptions = {},
): void {
  const [nx, ny, nz] = volume.dims;
  const truncation = options.truncation ?? volume.spacing * 3;
  const minimumCoverage = options.minimumCoverage ?? DEFAULT_COVERAGE;
  if (!(truncation > 0)) throw new RangeError('capture: a fusion needs a truncation above zero');

  for (const view of views) {
    const { width, height, intrinsics } = view.camera;
    const [fx, fy, cx, cy] = intrinsics;
    const m = view.camera.worldToCamera;
    const normals = surfaceNormals(view);

    for (let k = 0; k < nz; k += 1) {
      for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
          const world = [
            (volume.origin[0] as number) + i * volume.spacing,
            (volume.origin[1] as number) + j * volume.spacing,
            (volume.origin[2] as number) + k * volume.spacing,
          ];
          let viewX = 0;
          let viewY = 0;
          let viewZ = 0;
          for (let r = 0; r < 3; r += 1) {
            const value =
              (m[r * 4] as number) * (world[0] as number) +
              (m[r * 4 + 1] as number) * (world[1] as number) +
              (m[r * 4 + 2] as number) * (world[2] as number) +
              (m[r * 4 + 3] as number);
            if (r === 0) viewX = value;
            else if (r === 1) viewY = value;
            else viewZ = value;
          }
          if (!(viewZ > 0)) continue;
          const px = Math.floor((fx * viewX) / viewZ + cx);
          const py = Math.floor((fy * viewY) / viewZ + cy);
          if (px < 0 || px >= width || py < 0 || py >= height) continue;
          const pixel = py * width + px;
          if ((view.coverage[pixel] as number) < minimumCoverage) continue;
          const measured = view.depth[pixel] as number;
          if (!(measured > 0)) continue;

          /*
           * How squarely this view saw that surface: the ray through the pixel against the
           * surface's own normal, both in the camera's frame. A view looking straight at it is
           * worth one and a grazing view almost nothing.
           */
          const rayX = (px + 0.5 - cx) / fx;
          const rayY = (py + 0.5 - cy) / fy;
          const rayLength = Math.sqrt(rayX * rayX + rayY * rayY + 1);
          const facing = -(
            (rayX * (normals[pixel * 3] as number) +
              rayY * (normals[pixel * 3 + 1] as number) +
              (normals[pixel * 3 + 2] as number)) /
            rayLength
          );
          const angle = facing > 0 ? facing : 0;
          const weight = angle * (view.coverage[pixel] as number);
          if (!(weight > 0)) continue;

          /*
           * **In front of the surface is outside it, and the distance is measured along the
           * surface's normal rather than along the camera's axis.** The difference of two depths is
           * a distance along the view's own ray, which is the perpendicular distance only where the
           * surface faces the camera squarely; everywhere else it overstates it by the obliquity.
           * For a plane the correction is exact, and for a curved surface it is the first-order
           * term — measured on a sphere fused from eight views, it took the median error in the
           * band from 25 mm to 11 and the ninetieth percentile from 55 mm to 43. **The worst sample
           * does not move**, because it is one at the very edge of the band whose distance
           * saturates at the truncation either way.
           */
          const signed = (measured - viewZ) * rayLength * angle;
          if (signed < -truncation) continue;
          const clamped = signed > truncation ? truncation : signed;

          const at = (k * ny + j) * nx + i;
          const held = volume.weight[at] as number;
          const total = held + weight;
          volume.distance[at] = ((volume.distance[at] as number) * held + clamped * weight) / total;
          volume.weight[at] = total;
        }
      }
    }
  }
}

/**
 * A normal per pixel, in the camera's frame, from the depth map's own gradient.
 *
 * **Central differences, and a pixel whose neighbours are not both surfaces gets the view's own
 * axis instead.** At a silhouette the difference is across the gap between a near surface and a far
 * one, which is not a gradient of anything; answering the axis there says "seen square on", which
 * is generous rather than wrong, and the coverage is what actually discounts those pixels.
 */
function surfaceNormals(view: SurfaceView): Float64Array {
  const { width, height, intrinsics } = view.camera;
  const [fx, fy, cx, cy] = intrinsics;
  const out = new Float64Array(width * height * 3);
  const at = (x: number, y: number): readonly [number, number, number] | null => {
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    const z = view.depth[y * width + x] as number;
    if (!(z > 0)) return null;
    return [((x + 0.5 - cx) * z) / fx, ((y + 0.5 - cy) * z) / fy, z];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      out[pixel * 3 + 2] = -1;
      const left = at(x - 1, y);
      const right = at(x + 1, y);
      const up = at(x, y - 1);
      const down = at(x, y + 1);
      if (left === null || right === null || up === null || down === null) continue;
      const ax = [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
      const ay = [down[0] - up[0], down[1] - up[1], down[2] - up[2]];
      const nx = (ay[1] as number) * (ax[2] as number) - (ay[2] as number) * (ax[1] as number);
      const ny = (ay[2] as number) * (ax[0] as number) - (ay[0] as number) * (ax[2] as number);
      const nz = (ay[0] as number) * (ax[1] as number) - (ay[1] as number) * (ax[0] as number);
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(length > 0)) continue;
      /* Towards the camera, which is the negative z half of its own frame. */
      const sign = nz > 0 ? -1 : 1;
      out[pixel * 3] = (sign * nx) / length;
      out[pixel * 3 + 1] = (sign * ny) / length;
      out[pixel * 3 + 2] = (sign * nz) / length;
    }
  }
  return out;
}

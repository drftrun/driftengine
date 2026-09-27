/**
 * A box's exact distance field on a grid, for a dev page that traces through slabs it built.
 *
 * Nothing here is engine API and no engine package's source may import it.
 */
import type { FieldSource } from '../../packages/core/src/index';

/**
 * A box's exact field on a grid, which is what the room's walls are traced against.
 *
 * **Sampled at one step with a count an axis, and the first version was not.** It took `n` cubed
 * over a box that is not a cube, which gives oblong voxels — and `sourceAt` derives one step from
 * the x axis and uses it on all three, because that is what `bakeObjectSdf` produces. So every one
 * of these slabs was read at its own corner and the composed field held almost no room at all: a
 * census of the bake counted **98.9% of every probe's rays leaving a closed room**, which is where
 * the bounce's missing light went. `assertCubicVoxels` now refuses a source shaped that way, so
 * this is the shape that gets past it as well as the shape that is right.
 */
export function boxField(half: [number, number, number], pad: number, step: number): FieldSource {
  const low: [number, number, number] = [-half[0] - pad, -half[1] - pad, -half[2] - pad];
  const dims = [0, 1, 2].map((axis) => Math.round((2 * ((half[axis] as number) + pad)) / step) + 1);
  const [nx, ny, nz] = dims as [number, number, number];
  const field = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const p = [ix, iy, iz].map((whole, axis) => (low[axis] as number) + whole * step);
        const gap = [
          Math.abs(p[0] as number) - half[0],
          Math.abs(p[1] as number) - half[1],
          Math.abs(p[2] as number) - half[2],
        ];
        const outside = Math.hypot(
          Math.max(gap[0] as number, 0),
          Math.max(gap[1] as number, 0),
          Math.max(gap[2] as number, 0),
        );
        const inside = Math.min(Math.max(gap[0] as number, gap[1] as number, gap[2] as number), 0);
        field[ix + nx * (iy + ny * iz)] = outside + inside;
      }
    }
  }
  return {
    field,
    dims: [nx, ny, nz],
    /* The box the counts actually span, so the step `sourceAt` derives is the step used here. */
    bounds: new Float32Array([
      low[0],
      low[1],
      low[2],
      low[0] + (nx - 1) * step,
      low[1] + (ny - 1) * step,
      low[2] + (nz - 1) * step,
    ]),
  };
}

import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { ProbeGrid } from '../probeGrid.ts';
import { newIndirectResult, traceIndirect } from './chain.ts';
import { composeGlobalField, createGlobalField } from './globalField.ts';
import { bakeProbeVisibility, createProbeVisibility } from './probeVolume.ts';

import type { GiResources } from './chain.ts';
import type { FieldSource } from './globalField.ts';

/**
 * **A sealed dark room next to a bright one stays dark.**
 *
 * This is the single most common defect in every implementation of indirect light, and it is the
 * one this whole level of the chain exists to not have. A point in the dark room takes a trilinear
 * share of a probe standing in the lit one, because a lattice knows where its probes are and
 * nothing else — so light comes out of a solid wall, brightest near it, and no amount of probe
 * density fixes it: halving the spacing halves the width of the glow and leaves it exactly as
 * bright.
 *
 * **Asserted as a maximum radiance rather than a mean**, because a leak is local. A mean over a
 * room is dominated by the far corner where nothing was ever going to leak, and a glow along one
 * wall that a viewer reads immediately barely moves it.
 */

/** Where the partition stands, and how thick it is. */
const WALL_X = 1;
const WALL_THICKNESS = 0.5;

/**
 * The partition as a baked distance field.
 *
 * **Off the probe lattice on purpose.** With probes every two metres from `x = -4`, a partition at
 * `x = 0` puts one probe *inside* it — that probe sees black in every direction and shields the
 * dark room from its own lit neighbour, so an unweighted grid leaks nothing and this test passes
 * with the visibility term deleted. `scripts/gi-schemes.mjs` had exactly that and measured nothing
 * until the wall was moved.
 */
function partitionField(across: number): FieldSource {
  const half: [number, number, number] = [WALL_THICKNESS / 2, 4, 4];
  const pad = 1;
  const bounds = new Float32Array([
    -half[0] - pad,
    -half[1] - pad,
    -half[2] - pad,
    half[0] + pad,
    half[1] + pad,
    half[2] + pad,
  ]);
  /*
   * **One step on every axis, and each axis whatever count it needs at it.**
   * `assertCubicVoxels` is why, and `demo/dev/bounce.html` is why that exists: a source sampled
   * `n` cubed over a box that is not a cube is read at the wrong place along its long axes, so
   * this partition used to be eight centimetres of voxel across and thirty-one along, and every
   * sample of it landed somewhere it is not. `across` is the count along the thin axis, which is
   * the one that has to resolve a wall half a metre thick.
   */
  const step = (2 * (half[0] + pad)) / (across - 1);
  const dims: [number, number, number] = [
    across,
    Math.round((2 * (half[1] + pad)) / step) + 1,
    Math.round((2 * (half[2] + pad)) / step) + 1,
  ];
  /* The box the counts actually span, which is what `sourceAt` divides by. */
  for (let axis = 0; axis < 3; axis++) {
    bounds[axis + 3] = (bounds[axis] as number) + ((dims[axis] as number) - 1) * step;
  }
  const [nx, ny, nz] = dims;
  const field = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const p = [ix, iy, iz].map((whole, axis) => (bounds[axis] as number) + whole * step);
        /* The exact signed distance to a box: outside is the distance to the nearest face, inside
           is the largest of the negative gaps. */
        const gap = [0, 1, 2].map((axis) => Math.abs(p[axis] as number) - (half[axis] as number));
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
  return { field, dims, bounds };
}

/** How far the partition is from a point along a direction, or a long way if it is not there. */
function distanceToWall(
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const min = [WALL_X - WALL_THICKNESS / 2, -4, -4];
  const max = [WALL_X + WALL_THICKNESS / 2, 4, 4];
  const o = [px, py, pz];
  const d = [dx, dy, dz];
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis] as number) < 1e-12) {
      if (
        (o[axis] as number) < (min[axis] as number) ||
        (o[axis] as number) > (max[axis] as number)
      ) {
        return 50;
      }
      continue;
    }
    const inv = 1 / (d[axis] as number);
    let a = ((min[axis] as number) - (o[axis] as number)) * inv;
    let b = ((max[axis] as number) - (o[axis] as number)) * inv;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
  }
  return near <= far && far > 0 ? Math.max(near, 0) : 50;
}

/** The two rooms, wired through the shipped chain. */
function rooms(weighted: boolean): GiResources {
  const field = createGlobalField(41, 2);
  const at = mat4.fromTranslation(new Float32Array(16), [WALL_X, 0, 0]) as Float32Array;
  composeGlobalField([{ source: partitionField(33), transform: at }], [0, 0, 0], 4, field);

  const grid = new ProbeGrid({ origin: [-4, -2, -2], spacing: [2, 2, 2], counts: [5, 3, 3] });
  const visibility = createProbeVisibility(16, grid.layers);
  const probeValues = new Float32Array(grid.layers * 3);
  const probeAt: [number, number, number] = [0, 0, 0];
  for (let layer = 0; layer < grid.layers; layer++) {
    grid.positionOf(layer, probeAt);
    bakeProbeVisibility(visibility, layer, (dx, dy, dz) =>
      distanceToWall(probeAt[0], probeAt[1], probeAt[2], dx, dy, dz),
    );
    /* The lit room is everything past the partition. */
    const lit = probeAt[0] > WALL_X ? 1 : 0;
    probeValues[layer * 3] = lit;
    probeValues[layer * 3 + 1] = lit;
    probeValues[layer * 3 + 2] = lit;
  }

  return {
    eye: [0, 0, 0],
    /* No frame at all: a sealed room is not on screen, so the first level never answers. */
    project: () => false,
    sceneDistance: () => Infinity,
    screenRadiance: (_u, _v, out) => out.fill(0),
    field,
    fieldRadiance: (x, _y, _z, out) => out.fill(x > WALL_X ? 1 : 0),
    grid,
    visibility: weighted ? visibility : null,
    probeValues,
    probeChannels: 3,
  };
}

/** The dark room, sampled over a fan of directions from each of a grid of points. */
function brightestInTheDark(resources: GiResources): { worst: number; at: string } {
  const out = newIndirectResult();
  let worst = 0;
  let at = '';
  for (let x = -3.5; x <= WALL_X - 0.4; x += 0.25) {
    for (let y = -1.5; y <= 1.5; y += 0.75) {
      for (let z = -1.5; z <= 1.5; z += 0.75) {
        for (let i = 0; i < 12; i++) {
          const azimuth = (i / 12) * Math.PI * 2;
          const elevation = ((i % 3) - 1) * 0.6;
          traceIndirect(
            {
              point: [x, y, z],
              normal: [1, 0, 0],
              direction: [
                Math.cos(elevation) * Math.cos(azimuth),
                Math.sin(elevation),
                Math.cos(elevation) * Math.sin(azimuth),
              ],
              coneAngle: 0,
            },
            resources,
            out,
          );
          const value = out.radiance[0] as number;
          if (value > worst) {
            worst = value;
            at = `(${x.toFixed(2)}, ${y}, ${z}) ray ${i}`;
          }
        }
      }
    }
  }
  return { worst, at };
}

test('A SEALED DARK ROOM NEXT TO A BRIGHT ONE STAYS DARK', () => {
  const { worst, at } = brightestInTheDark(rooms(true));
  expect(worst, `brightest at ${at}`).toBeLessThan(0.02);
});

test('and it does not, without the visibility term — which is what makes the first line a test', () => {
  /*
   * **The control.** A leak test that passes with the mechanism removed is measuring the scene
   * rather than the solution, and this wave's own comparison harness spent its first run doing
   * exactly that. Turning the visibility off has to put light back through the wall, or the
   * assertion above is about where the probes happen to stand.
   */
  const { worst } = brightestInTheDark(rooms(false));
  expect(worst).toBeGreaterThan(0.1);
});

import { expect, test } from 'vitest';

import { bakeObjectSdf } from './sdf.ts';

import type { MeshData } from '@driftengine/drft';

/**
 * **What this file is for: the four ways a distance field baker is wrong, and only one of them
 * is visible in a picture.**
 *
 * A field that is inside-out, a field whose gradient is not unit length, a field a thin wall fell
 * out of, and a field that differs between two bakes of the same mesh. The first shows up
 * immediately; the other three show up as a ray marcher that will not converge, as foliage and
 * walls that indirect light passes straight through, and as a container that is not reproducible.
 */

/** A mesh from raw triangle corners, indexed one to one. The rest is what a bake never reads. */
function soup(positions: number[]): MeshData {
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(count * 3),
    colors: new Float32Array(count * 3),
    emissive: new Float32Array(count),
    indices: Uint32Array.from({ length: count }, (_, at) => at),
  };
}

/**
 * A sphere as triangle soup, fine enough that its chords are not the error being measured.
 *
 * At 32 segments the sag of a chord is `r * (1 - cos(pi / 32))`, which is 4.8e-3 of a unit sphere
 * — an order below every tolerance below, so a failure is the baker rather than the tessellation.
 */
function sphere(radius: number, segments = 32): MeshData {
  const rings = segments / 2;
  const out: number[] = [];
  const at = (ring: number, segment: number): [number, number, number] => {
    const phi = (ring / rings) * Math.PI;
    const theta = (segment / segments) * 2 * Math.PI;
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    ];
  };
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = at(ring, segment);
      const b = at(ring + 1, segment);
      const c = at(ring + 1, segment + 1);
      const d = at(ring, segment + 1);
      out.push(...a, ...b, ...c);
      out.push(...a, ...c, ...d);
    }
  }
  return soup(out);
}

/** A closed box from its half extents. Six quads, two triangles each, wound outward. */
function box(hx: number, hy: number, hz: number): MeshData {
  const corner = (sx: number, sy: number, sz: number): [number, number, number] => [
    sx * hx,
    sy * hy,
    sz * hz,
  ];
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ): number[] => [...a, ...b, ...c, ...a, ...c, ...d];
  const out: number[] = [
    ...quad(corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)),
    ...quad(corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1)),
    ...quad(corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1)),
    ...quad(corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)),
    ...quad(corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1)),
    ...quad(corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)),
  ];
  return soup(out);
}

/** Every triangle wound the other way, which is what an importer hands over half the time. */
function reversed(mesh: MeshData): MeshData {
  const out = new Uint32Array(mesh.indices);
  for (let tri = 0; tri + 2 < out.length; tri += 3) {
    const second = out[tri + 1] as number;
    out[tri + 1] = out[tri + 2] as number;
    out[tri + 2] = second;
  }
  return { ...mesh, indices: out };
}

/**
 * The value at a whole grid coordinate, with the layout written out rather than imported.
 *
 * **x fastest, then y, then z** — `probeGrid.ts`'s `layerAt` states the same order for the same
 * reason: a shader recomputing this expression and disagreeing puts every sample in a different
 * place. Spelling it here rather than calling the module's own reader is what makes the layout a
 * tested decision instead of a convention that agrees with itself.
 */
function at(
  field: { field: Float32Array; dims: readonly [number, number, number] },
  ix: number,
  iy: number,
  iz: number,
): number {
  const [nx, ny] = field.dims;
  return field.field[ix + nx * (iy + ny * iz)] as number;
}

/** The whole grid coordinate nearest a world position, and the world position it stands at. */
function nearest(
  field: { dims: readonly [number, number, number]; bounds: Float32Array },
  x: number,
  y: number,
  z: number,
): { index: [number, number, number]; position: [number, number, number] } {
  const target = [x, y, z];
  const index: [number, number, number] = [0, 0, 0];
  const position: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const min = field.bounds[axis] as number;
    const max = field.bounds[axis + 3] as number;
    const count = field.dims[axis] as number;
    const step = (max - min) / (count - 1);
    const whole = Math.round(((target[axis] as number) - min) / step);
    index[axis] = Math.min(count - 1, Math.max(0, whole));
    position[axis] = min + (index[axis] as number) * step;
  }
  return { index, position };
}

test('a sphere is negative inside, near zero on its surface, and positive outside', () => {
  const baked = bakeObjectSdf(sphere(1), 32);

  for (const [x, y, z] of [
    [0, 0, 0],
    [0.3, 0.2, -0.1],
    [0, 0.5, 0],
  ] as const) {
    const { index, position } = nearest(baked, x, y, z);
    const value = at(baked, ...index);
    const radius = Math.hypot(...position);
    expect(value).toBeLessThan(0);
    /* The distance to the surface of a unit sphere from inside is `1 - r`, negated. */
    expect(value).toBeCloseTo(-(1 - radius), 1);
  }

  for (const [x, y, z] of [
    [1.4, 0, 0],
    [0, -1.3, 0],
    [0.9, 0.9, 0.9],
  ] as const) {
    const { index, position } = nearest(baked, x, y, z);
    const value = at(baked, ...index);
    const radius = Math.hypot(...position);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeCloseTo(radius - 1, 1);
  }

  /* On the surface: the sign may go either way at a texel straddling it, the magnitude may not. */
  const surface = nearest(baked, 1, 0, 0);
  expect(Math.abs(at(baked, ...surface.index))).toBeLessThan(0.1);
});

test('THE GRADIENT HAS UNIT LENGTH AWAY FROM THE SURFACE, which is what makes marching converge', () => {
  /*
   * **A sphere trace steps by the field's own value, and that is only safe if the value is a
   * distance.** A field scaled by any factor other than one — a voxel count rather than metres, a
   * half-step in the central difference, an axis whose spacing differs from the others — still has
   * the right sign everywhere and still looks like a distance field in a slice. It marches past
   * surfaces or crawls, and neither reads as a bake problem.
   *
   * Every point except the medial axis, which for a sphere is the single point at the centre.
   */
  const baked = bakeObjectSdf(sphere(1), 40);
  const [nx, ny, nz] = baked.dims;
  const step = ((baked.bounds[3] as number) - (baked.bounds[0] as number)) / (nx - 1);
  /*
   * **The spacing is the same on all three axes, and the gradient is what finds out otherwise.**
   * A field sampled on a grid whose `z` step differs from its `x` step still has the right sign
   * everywhere and still reads as a distance in a slice; its gradient is longer or shorter along
   * that axis, so a march overshoots in one direction only. Taking each axis' step from the bounds
   * the bake reports is what makes this an assertion about the bake rather than about arithmetic.
   */
  for (let axis = 1; axis < 3; axis++) {
    const along =
      ((baked.bounds[axis + 3] as number) - (baked.bounds[axis] as number)) /
      ((baked.dims[axis] as number) - 1);
    expect(along).toBeCloseTo(step, 6);
  }

  let checked = 0;
  let worst = 0;
  for (let iz = 1; iz < nz - 1; iz++) {
    for (let iy = 1; iy < ny - 1; iy++) {
      for (let ix = 1; ix < nx - 1; ix++) {
        const value = at(baked, ix, iy, iz);
        /* Away from the surface, and away from the centre where the distance field has a kink. */
        if (Math.abs(value) < 2 * step || value < -0.55) continue;
        const gx = (at(baked, ix + 1, iy, iz) - at(baked, ix - 1, iy, iz)) / (2 * step);
        const gy = (at(baked, ix, iy + 1, iz) - at(baked, ix, iy - 1, iz)) / (2 * step);
        const gz = (at(baked, ix, iy, iz + 1) - at(baked, ix, iy, iz - 1)) / (2 * step);
        worst = Math.max(worst, Math.abs(Math.hypot(gx, gy, gz) - 1));
        checked++;
      }
    }
  }

  expect(checked).toBeGreaterThan(1000);
  expect(worst).toBeLessThan(0.06);
});

test('THE SIGN CHANGES EXACTLY WHERE THE SURFACE IS, not a voxel before it or after it', () => {
  /*
   * **A parity count has to record a crossing at the first grid point *past* it, and recording it
   * at the one before is a single character.** Either way the field is negative in the middle and
   * positive outside, every slice through it looks right, and the gradient is untouched — the
   * whole boundary has simply moved one voxel along `x`. What that costs is the one thing a
   * distance field exists for: a ray marching toward a wall is told it has arrived a voxel early
   * on one side and a voxel late on the other, so it starts its next bounce inside the geometry.
   *
   * With the crossing recorded past, the sign at a grid point is **exact** rather than close, so
   * this asserts equality everywhere except within the tessellation's own sag — `r * (1 - cos(pi /
   * 32))` is 4.8e-3 for this sphere, and the band below is four times that.
   */
  const baked = bakeObjectSdf(sphere(1), 32);
  const [nx, ny, nz] = baked.dims;
  const step = ((baked.bounds[3] as number) - (baked.bounds[0] as number)) / (nx - 1);

  const offenders: string[] = [];
  let checked = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const radius = Math.hypot(
          (baked.bounds[0] as number) + ix * step,
          (baked.bounds[1] as number) + iy * step,
          (baked.bounds[2] as number) + iz * step,
        );
        /* Skip only the shell the chords themselves are uncertain about. */
        if (Math.abs(radius - 1) < 0.02) continue;
        checked++;
        const inside = at(baked, ix, iy, iz) < 0;
        if (inside !== radius < 1 && offenders.length < 8) {
          offenders.push(`(${ix}, ${iy}, ${iz}) at r=${radius.toFixed(3)} reads ${String(inside)}`);
        }
      }
    }
  }

  expect(offenders).toEqual([]);
  expect(checked).toBeGreaterThan(20000);
});

test('A THIN PLATE DOES NOT VANISH AT A RESOLUTION COARSER THAN IT IS', () => {
  /*
   * **The case that decides whether foliage and walls work at all.** A baker that voxelises — mark
   * the cells a triangle passes through, then flood the distance outward from them — loses a plate
   * thinner than one cell entirely, because no cell centre is inside it. The field comes back
   * describing an empty box, every value large and positive, and light passes through the wall.
   *
   * Two metres wide and 5 cm thick at resolution 24 puts the plate at a fifth of one voxel.
   */
  const thickness = 0.05;
  const baked = bakeObjectSdf(box(1, 1, thickness / 2), 24);
  const step =
    ((baked.bounds[3] as number) - (baked.bounds[0] as number)) / ((baked.dims[0] as number) - 1);
  expect(thickness).toBeLessThan(step);

  /* A point 20 cm from the plate is 20 cm from the plate, not from the far side of a lost box. */
  for (const distance of [0.2, 0.4]) {
    const { index, position } = nearest(baked, 0, 0, distance);
    const expected = Math.abs(position[2]) - thickness / 2;
    expect(at(baked, ...index)).toBeCloseTo(expected, 1);
  }

  /* And the nearest grid plane to it reports a distance under half a voxel, so a march lands. */
  const beside = nearest(baked, 0, 0, 0);
  expect(Math.abs(at(baked, ...beside.index))).toBeLessThan(step);
});

test('A MESH WOUND THE OTHER WAY STILL SIGNS CORRECTLY, because importers disagree about winding', () => {
  /*
   * **The sign cannot come from the winding, and every obvious way of computing it does.** A
   * face normal, an angle-weighted pseudonormal, a generalised winding number: all three flip
   * with the triangle order, so a model exported from the wrong tool comes back inside out — solid
   * where it is empty, and empty where it is solid. Parity along a ray does not care.
   */
  const outward = bakeObjectSdf(sphere(1), 24);
  const inward = bakeObjectSdf(reversed(sphere(1)), 24);

  expect(inward.dims).toEqual(outward.dims);
  for (let i = 0; i < outward.field.length; i++) {
    expect(inward.field[i]).toBe(outward.field[i]);
  }

  const centre = nearest(outward, 0, 0, 0);
  expect(at(inward, ...centre.index)).toBeLessThan(0);
});

test('two bakes of one mesh are identical, because a container has to be reproducible', () => {
  const mesh = box(0.7, 0.4, 1.1);
  const first = bakeObjectSdf(mesh, 20);
  const second = bakeObjectSdf(mesh, 20);
  expect(second.dims).toEqual(first.dims);
  expect(Array.from(second.bounds)).toEqual(Array.from(first.bounds));
  expect(new Uint8Array(second.field.buffer)).toEqual(new Uint8Array(first.field.buffer));
});

test('a bake refuses a mesh with no triangles and a resolution below two', () => {
  expect(() => bakeObjectSdf(soup([]), 16)).toThrow(/triangle/i);
  /* Positions with no index naming them is a mesh with no triangle, and the same refusal. */
  expect(() => bakeObjectSdf({ ...sphere(1, 8), indices: new Uint32Array(0) }, 16)).toThrow(
    /triangle/i,
  );
  expect(() => bakeObjectSdf(sphere(1, 8), 1)).toThrow(/resolution/i);
});

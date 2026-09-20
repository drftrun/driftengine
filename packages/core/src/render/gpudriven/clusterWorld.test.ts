import { expect, test } from 'vitest';

import { worldClusters, worldClustersInto, type ClusterWorldSource } from './clusterWorld.ts';
import { CLUSTER_KEEP, coneBackfacing, cullClusters } from './cullClusters.ts';
import { FRUSTUM_FLOATS, frustumPlanes } from './frustum.ts';

/**
 * **What this file is for: the cull asks where a cluster is and the answer was where it was
 * modelled.**
 *
 * `gpuDrivenPass.buildStatic` copied `clusters.bounds` and `clusters.cones` straight into the cull
 * buffer and the LOD buffer while the raster and the shading both applied `transforms[mesh]`, so a
 * mesh placed anywhere but the origin was frustum-culled against the wrong region, cone-culled with
 * the wrong orientation, LOD-cut on a misprojected error and occlusion-tested on the wrong
 * rectangle. Every rig in `DRAFT_SCENES` used an identity transform, which is the only reason it
 * never drew wrong — and is exactly the shape §3 row 79 is about: nothing disagreed because nothing
 * else was looking.
 *
 * So the assertions below are about what the arithmetic *means* — a point inside the local sphere
 * is inside the world one, a cluster is culled by where its mesh stands — rather than about the
 * sixteen numbers of any one matrix.
 */

/** Column-major `T · Ry(angle) · diag(sx, sy, sz)`, which is the composition a `Transform` makes. */
function trs(
  angle: number,
  sx: number,
  sy: number,
  sz: number,
  t: readonly [number, number, number],
): Float32Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return Float32Array.from([
    c * sx,
    0,
    -s * sx,
    0,
    0,
    sy,
    0,
    0,
    s * sz,
    0,
    c * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ]);
}

const IDENTITY = trs(0, 1, 1, 1, [0, 0, 0]);

/** One cluster at `centre` with `radius`, its cone, its errors, and the mesh it belongs to. */
function scene(
  parts: ReadonlyArray<{
    centre: readonly [number, number, number];
    radius: number;
    axis: readonly [number, number, number];
    cutoff: number;
    ownError?: number;
    parentError?: number;
    mesh?: number;
  }>,
): ClusterWorldSource {
  const bounds = new Float32Array(parts.length * 4);
  const cones = new Float32Array(parts.length * 4);
  const errors = new Float32Array(parts.length * 2);
  const meshOf = new Uint32Array(parts.length);
  parts.forEach((part, c) => {
    bounds.set(part.centre, c * 4);
    bounds[c * 4 + 3] = part.radius;
    cones.set(part.axis, c * 4);
    cones[c * 4 + 3] = part.cutoff;
    errors[c * 2] = part.ownError ?? 0;
    errors[c * 2 + 1] = part.parentError ?? Infinity;
    meshOf[c] = part.mesh ?? 0;
  });
  return { bounds, cones, errors, meshOf, count: parts.length };
}

const ONE = scene([{ centre: [0, 0, 0], radius: 1, axis: [0, 0, 1], cutoff: 0.25, ownError: 0.5 }]);

test('AN IDENTITY TRANSFORM CHANGES NOTHING, which is why the three rigs did not move', () => {
  /*
   * The whole of `DRAFT_SCENES` stands at the origin, so this is the line that says the fix is
   * invisible where the defect was: the capture of every existing rig has to be the byte-identical
   * frame it was before, and a transform that does nothing has to produce the buffer that was
   * uploaded before.
   */
  const world = worldClusters(ONE, IDENTITY);
  expect(Array.from(world.cull)).toEqual([0, 0, 0, 1, 0, 0, 1, 0.25]);
  expect(Array.from(world.lod)).toEqual([0, 0, 0, 1, 0.5, Infinity]);
});

test('A CLUSTER IS WHERE ITS MESH STANDS, not where it was modelled', () => {
  const world = worldClusters(ONE, trs(0, 1, 1, 1, [10, 2, -3]));
  expect(Array.from(world.cull.subarray(0, 4))).toEqual([10, 2, -3, 1]);
  /* And the LOD buffer carries the same centre, because the cut is chosen by distance to the eye. */
  expect(Array.from(world.lod.subarray(0, 4))).toEqual([10, 2, -3, 1]);
});

test('a uniform scale carries the radius with the centre', () => {
  const world = worldClusters(ONE, trs(0, 3, 3, 3, [0, 0, 0]));
  expect(world.cull[3]).toBeCloseTo(3, 6);
});

test('the cone axis turns with the mesh', () => {
  /* A quarter turn about y sends +z to +x, exactly: the matrix entries are 0 and 1. */
  const world = worldClusters(ONE, trs(Math.PI / 2, 1, 1, 1, [0, 0, 0]));
  expect(world.cull[4]).toBeCloseTo(1, 6);
  expect(world.cull[5]).toBeCloseTo(0, 6);
  expect(world.cull[6]).toBeCloseTo(0, 6);
  /* And the cone is no wider than it was: a rotation does not open it. */
  expect(world.cull[7]).toBeCloseTo(0.25, 6);
});

test('the errors are in world units, because the cut projects them onto the screen', () => {
  const world = worldClusters(ONE, trs(0, 4, 4, 4, [0, 0, 0]));
  expect(world.lod[4]).toBeCloseTo(2, 6);
});

test('A ROOT CLUSTER KEEPS ITS INFINITE PARENT ERROR, which is how it says it has no parent', () => {
  /*
   * `drftMeshlets.ts` writes `Infinity` for the coarsest level and `lodCut.ts` reads it as "the
   * parent's error is always too large", which is the half of the rule that makes the root
   * appear at all. Multiplied by a scale of zero it is `NaN`, and a `NaN` comparison is false —
   * so a degenerate transform would make the coarsest level of every mesh disappear.
   */
  for (const scale of [0.5, 2, 0]) {
    const world = worldClusters(ONE, trs(0, scale, scale, scale, [0, 0, 0]));
    expect(world.lod[5], `scale ${scale}`).toBe(Infinity);
  }
});

test('AN UNEVEN SCALE TAKES THE LONGEST AXIS, because a bound too small culls what is visible', () => {
  const world = worldClusters(ONE, trs(0, 1, 3, 2, [0, 0, 0]));
  expect(world.cull[3]).toBeCloseTo(3, 6);
});

test('EVERY POINT OF THE LOCAL SPHERE IS INSIDE THE WORLD SPHERE, which is the only claim', () => {
  /*
   * The anchor outside the arithmetic. A cull bound is conservative or it is a hole in the picture,
   * and the property that says so is containment — not that any particular entry of the matrix was
   * copied into any particular slot. Random placements, random scales, random points on the local
   * sphere.
   */
  let seed = 20260917;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let trial = 0; trial < 400; trial += 1) {
    const centre: [number, number, number] = [
      (random() - 0.5) * 20,
      (random() - 0.5) * 20,
      (random() - 0.5) * 20,
    ];
    const radius = 0.05 + random() * 4;
    const transform = trs(
      random() * Math.PI * 2,
      0.1 + random() * 3,
      0.1 + random() * 3,
      0.1 + random() * 3,
      [(random() - 0.5) * 50, (random() - 0.5) * 50, (random() - 0.5) * 50],
    );
    const world = worldClusters(scene([{ centre, radius, axis: [0, 0, 1], cutoff: 0 }]), transform);

    for (let sample = 0; sample < 8; sample += 1) {
      const theta = random() * Math.PI * 2;
      const z = random() * 2 - 1;
      const r = Math.sqrt(1 - z * z);
      const local: [number, number, number] = [
        centre[0] + Math.cos(theta) * r * radius,
        centre[1] + Math.sin(theta) * r * radius,
        centre[2] + z * radius,
      ];
      const x =
        transform[0]! * local[0] +
        transform[4]! * local[1] +
        transform[8]! * local[2] +
        transform[12]!;
      const y =
        transform[1]! * local[0] +
        transform[5]! * local[1] +
        transform[9]! * local[2] +
        transform[13]!;
      const w =
        transform[2]! * local[0] +
        transform[6]! * local[1] +
        transform[10]! * local[2] +
        transform[14]!;
      const distance = Math.hypot(x - world.cull[0]!, y - world.cull[1]!, w - world.cull[2]!);
      expect(distance, `trial ${trial} sample ${sample}`).toBeLessThanOrEqual(
        world.cull[3]! + 1e-4,
      );
    }
  }
});

test('A SQUASHED MESH REFUSES THE CONE TEST, because its normals do not follow its vertices', () => {
  /*
   * **A normal is transformed by the inverse transpose and a position by the matrix, and under an
   * uneven scale those point different ways.** Squash z by ten: a surface whose local normal is
   * `(1, 0, 1)` ends up facing very nearly +z, while the matrix applied to that normal points very
   * nearly +x — 78.6 degrees apart, which is far wider than any cone a bake produces. There
   * is no axis to write, so what goes in the buffer is a cutoff of one: a cone spanning a
   * hemisphere, which `cullClusters` can never satisfy.
   *
   * Refusing the test costs the draws it would have saved. Getting it wrong deletes surfaces that
   * face the camera, which is the failure this whole file exists to prevent.
   */
  const squash = trs(0, 1, 1, 0.1, [0, 0, 0]);
  const n: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const byMatrix = [n[0], 0, 0.1 * n[2]];
  const byInverseTranspose = [n[0], 0, n[2] / 0.1];
  const angle =
    (Math.acos(
      (byMatrix[0]! * byInverseTranspose[0]! + byMatrix[2]! * byInverseTranspose[2]!) /
        (Math.hypot(byMatrix[0]!, byMatrix[2]!) *
          Math.hypot(byInverseTranspose[0]!, byInverseTranspose[2]!)),
    ) *
      180) /
    Math.PI;
  expect(angle).toBeCloseTo(78.58, 1);

  const world = worldClusters(ONE, squash);
  expect(world.cull[7]).toBe(1);
  /* And a cutoff of one is not a cone that happens to be wide: it is a test that cannot fire. */
  expect(
    coneBackfacing(
      world.cull[4]!,
      world.cull[5]!,
      world.cull[6]!,
      world.cull[7]!,
      world.cull[0]!,
      world.cull[1]!,
      world.cull[2]!,
      world.cull[3]!,
      0,
      0,
      20,
    ),
  ).toBe(false);
});

test('A CLUSTER IS CULLED BY WHERE ITS MESH STANDS, which is the defect stated end to end', () => {
  /*
   * Two meshes holding one cluster each, modelled identically at the origin. One mesh stands ten
   * metres in front of the camera and the other four hundred metres to the side, well outside a
   * ninety-degree frustum. Exactly one survives — and with the untransformed bounds this pass used
   * to upload, both clusters sit at the origin and *both* survive, which is the wasted draw. The
   * other direction is the one that draws holes: a mesh modelled far from its own origin and placed
   * in front of the camera was culled away entirely.
   */
  const near = 0.1;
  const far = 1000;
  const f = 1 / Math.tan(Math.PI / 4 / 2);
  const viewProj = new Float32Array(16);
  viewProj[0] = f;
  viewProj[5] = f;
  viewProj[10] = near / (far - near);
  viewProj[11] = -1;
  viewProj[14] = (far * near) / (far - near);

  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj, planes);

  const pair = scene([
    { centre: [0, 0, 0], radius: 1, axis: [0, 0, 1], cutoff: 1, mesh: 0 },
    { centre: [0, 0, 0], radius: 1, axis: [0, 0, 1], cutoff: 1, mesh: 1 },
  ]);
  const transforms = new Float32Array(32);
  transforms.set(trs(0, 1, 1, 1, [0, 0, -10]), 0);
  transforms.set(trs(0, 1, 1, 1, [400, 0, -10]), 16);

  const world = worldClusters(pair, transforms);
  const keep = new Uint32Array(2);
  const list = new Uint32Array(2);
  expect(cullClusters(world.cull, planes, 0, 0, 0, null, keep, list)).toBe(1);
  expect(keep[0]).toBe(CLUSTER_KEEP);
  expect(keep[1]).toBe(0);

  /* The bounds the pass used to upload: both at the origin, so both survive. */
  const raw = new Float32Array(16);
  for (let c = 0; c < 2; c += 1) {
    raw[c * 8 + 3] = 1;
    raw[c * 8 + 6] = 1;
    raw[c * 8 + 7] = 1;
  }
  expect(cullClusters(raw, planes, 0, 0, 0, null, keep, list)).toBe(2);
});

test('THE RANGE FORM WRITES WHERE IT IS TOLD AND AGREES WITH THE WHOLE-SCENE FORM', () => {
  /*
   * **The check that matters is that the two forms cannot drift**, because a streamed mesh takes
   * the range form and every test above takes the other. Two meshes composed one at a time have to
   * land byte for byte where composing them together lands them.
   */
  const first = scene([
    { centre: [0, 0, 0], radius: 1, axis: [0, 0, 1], cutoff: 0.25, ownError: 0.5 },
    { centre: [2, 1, 0], radius: 0.5, axis: [1, 0, 0], cutoff: 0.5, ownError: 0.25 },
  ]);
  const second = scene([
    { centre: [-1, 0, 3], radius: 2, axis: [0, 1, 0], cutoff: 0.1, ownError: 1, mesh: 1 },
  ]);
  const together = scene([
    { centre: [0, 0, 0], radius: 1, axis: [0, 0, 1], cutoff: 0.25, ownError: 0.5 },
    { centre: [2, 1, 0], radius: 0.5, axis: [1, 0, 0], cutoff: 0.5, ownError: 0.25 },
    { centre: [-1, 0, 3], radius: 2, axis: [0, 1, 0], cutoff: 0.1, ownError: 1, mesh: 1 },
  ]);
  const transforms = new Float32Array(32);
  transforms.set(trs(0.4, 2, 2, 2, [1, 2, 3]), 0);
  transforms.set(trs(-1.1, 1, 1, 1, [-4, 0, 6]), 16);

  const whole = worldClusters(together, transforms);

  const cull = new Float32Array(3 * 8);
  const lod = new Float32Array(3 * 6);
  worldClustersInto(first, transforms, cull, lod, 0);
  worldClustersInto(second, transforms, cull, lod, 2);

  expect(Array.from(cull)).toEqual(Array.from(whole.cull));
  expect(Array.from(lod)).toEqual(Array.from(whole.lod));
});

test('the range form leaves records outside its range untouched', () => {
  const source = scene([
    { centre: [0, 0, 0], radius: 1, axis: [0, 0, 1], cutoff: 0.25 },
    { centre: [1, 0, 0], radius: 1, axis: [0, 0, 1], cutoff: 0.25 },
  ]);
  const transforms = trs(0, 1, 1, 1, [0, 0, 0]);
  const cull = new Float32Array(4 * 8).fill(-7);
  const lod = new Float32Array(4 * 6).fill(-7);
  worldClustersInto(source, transforms, cull, lod, 2);
  /* The first two records are still the sentinel; only 2 and 3 were written. */
  expect(Array.from(cull.subarray(0, 16))).toEqual(new Array(16).fill(-7));
  expect(cull[16]).not.toBe(-7);
  expect(Array.from(lod.subarray(0, 12))).toEqual(new Array(12).fill(-7));
  expect(lod[12]).not.toBe(-7);
});

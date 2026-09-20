import { expect, test } from 'vitest';

import { CLUSTER_KEEP, cullClusters } from './cullClusters.ts';
import { FRUSTUM_FLOATS, frustumPlanes, sphereOutsideFrustum } from './frustum.ts';
import {
  INSTANCE_FLOATS,
  INSTANCE_HIDDEN,
  cullInstances,
  instanceBounds,
  instanceSphereInto,
  selectClusters,
} from './instances.ts';
import { clusterSelected } from './lodCut.ts';

/** A conventional perspective looking down -z, ninety degrees, near 1 and far 100. */
function viewProj(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = -101 / 99;
  m[11] = -1;
  m[14] = -200 / 99;
  return m;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Eight floats a cluster, as `clusterWorld.ts` lays them out: centre, radius, cone, cutoff. */
function worldCull(spheres: readonly (readonly [number, number, number, number])[]): Float32Array {
  const out = new Float32Array(spheres.length * 8);
  spheres.forEach((sphere, i) => {
    out.set(sphere, i * 8);
    /* Facing the camera with a hemisphere of normals: the cone never culls. */
    out.set([0, 0, 1, 1], i * 8 + 4);
  });
  return out;
}

test('A MESH’S SPHERE HOLDS EVERY CLUSTER OF IT, measured in the numbers the device will read', () => {
  /*
   * **Conservative is the only safe direction for a cull**, and single precision is where a sphere
   * fitted in double quietly stops being one: a centre rounded one way and a radius rounded the
   * other leave a cluster's far edge a few parts in ten million outside. So the containment is
   * checked against the stored float32 numbers, not the ones the fit had in hand.
   */
  const random = lcg(0x9e3779b9);
  const count = 400;
  const meshCount = 7;
  const spheres: [number, number, number, number][] = [];
  const meshOf = new Uint32Array(count);
  for (let c = 0; c < count; c += 1) {
    const mesh = c % meshCount;
    meshOf[c] = mesh;
    /* Each mesh far from the origin and from the others, so rounding has something to bite. */
    const base = 10_000 + mesh * 3_000;
    spheres.push([
      base + random() * 50,
      -base + random() * 50,
      base * 0.5 + random() * 50,
      0.01 + random() * 8,
    ]);
  }
  const cull = worldCull(spheres);
  const bounds = instanceBounds(cull, meshOf, count, meshCount);
  expect(bounds).toBeInstanceOf(Float32Array);
  expect(bounds).toHaveLength(meshCount * INSTANCE_FLOATS);
  for (let c = 0; c < count; c += 1) {
    const mesh = meshOf[c] as number;
    const at = mesh * INSTANCE_FLOATS;
    const own = c * 8;
    const reach =
      Math.hypot(
        (cull[own] as number) - (bounds[at] as number),
        (cull[own + 1] as number) - (bounds[at + 1] as number),
        (cull[own + 2] as number) - (bounds[at + 2] as number),
      ) + (cull[own + 3] as number);
    expect(reach, `cluster ${String(c)} of mesh ${String(mesh)}`).toBeLessThanOrEqual(
      bounds[at + 3] as number,
    );
  }
  /* And not wildly larger than it needs to be: each mesh's clusters span about 60 units. */
  for (let mesh = 0; mesh < meshCount; mesh += 1) {
    expect(bounds[mesh * INSTANCE_FLOATS + 3]).toBeLessThan(60);
  }
});

test('a mesh with one cluster is that cluster, and a mesh with none is a point that draws nothing', () => {
  const cull = worldCull([[3, -4, 5, 2]]);
  const bounds = instanceBounds(cull, new Uint32Array([1]), 1, 3);
  expect(Array.from(bounds.subarray(4, 8))).toEqual([3, -4, 5, 2]);
  expect(Array.from(bounds.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  expect(Array.from(bounds.subarray(8, 12))).toEqual([0, 0, 0, 0]);
});

test('a cluster naming a mesh the scene does not have is refused rather than bounded nowhere', () => {
  expect(() => instanceBounds(worldCull([[0, 0, 0, 1]]), new Uint32Array([2]), 1, 2)).toThrow(
    /cluster 0 .*mesh 2.*2 meshes/,
  );
});

test('THE INSTANCE CULL IS THE SPHERE TEST, one flag a mesh', () => {
  const random = lcg(0x51ed270b);
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  const count = 300;
  const spheres = new Float32Array(count * INSTANCE_FLOATS);
  for (let i = 0; i < count; i += 1) {
    spheres.set(
      [(random() - 0.5) * 80, (random() - 0.5) * 80, -random() * 140, random() * 6],
      i * INSTANCE_FLOATS,
    );
  }
  const hidden = new Uint32Array(count);
  const culled = cullInstances(planes, spheres, count, hidden);
  let expected = 0;
  for (let i = 0; i < count; i += 1) {
    const at = i * INSTANCE_FLOATS;
    const outside = sphereOutsideFrustum(
      planes,
      spheres[at] as number,
      spheres[at + 1] as number,
      spheres[at + 2] as number,
      spheres[at + 3] as number,
    );
    expect(hidden[i]).toBe(outside ? INSTANCE_HIDDEN : 0);
    if (outside) expected += 1;
  }
  expect(culled).toBe(expected);
  expect(culled).toBeGreaterThan(0);
  expect(culled).toBeLessThan(count);
});

test('A CLUSTER OF A HIDDEN MESH IS NOT IN THE CUT, however its error falls', () => {
  /*
   * **The cut is where the flag is read**, because it is the one per-cluster stage with room: the
   * cluster cull already binds seven buffers of the eight a stage is allowed by default, and the
   * compaction all seven of its own. A cluster the cut does not select is one the cull then skips
   * without testing and the compaction never lists.
   */
  const lod = new Float32Array([
    /* centre, radius, own error, parent error: each in the cut on its own. */
    0,
    0,
    -10,
    1,
    0.001,
    Infinity,
    0,
    0,
    -10,
    1,
    0.001,
    Infinity,
    0,
    0,
    -10,
    1,
    0.001,
    Infinity,
  ]);
  const meta = new Uint32Array([0, 3, 0, 0, 3, 3, 1, 1, 6, 3, 2, 0]);
  const hidden = new Uint32Array([0, INSTANCE_HIDDEN]);
  const selected = new Uint32Array(3);
  const chosen = selectClusters(lod, meta, hidden, 1080, Math.PI / 3, 1, 0, 0, 0, selected);
  expect(Array.from(selected)).toEqual([1, 0, 1]);
  expect(chosen).toBe(2);
  expect(clusterSelected(0.001, Infinity, 10, 1, 1080, Math.PI / 3, 1)).toBe(true);
});

test('and a visible mesh’s clusters are cut exactly as the level rule says', () => {
  const random = lcg(0x2b1c9d4f);
  const count = 256;
  const lod = new Float32Array(count * 6);
  const meta = new Uint32Array(count * 4);
  const eye = [0, 2, 12] as const;
  for (let i = 0; i < count; i += 1) {
    const own = random() * 0.4;
    lod.set(
      [
        (random() - 0.5) * 60,
        (random() - 0.5) * 20,
        -random() * 90,
        0.2 + random() * 3,
        own,
        own + random() * 0.6,
      ],
      i * 6,
    );
    meta[i * 4 + 3] = i % 3;
  }
  const selected = new Uint32Array(count);
  const chosen = selectClusters(
    lod,
    meta,
    new Uint32Array(3),
    1080,
    Math.PI / 3,
    1.5,
    eye[0],
    eye[1],
    eye[2],
    selected,
  );
  let expected = 0;
  for (let i = 0; i < count; i += 1) {
    const at = i * 6;
    const want = clusterSelected(
      lod[at + 4] as number,
      lod[at + 5] as number,
      Math.hypot(
        (lod[at] as number) - eye[0],
        (lod[at + 1] as number) - eye[1],
        (lod[at + 2] as number) - eye[2],
      ),
      lod[at + 3] as number,
      1080,
      Math.PI / 3,
      1.5,
    );
    expect(selected[i]).toBe(want ? 1 : 0);
    if (want) expected += 1;
  }
  expect(chosen).toBe(expected);
  expect(chosen).toBeGreaterThan(0);
  expect(chosen).toBeLessThan(count);
});

test('THE CLUSTER CULL SKIPS WHAT THE CUT DID NOT SELECT, and keeps nothing of it', () => {
  /*
   * Every cluster here would survive every test. The ones the cut left out are not tested and not
   * kept — which is what an instance cull costs the clusters of a hidden mesh, and what a cluster at
   * a level the cut did not choose already cost nothing to draw and something to test.
   */
  const cull = worldCull([
    [0, 0, -10, 1],
    [0, 0, -12, 1],
    [0, 0, -14, 1],
    [0, 0, -16, 1],
  ]);
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  const keep = new Uint32Array(4).fill(7);
  const list = new Uint32Array(4);
  const kept = cullClusters(cull, planes, 0, 0, 0, null, keep, list, new Uint32Array([1, 0, 1, 0]));
  expect(kept).toBe(2);
  expect(Array.from(keep)).toEqual([CLUSTER_KEEP, 0, CLUSTER_KEEP, 0]);
  expect(Array.from(list.subarray(0, kept))).toEqual([0, 2]);
  /* Without a selection, every cluster is judged, as before. */
  expect(cullClusters(cull, planes, 0, 0, 0, null, keep, list)).toBe(4);
});

test('THE PER-MESH FORM AGREES WITH THE WHOLE-SCENE FORM', () => {
  /*
   * **Two forms of one piece of arithmetic, and a streamed mesh takes the other one.** The range
   * form exists because a streamed mesh's clusters are contiguous by construction — the allocator
   * hands out a range — so the `meshOf` scan `instanceBounds` does is work a streaming caller has
   * already done. What must not happen is the two disagreeing about the sphere.
   */
  const cull = Float32Array.from([
    /* Four clusters, two a mesh: world centre, radius, then the cone this ignores. */
    0, 0, 0, 1, 0, 0, 1, 0, 4, 0, 0, 1, 0, 0, 1, 0, -3, 2, 0, 2, 0, 0, 1, 0, 1, 2, 0, 1, 0, 0, 1, 0,
  ]);
  const meshOf = Uint32Array.from([0, 0, 1, 1]);
  const whole = instanceBounds(cull, meshOf, 4, 2);

  const out = new Float32Array(2 * INSTANCE_FLOATS);
  instanceSphereInto(cull, 0, 2, out, 0);
  instanceSphereInto(cull, 2, 2, out, 1);

  expect(Array.from(out)).toEqual(Array.from(whole));
});

test('a mesh with no clusters gets a sphere of zero radius rather than an infinity', () => {
  /*
   * A mesh may legally have no clusters. `cullInstances` reads every sphere, so one made of
   * `Infinity - (-Infinity)` would compare against `NaN` — false everywhere — which reads as a
   * mesh that is never culled rather than one that is never drawn.
   */
  const out = new Float32Array(INSTANCE_FLOATS).fill(-7);
  instanceSphereInto(new Float32Array(0), 0, 0, out, 0);
  expect(Array.from(out)).toEqual([0, 0, 0, 0]);
});

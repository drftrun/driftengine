import { expect, test } from 'vitest';
import { MeshBuilder } from './meshBuilder.ts';
import { validateMeshData } from '../render/mesh.ts';

test('cylinder cap vertices stay on their axial planes', () => {
  const mesh = new MeshBuilder().addCylinder([2, 3, 4], 1, 0.5, 'x', [1, 1, 1], 0, 3).build();

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const normalX = mesh.normals[i];
    if (normalX === 1) expect(mesh.positions[i]).toBe(2.5);
    if (normalX === -1) expect(mesh.positions[i]).toBe(1.5);
  }
});

test('a tube sweeps a round cross-section along its path', () => {
  const builder = new MeshBuilder();
  // A straight run down +X, constant radius 1.
  builder.addTube([0, 0, 0, 1, 0, 0, 2, 0, 0], [1, 1, 1], [1, 1, 1], 0, 8);
  const mesh = builder.build();

  expect(mesh.positions.length / 3, 'three rings of eight').toBe(24);

  // Every vertex sits exactly one radius off the centreline it belongs to.
  for (let i = 0; i < 24; i++) {
    const y = mesh.positions[i * 3 + 1] ?? 0;
    const z = mesh.positions[i * 3 + 2] ?? 0;
    expect(Math.hypot(y, z)).toBeCloseTo(1, 6);
  }

  // And every normal is unit, radial, and perpendicular to the sweep.
  for (let i = 0; i < 24; i++) {
    const nx = mesh.normals[i * 3] ?? 0;
    const ny = mesh.normals[i * 3 + 1] ?? 0;
    const nz = mesh.normals[i * 3 + 2] ?? 0;
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
    expect(nx, 'a normal leaning along the tube would shade as a cone').toBeCloseTo(0, 6);
  }
});

test('a tube faces outward, or back-face culling deletes it entirely', () => {
  /*
   * The silent failure: reversed winding renders with no error and no pixels. Checked
   * by taking each triangle's geometric normal and asking whether it agrees with the
   * radial direction of its own vertices.
   */
  const builder = new MeshBuilder();
  builder.addTube([0, 0, 0, 1, 0, 0, 2, 0, 0], [1, 1, 1], [1, 1, 1], 0, 8);
  const mesh = builder.build();

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = (mesh.indices[t] ?? 0) * 3;
    const ib = (mesh.indices[t + 1] ?? 0) * 3;
    const ic = (mesh.indices[t + 2] ?? 0) * 3;
    const ax = mesh.positions[ia] ?? 0;
    const ay = mesh.positions[ia + 1] ?? 0;
    const az = mesh.positions[ia + 2] ?? 0;
    const e1y = (mesh.positions[ib + 1] ?? 0) - ay;
    const e1z = (mesh.positions[ib + 2] ?? 0) - az;
    const e1x = (mesh.positions[ib] ?? 0) - ax;
    const e2x = (mesh.positions[ic] ?? 0) - ax;
    const e2y = (mesh.positions[ic + 1] ?? 0) - ay;
    const e2z = (mesh.positions[ic + 2] ?? 0) - az;
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    // Radial direction at vertex a, on a tube whose axis is X.
    expect(fy * ay + fz * az, 'a triangle winds inward').toBeGreaterThan(0);
    void fx;
  }
});

test('a tube tapers, and refuses a path it cannot sweep', () => {
  const builder = new MeshBuilder();
  builder.addTube([0, 0, 0, 0, 2, 0], [1, 0.25], [1, 1, 1], 0, 6);
  const mesh = builder.build();
  const far = (i: number): number =>
    Math.hypot(mesh.positions[i * 3] ?? 0, mesh.positions[i * 3 + 2] ?? 0);
  expect(far(0)).toBeCloseTo(1, 6);
  expect(far(6)).toBeCloseTo(0.25, 6);

  expect(() => new MeshBuilder().addTube([0, 0, 0], [1], [1, 1, 1])).toThrow(/two path points/);
  expect(() => new MeshBuilder().addTube([0, 0, 0, 1, 0, 0], [1], [1, 1, 1])).toThrow(/one radius/);
  expect(() => new MeshBuilder().addTube([0, 0, 0, 1, 0, 0], [1, 1], [1, 1, 1], 0, 2)).toThrow(
    /at least 3/,
  );
});

test('a tube does not twist where its path turns through vertical', () => {
  /*
   * A frame built from a fixed world up flips through 180 degrees as the tangent
   * passes vertical, which puts a visible seam at exactly the apex of an arch. The
   * transported frame has no such singularity, so consecutive rings stay aligned.
   */
  const path: number[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= 24; i++) {
    const theta = Math.PI - (i / 24) * Math.PI;
    path.push(4 * Math.cos(theta), 5 * Math.sin(theta), 0);
    radii.push(0.2);
  }
  const mesh = new MeshBuilder().addTube(path, radii, [1, 1, 1], 0, 8).build();

  // Vertex j of each ring must stay close to vertex j of the ring before it: a flip
  // sends it to the far side of the tube, which is two radii away.
  for (let i = 1; i <= 24; i++) {
    for (let j = 0; j < 8; j++) {
      const a = ((i - 1) * 8 + j) * 3;
      const b = (i * 8 + j) * 3;
      const apart = Math.hypot(
        (mesh.positions[b] ?? 0) - (mesh.positions[a] ?? 0),
        (mesh.positions[b + 1] ?? 0) - (mesh.positions[a + 1] ?? 0),
        (mesh.positions[b + 2] ?? 0) - (mesh.positions[a + 2] ?? 0),
      );
      expect(apart, `ring ${i} vertex ${j} jumped`).toBeLessThan(0.9);
    }
  }
});

test('planar UVs are opt-in', () => {
  /*
   * The promise `MeshData.uvs` makes, and the reason the projection is derived in
   * `build` rather than accumulated: a world that will never sample a texture must not
   * pay two floats a vertex for coordinates it does not use. A consumer builds
   * its entire world through this class.
   */
  const plain = new MeshBuilder().addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]).build();
  expect(plain.uvs).toBeUndefined();

  const textured = new MeshBuilder()
    .addBox([0, 0, 0], [1, 1, 1], [1, 1, 1])
    .build({ planarUvs: true });
  expect(textured.uvs?.length).toBe((textured.positions.length / 3) * 2);
});

test('a surface built from separate boxes tiles continuously across the join', () => {
  /*
   * The whole reason the projection is world-space rather than a per-face 0–1 range.
   * A corridor is many wall boxes end to end; if each restarted its UVs at 0 the
   * pattern would visibly break at every seam.
   *
   * Two unit boxes side by side along +X, sharing the plane x = 1. On their top faces
   * (normal +Y, so U runs along X and V along Z) the far edge of the first box and the
   * near edge of the second are both at x = 1, so both must give U = 1 — hand-derived,
   * not read back from the builder.
   *
   * U and V used to be the other way round on this face, from picking the pair by rotating
   * the axis index. That gave every face a *different* idea of which way was up — a wall
   * facing X ran U upward while a wall facing Z ran V upward — so an oriented texture
   * appeared rotated a quarter turn on adjacent walls of the same room. Continuity across
   * the join, which is what this test is actually about, is unaffected by the fix.
   */
  const mesh = new MeshBuilder()
    .addBox([0.5, 0, 0.5], [0.5, 0.5, 0.5], [1, 1, 1])
    .addBox([1.5, 0, 0.5], [0.5, 0.5, 0.5], [1, 1, 1])
    .build({ planarUvs: true });

  const uvs = mesh.uvs;
  if (uvs === undefined) throw new Error('expected UVs');

  const topFaceVs = new Set<number>();
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    if (mesh.normals[i * 3 + 1] !== 1) continue;
    // U runs along X for a +Y face, so it reads back as the vertex's own world X.
    expect(uvs[i * 2]).toBe(mesh.positions[i * 3]);
    topFaceVs.add(uvs[i * 2] ?? Number.NaN);
  }
  // Both boxes contributed, and they meet at exactly one shared coordinate.
  expect([...topFaceVs].sort((a, b) => a - b)).toEqual([0, 1, 2]);
});

test('every vertical face agrees on which way is up', () => {
  /*
   * The bug this locks out was visible and confusing: one side of a corridor wallpapered
   * correctly and the other rotated a quarter turn, on walls built by the same call. It
   * came from choosing the UV pair by rotating the axis index, which is tidy and gives
   * adjacent walls different up axes.
   *
   * The invariant is simply stated: on any face whose normal is horizontal, V is world Y.
   */
  const mesh = new MeshBuilder().addBox([0, 1, 0], [1, 1, 1], [1, 1, 1]).build({ planarUvs: true });
  const uvs = mesh.uvs;
  if (uvs === undefined) throw new Error('expected UVs');

  let verticalFaces = 0;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    if (Math.abs(mesh.normals[i * 3 + 1] ?? 0) > 0.5) continue;
    verticalFaces++;
    expect(uvs[i * 2 + 1], 'V is world Y on every wall, whichever way it faces').toBe(
      mesh.positions[i * 3 + 1],
    );
  }
  expect(verticalFaces, 'four vertical faces on a box').toBe(16);
});

test('a capsule is closed, and its poles sit where its length says', () => {
  /*
   * The invariant that makes it usable as a silhouette: no crack at the seam between a
   * cap and the shaft, and a predictable total height. `halfLength` measures the
   * cylindrical part only, so a capsule of radius 0.5 and half-length 1 stands 3 tall —
   * hand-derived, not read back from the builder.
   */
  const mesh = new MeshBuilder().addCapsule([0, 0, 0], 0.5, 1, [1, 1, 1]).build();

  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 1; i < mesh.positions.length; i += 3) {
    const y = mesh.positions[i] ?? 0;
    if (y < lowest) lowest = y;
    if (y > highest) highest = y;
  }
  expect(lowest).toBeCloseTo(-1.5, 6);
  expect(highest).toBeCloseTo(1.5, 6);

  // Every vertex lies on the capsule's surface: radius from the axis, allowing for the
  // shaft's straight section. A crack or a stray pole vertex breaks this.
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] ?? 0;
    const y = mesh.positions[i + 1] ?? 0;
    const z = mesh.positions[i + 2] ?? 0;
    const axial = Math.max(Math.abs(y) - 1, 0);
    expect(Math.hypot(x, z, axial)).toBeCloseTo(0.5, 6);
  }
});

test('a sphere is a capsule with no shaft', () => {
  const mesh = new MeshBuilder().addSphere([0, 0, 0], 1, [1, 1, 1]).build();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    expect(
      Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0),
    ).toBeCloseTo(1, 6);
  }
});

/**
 * The two properties `addBlob` exists for, and the second is the one a radial normal fails.
 *
 * A consumer reached this after four attempts at a rock, each defeated by a property of the
 * primitive rather than by the shape: boxes gave right angles, overlapping spheres gave cusps,
 * a quad grid gave eighty flat plates, and a tube gave a pebble because its section is a circle.
 * The same gap stopped a planet having latitude bands, since every other generator takes one
 * colour for a whole call.
 */
test('a blob of constant radius is a sphere, and its normals point outward', () => {
  const builder = new MeshBuilder();
  builder.addBlob([0, 0, 0], () => 2, [1, 0, 0], 0, 16, 8);
  const mesh = builder.build();
  expect(() => validateMeshData(mesh)).not.toThrow();

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] as number;
    const y = mesh.positions[i + 1] as number;
    const z = mesh.positions[i + 2] as number;
    expect(Math.hypot(x, y, z), 'every point sits on the radius it was given').toBeCloseTo(2, 4);
    /* A sphere's normal *is* its radius, so this is the case where the two agree and the
       cross product must reproduce it. */
    const radial = Math.hypot(x, y, z) || 1;
    const dot =
      ((mesh.normals[i] as number) * x +
        (mesh.normals[i + 1] as number) * y +
        (mesh.normals[i + 2] as number) * z) /
      radial;
    expect(dot, 'the normal faces out along the radius').toBeGreaterThan(0.99);
  }
});

test('a blob whose radius varies does not face along its own radius', () => {
  /*
   * The whole reason the normal is taken from the surface rather than from the radius. A bulge
   * tilts the surface away from radial, and a radial normal would light a boulder as a sphere:
   * lumpy silhouette, and shading that does not agree with it.
   */
  const builder = new MeshBuilder();
  builder.addBlob([0, 0, 0], (u) => 2 + Math.sin(u * Math.PI * 2) * 0.6, [1, 1, 1], 0, 32, 16);
  const mesh = builder.build();
  expect(() => validateMeshData(mesh)).not.toThrow();

  let tilted = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] as number;
    const y = mesh.positions[i + 1] as number;
    const z = mesh.positions[i + 2] as number;
    const radial = Math.hypot(x, y, z) || 1;
    const dot =
      ((mesh.normals[i] as number) * x +
        (mesh.normals[i + 1] as number) * y +
        (mesh.normals[i + 2] as number) * z) /
      radial;
    if (dot < 0.98) tilted++;
  }
  expect(tilted, 'the slope of the bulge turns the normal away from radial').toBeGreaterThan(0);
});

test('a blob keeps the surface parameters it walked, so a round thing can wear an image', () => {
  /*
   * The three properties a wrapped equirectangular image depends on, and each has a wrong
   * version that draws rather than throwing: a `v` measured from the wrong pole flips the map,
   * a `u` that stops short of 1 leaves a wedge of the image unused, and a seam column that does
   * not repeat the first pulls the far edge of the image across the last cell.
   */
  const builder = new MeshBuilder();
  const segments = 8;
  const rings = 4;
  builder.addBlob([0, 0, 0], () => 1, [1, 1, 1], 0, segments, rings);
  const mesh = builder.build();
  const uvs = mesh.uvs;
  if (uvs === undefined) throw new Error('a blob should carry its own coordinates');

  expect(uvs.length, 'one pair per vertex').toBe((segments + 1) * (rings + 1) * 2);

  /* Vertex 0 is the first of the bottom ring: u at the start of the wrap, v at the low pole. */
  expect(uvs[0]).toBe(0);
  expect(uvs[1]).toBe(0);
  /* The seam vertex of that ring repeats the first, which is what a wrapped image wants. */
  expect(uvs[segments * 2], 'u reaches exactly 1 at the seam').toBe(1);
  expect(uvs[segments * 2 + 1], 'and is still on the same ring').toBe(0);
  /* And the far pole is v = 1, so the map runs pole to pole rather than stopping short. */
  expect(uvs[uvs.length - 1], 'v reaches exactly 1 at the far pole').toBe(1);

  /* v agrees with height, which is the check that catches a flipped map. */
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const y = mesh.positions[i * 3 + 1] as number;
    const v = uvs[i * 2 + 1] as number;
    if (v === 0) expect(y, 'v = 0 is the low pole').toBeLessThan(0);
    if (v === 1) expect(y, 'v = 1 is the high pole').toBeGreaterThan(0);
  }
});

test('geometry with nothing to map carries no coordinates at all', () => {
  /*
   * The same promise `grain` and `relief` make. A world of boxes must produce exactly the mesh
   * it produced before blobs had coordinates, and upload no buffer to say so.
   */
  const builder = new MeshBuilder();
  builder.addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]);
  expect(builder.build().uvs).toBeUndefined();
});

test('a blob after other geometry does not shift the coordinates onto the wrong vertices', () => {
  /*
   * The defect this padding exists to prevent, and it has happened twice in this file under
   * other names: an attribute array shorter than the vertex count is read past its end as
   * zeroes by some drivers and makes others drop the draw, and neither raises a GL error.
   */
  const builder = new MeshBuilder();
  builder.addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]);
  const boxVertices = builder.build().positions.length / 3;
  builder.addBlob([4, 0, 0], () => 1, [1, 1, 1], 0, 8, 4);
  const mesh = builder.build();
  const uvs = mesh.uvs;
  if (uvs === undefined) throw new Error('the blob should have produced coordinates');

  expect(uvs.length, 'every vertex has a pair, including the box').toBe(
    (mesh.positions.length / 3) * 2,
  );
  for (let i = 0; i < boxVertices * 2; i++) {
    expect(uvs[i], 'the box was padded rather than given the blob s coordinates').toBe(0);
  }
  /* And the blob's own first vertex still starts at the origin of the map. */
  expect(uvs[boxVertices * 2]).toBe(0);
  expect(uvs[boxVertices * 2 + 1]).toBe(0);
});

test('a blob takes its colour per point, which is what a banded planet needs', () => {
  const builder = new MeshBuilder();
  /* Constant radius, colour from latitude: a sphere with bands, which nothing here could make. */
  builder.addBlob(
    [0, 0, 0],
    () => 1,
    (_u, v) => (v > 0.5 ? [1, 0, 0] : [0, 0, 1]),
    0,
    8,
    4,
  );
  const mesh = builder.build();
  const reds = [];
  const blues = [];
  for (let i = 0; i < mesh.colors.length; i += 3) {
    if ((mesh.colors[i] as number) > 0.5) reds.push(i);
    if ((mesh.colors[i + 2] as number) > 0.5) blues.push(i);
  }
  expect(reds.length, 'the upper band is red').toBeGreaterThan(0);
  expect(blues.length, 'the lower band is blue').toBeGreaterThan(0);
});

test('a builder that bound nothing emits no joints or weights', () => {
  const mesh = new MeshBuilder().addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]).build();
  expect(mesh.joints).toBeUndefined();
  expect(mesh.weights).toBeUndefined();
});

test('every vertex added while a joint is set binds to it at full weight', () => {
  const builder = new MeshBuilder();
  builder.setJoint(0).addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]);
  const firstBox = builder.build().positions.length / 3;
  builder.setJoint(3).addBox([4, 0, 0], [1, 1, 1], [1, 1, 1]);
  const mesh = builder.build();
  const total = mesh.positions.length / 3;

  expect(mesh.joints?.length).toBe(total * 4);
  expect(mesh.weights?.length).toBe(total * 4);

  /* The first box answers joint 0, the second joint 3. A rigid bind is one influence, so
     the other three slots are zero — the shader sums four products and a stray weight
     would drag a vertex toward joint 0. */
  expect(Array.from(mesh.joints?.subarray(0, 4) ?? [])).toEqual([0, 0, 0, 0]);
  expect(Array.from(mesh.weights?.subarray(0, 4) ?? [])).toEqual([1, 0, 0, 0]);
  expect(Array.from(mesh.joints?.subarray(firstBox * 4, firstBox * 4 + 4) ?? [])).toEqual([
    3, 0, 0, 0,
  ]);
  expect(Array.from(mesh.weights?.subarray(firstBox * 4, firstBox * 4 + 4) ?? [])).toEqual([
    1, 0, 0, 0,
  ]);
});

test('vertices added before any binding follow joint 0 rather than nothing', () => {
  /* Not "unweighted". A zero-weight vertex collapses onto the origin, which reads as
     geometry exploding toward the rig's root — so an unbound vertex follows the root,
     which is what a rigid mesh under a skeleton is. */
  const builder = new MeshBuilder();
  builder.addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]);
  builder.setJoint(2).addBox([4, 0, 0], [1, 1, 1], [1, 1, 1]);
  const mesh = builder.build();
  expect(Array.from(mesh.joints?.subarray(0, 4) ?? [])).toEqual([0, 0, 0, 0]);
  expect(Array.from(mesh.weights?.subarray(0, 4) ?? [])).toEqual([1, 0, 0, 0]);
});

test('a bound mesh is a valid mesh, and covers every vertex from any geometry verb', () => {
  /* addCylinder and addSphere push vertices through paths of their own, and the binding is
     expanded at build from spans rather than pushed at each of the seven push sites — so
     the thing worth asserting is that the arrays come out the right length whatever verb
     produced the vertices. A short attribute buffer is read past the end as zeroes by some
     drivers and makes others drop the draw, and neither raises a GL error. */
  const builder = new MeshBuilder();
  builder.setJoint(1).addCylinder([0, 0, 0], 1, 0.5, 'x', [1, 1, 1], 0, 6);
  builder.setJoint(2).addSphere([4, 0, 0], 1, [1, 1, 1]);
  const mesh = builder.build();
  const total = mesh.positions.length / 3;
  expect(mesh.joints?.length).toBe(total * 4);
  expect(mesh.weights?.length).toBe(total * 4);
  expect(() => validateMeshData(mesh)).not.toThrow();
});

test('setJoint(null) stops binding, and what follows still belongs to the mesh', () => {
  const builder = new MeshBuilder();
  builder.setJoint(1).addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]);
  const firstBox = builder.build().positions.length / 3;
  builder.setJoint(null).addBox([4, 0, 0], [1, 1, 1], [1, 1, 1]);
  const mesh = builder.build();
  expect(Array.from(mesh.joints?.subarray(firstBox * 4, firstBox * 4 + 4) ?? [])).toEqual([
    0, 0, 0, 0,
  ]);
  expect(Array.from(mesh.weights?.subarray(firstBox * 4, firstBox * 4 + 4) ?? [])).toEqual([
    1, 0, 0, 0,
  ]);
  expect(() => validateMeshData(mesh)).not.toThrow();
});

test('a joint index that is not a non-negative integer is refused', () => {
  expect(() => new MeshBuilder().setJoint(-1)).toThrow(/joint/i);
  expect(() => new MeshBuilder().setJoint(1.5)).toThrow(/joint/i);
});

/**
 * Every triangle's geometric normal, against the normal stored on its first vertex.
 *
 * **The check that separates a flipped normal from a flipped face.** Negating a normal alone would
 * satisfy any assertion about which way a surface lights and leave the triangle wound the other
 * way, which is a face that lights correctly and is culled. The wrappers below reverse *corners*,
 * and this is what proves it.
 */
function windingAgreesWithNormals(mesh: ReturnType<MeshBuilder['build']>): boolean {
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [i, j, k] = [mesh.indices[t] ?? 0, mesh.indices[t + 1] ?? 0, mesh.indices[t + 2] ?? 0];
    const p = (v: number, axis: number): number => mesh.positions[v * 3 + axis] ?? 0;
    const ux = p(j, 0) - p(i, 0),
      uy = p(j, 1) - p(i, 1),
      uz = p(j, 2) - p(i, 2);
    const vx = p(k, 0) - p(i, 0),
      vy = p(k, 1) - p(i, 1),
      vz = p(k, 2) - p(i, 2);
    const gx = uy * vz - uz * vy,
      gy = uz * vx - ux * vz,
      gz = ux * vy - uy * vx;
    const dot =
      gx * (mesh.normals[i * 3] ?? 0) +
      gy * (mesh.normals[i * 3 + 1] ?? 0) +
      gz * (mesh.normals[i * 3 + 2] ?? 0);
    if (!(dot > 0)) return false;
  }
  return true;
}

/**
 * The corner order that reads naturally, and the normal it actually produces.
 *
 * `(0,0) (1,0) (1,1) (0,1)` on the ground plane is how a person walks around a rectangle, and
 * `addQuad` takes `(b − a) × (d − a)` from it, which is `+X × +Z` and points at the floor. That is
 * the documented trap, asserted here so the wrapper below has something to be a wrapper *of*.
 */
test('a ground quad faces up whichever way its corners were walked', () => {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [1, 0, 1];
  const d: [number, number, number] = [0, 0, 1];

  const trap = new MeshBuilder().addQuad(a, b, c, d, [1, 1, 1]).build();
  expect(trap.normals[1], 'the trap itself: the obvious winding faces down').toBe(-1);

  for (const corners of [
    [a, b, c, d],
    [a, d, c, b],
  ] as const) {
    const mesh = new MeshBuilder()
      .addGroundQuad(corners[0], corners[1], corners[2], corners[3], [1, 1, 1])
      .build();
    for (let i = 0; i < 4; i++) {
      expect(mesh.normals[i * 3 + 1], 'up, from either order').toBe(1);
    }
    expect(windingAgreesWithNormals(mesh), 'and wound to match, not merely negated').toBe(true);
    validateMeshData(mesh);
  }
});

test('a wall quad faces away from the point it is given', () => {
  /* Standing in the xy plane, so `addQuad` reads +Z from this order. */
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [1, 1, 0];
  const d: [number, number, number] = [0, 1, 0];

  const behind = new MeshBuilder().addWallQuad(a, b, c, d, [0.5, 0.5, -5], [1, 1, 1]).build();
  expect(behind.normals[2], 'the room is at -Z, so the face looks at +Z').toBe(1);
  expect(windingAgreesWithNormals(behind)).toBe(true);

  const infront = new MeshBuilder().addWallQuad(a, b, c, d, [0.5, 0.5, 5], [1, 1, 1]).build();
  expect(infront.normals[2], 'and the other way round when the room moves').toBe(-1);
  expect(windingAgreesWithNormals(infront)).toBe(true);
});

test('a quad with the reference point in its own face is refused', () => {
  expect(() =>
    new MeshBuilder().addWallQuad(
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0.5, 0.5, 0],
      [1, 1, 1],
    ),
  ).toThrow(/no outward side/);
  expect(() =>
    new MeshBuilder().addGroundQuad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [1, 1, 1]),
  ).toThrow(/addWallQuad/);
});

/**
 * A box lying along the diagonal, measured on its own axes.
 *
 * With `forward` normalised to `(√½, 0, √½)`, right is `worldUp × forward` = `(√½, 0, −√½)` and up
 * stays `(0, 1, 0)`. Half-extents of 1, 2 and 3 then put the `(+1,+1,+1)` corner at
 * `r + 2u + 3f` = `(√½ + 3√½, 2, −√½ + 3√½)` = `(2.8284, 2, 1.4142)`, which is the literal below.
 * The three extents are what a world-axis box cannot express and the reason this method exists.
 *
 * **What this cannot see is handedness**, and saying so is cheaper than implying otherwise: a box
 * is symmetric about all three of its axes, so a basis built left-handed produces the same twenty-
 * four corners in a different order and every assertion below still passes. The comment beside the
 * cross product is where that is kept honest.
 */
test('an oriented box is measured along its own axes and faces outward', () => {
  const mesh = new MeshBuilder().addOrientedBox([0, 0, 0], [1, 2, 3], [1, 0, 1], [1, 1, 1]).build();

  expect(mesh.positions.length / 3, 'six faces of four corners').toBe(24);
  expect(mesh.indices.length).toBe(36);

  const half = Math.SQRT1_2;
  const axes = [
    [half, 0, -half],
    [0, 1, 0],
    [half, 0, half],
  ] as const;
  const reach = [0, 0, 0];
  let corner = false;
  for (let v = 0; v < 24; v++) {
    const p = [
      mesh.positions[v * 3] ?? 0,
      mesh.positions[v * 3 + 1] ?? 0,
      mesh.positions[v * 3 + 2] ?? 0,
    ];
    for (let axis = 0; axis < 3; axis++) {
      const along =
        p[0] * (axes[axis]?.[0] ?? 0) +
        p[1] * (axes[axis]?.[1] ?? 0) +
        p[2] * (axes[axis]?.[2] ?? 0);
      reach[axis] = Math.max(reach[axis] ?? 0, Math.abs(along));
    }
    /* Outward: every vertex of a box sits on the far side of its own faces from the centre. */
    const outward =
      p[0] * (mesh.normals[v * 3] ?? 0) +
      p[1] * (mesh.normals[v * 3 + 1] ?? 0) +
      p[2] * (mesh.normals[v * 3 + 2] ?? 0);
    expect(outward, `vertex ${v} lights from the inside`).toBeGreaterThan(0);
    if (Math.abs(p[0] - 2.8284271) < 1e-5 && p[1] === 2 && Math.abs(p[2] - 1.4142136) < 1e-5) {
      corner = true;
    }
  }
  expect(reach[0], 'one across').toBeCloseTo(1, 6);
  expect(reach[1], 'two up').toBeCloseTo(2, 6);
  expect(reach[2], 'three along the diagonal').toBeCloseTo(3, 6);
  expect(corner, 'the hand-derived corner is present').toBe(true);
  expect(windingAgreesWithNormals(mesh)).toBe(true);
  validateMeshData(mesh);
});

test('a box along a vertical says which method to use instead', () => {
  expect(() =>
    new MeshBuilder().addOrientedBox([0, 0, 0], [1, 1, 1], [0, 1, 0], [1, 1, 1]),
  ).toThrow(/addOrientedMesh/);
  expect(() =>
    new MeshBuilder().addOrientedBox([0, 0, 0], [1, 1, 1], [0, 0, 0], [1, 1, 1]),
  ).toThrow(/no direction/);
});

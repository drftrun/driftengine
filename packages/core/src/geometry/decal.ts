import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * A decal, as the receiving surface's own geometry clipped to a box and lifted off it.
 *
 * **A forward renderer cannot write a decal cheaply into a G-buffer, because there is no G-buffer**,
 * and that is the fact every decal design here has to start from. What a forward renderer *can* do
 * is the older technique, and it is the better-looking one: take the triangles the projector box
 * covers, clip them to it, and draw that. The decal is then made of the surface, so it follows
 * every curve and every bump exactly, which a projector re-drawing a quad cannot.
 *
 * **What it replaces, in a consumer's own words.** Their road patches are strips of geometry lifted
 * two millimetres above the carriageway: it works, it is a draw call per patch for something that
 * exists only to sit on top of something else, and it does not follow a curved surface. Puddles
 * after a storm, oil stains and skid marks were all waiting on the same row. This is one mesh for
 * as many marks as you project into it, and it is the road's own shape.
 *
 * **Built once, not per frame.** A decal is authored or placed by an event — a tyre locks, a barrel
 * leaks — and then it is scenery. That is what makes clipping on the CPU the right cost: it happens
 * at the moment the mark is made, and every frame afterwards it is one more mesh in the batch.
 *
 * **Its limits, stated rather than discovered.** It is a *static* decal: the receiving mesh is
 * sampled as it is, so a decal on something that later deforms rides the old shape. It reads
 * positions and normals and nothing else, so the mark takes its own colour rather than tinting what
 * is underneath. And a projector box covering a hundred thousand triangles clips a hundred thousand
 * triangles, so a caller marking a large world hands in the piece of it they mean.
 */
export interface DecalOptions {
  /** Middle of the projector box, world space. */
  readonly center: Vec3;
  /** Half-size across, up, and along the projection. The third is how deep the box reaches. */
  readonly halfExtents: Vec3;
  /**
   * The direction the decal is projected *along* — for a mark on the ground, straight down.
   *
   * A surface is marked when it faces back along this. Need not be normalised.
   */
  readonly forward: Vec3;
  /** Which way is up in the decal's own image, so a mark can be turned. Need not be normalised. */
  readonly up: Vec3;
  readonly color?: Vec3;
  /**
   * How far the decal is lifted off the surface, metres. Two millimetres by default.
   *
   * **Not a depth-bias setting in disguise.** The lift is along each vertex's own normal, so it
   * survives a surface that curves away under it where a constant depth offset would not, and it is
   * small enough to be invisible at a metre and large enough to beat a 24-bit depth buffer at fifty.
   */
  readonly offsetM?: number;
  /**
   * How far from facing the projector a surface may be turned and still be marked, as a cosine.
   *
   * The reason this is not zero: a triangle exactly edge-on to the projector clips to a sliver of
   * zero area that still costs six vertices, and one a hair past edge-on produces a mark stretched
   * along a wall it was never aimed at. 0.1 keeps everything within about 84° of facing.
   */
  readonly facingCos?: number;
  readonly emissive?: number;
  readonly specular?: number;
}

/** Room for one clipped polygon: six planes can each add a vertex to a triangle. */
const MAX_POLYGON = 12;
/** Position in box space and normal in world space, per vertex, in both ping-pong buffers. */
const A = new Float64Array(MAX_POLYGON * 6);
const B = new Float64Array(MAX_POLYGON * 6);

export function projectDecal(target: MeshData, options: DecalOptions): MeshData {
  const half = options.halfExtents;
  const hx = half[0];
  const hy = half[1];
  const hz = half[2];
  if (!(hx > 0 && hy > 0 && hz > 0)) {
    throw new Error(`projectDecal: halfExtents must be positive, got ${hx}, ${hy}, ${hz}`);
  }

  /* The box's own basis. `forward` is the projection axis and `right` closes the frame. */
  const f = unit(options.forward);
  let u = unit(options.up);
  const r = cross(u, f);
  const rLength = Math.hypot(r[0], r[1], r[2]);
  if (rLength === 0) {
    throw new Error('projectDecal: up is parallel to forward, so the box has no orientation');
  }
  r[0] /= rLength;
  r[1] /= rLength;
  r[2] /= rLength;
  /* Re-derived so the frame is orthonormal even where the caller's up was not perpendicular. */
  u = cross(f, r);

  const facingCos = options.facingCos ?? 0.1;
  const offsetM = options.offsetM ?? 0.002;
  const colour = options.color ?? [1, 1, 1];
  const emissive = options.emissive ?? 0;
  const specular = options.specular ?? 0;
  const centre = options.center;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const emissives: number[] = [];
  const speculars: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const triangles = target.indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const i0 = target.indices[t * 3] ?? 0;
    const i1 = target.indices[t * 3 + 1] ?? 0;
    const i2 = target.indices[t * 3 + 2] ?? 0;

    /*
     * The *geometric* normal decides whether the triangle is marked, not the shaded one. A smooth
     * sphere's vertex normals fan out around a triangle, so a facing test on any one of them turns
     * a decal on and off along an edge nobody can see; the plane the triangle actually lies in is
     * the thing the projector either sees or does not.
     */
    const nx = geoNormal(target, i0, i1, i2, 0);
    const ny = geoNormal(target, i0, i1, i2, 1);
    const nz = geoNormal(target, i0, i1, i2, 2);
    const facing = -(nx * f[0] + ny * f[1] + nz * f[2]);
    if (facing < facingCos) continue;

    let count = 3;
    for (let corner = 0; corner < 3; corner++) {
      const v = corner === 0 ? i0 : corner === 1 ? i1 : i2;
      const px = (target.positions[v * 3] ?? 0) - centre[0];
      const py = (target.positions[v * 3 + 1] ?? 0) - centre[1];
      const pz = (target.positions[v * 3 + 2] ?? 0) - centre[2];
      A[corner * 6] = px * r[0] + py * r[1] + pz * r[2];
      A[corner * 6 + 1] = px * u[0] + py * u[1] + pz * u[2];
      A[corner * 6 + 2] = px * f[0] + py * f[1] + pz * f[2];
      A[corner * 6 + 3] = target.normals[v * 3] ?? 0;
      A[corner * 6 + 4] = target.normals[v * 3 + 1] ?? 0;
      A[corner * 6 + 5] = target.normals[v * 3 + 2] ?? 0;
    }

    /* Sutherland–Hodgman against the six faces of the box, in the box's own space where each is a
       comparison against a constant. */
    let source = A;
    let sink = B;
    for (let axis = 0; axis < 3 && count > 0; axis++) {
      const limit = axis === 0 ? hx : axis === 1 ? hy : hz;
      for (const sign of [1, -1]) {
        count = clip(source, count, sink, axis, sign, limit);
        const swap = source;
        source = sink;
        sink = swap;
        if (count === 0) break;
      }
    }
    if (count < 3) continue;

    const base = positions.length / 3;
    for (let v = 0; v < count; v++) {
      const bx = source[v * 6] ?? 0;
      const by = source[v * 6 + 1] ?? 0;
      const bz = source[v * 6 + 2] ?? 0;
      let vnx = source[v * 6 + 3] ?? 0;
      let vny = source[v * 6 + 4] ?? 0;
      let vnz = source[v * 6 + 5] ?? 0;
      /* An interpolated normal is shorter than unit between two that differ. */
      const length = Math.hypot(vnx, vny, vnz) || 1;
      vnx /= length;
      vny /= length;
      vnz /= length;
      positions.push(
        centre[0] + r[0] * bx + u[0] * by + f[0] * bz + vnx * offsetM,
        centre[1] + r[1] * bx + u[1] * by + f[1] * bz + vny * offsetM,
        centre[2] + r[2] * bx + u[2] * by + f[2] * bz + vnz * offsetM,
      );
      normals.push(vnx, vny, vnz);
      colors.push(colour[0], colour[1], colour[2]);
      emissives.push(emissive);
      speculars.push(specular);
      /* The projection is the mapping: across the box is u, up the box is v. */
      uvs.push(bx / (hx * 2) + 0.5, by / (hy * 2) + 0.5);
    }
    for (let v = 2; v < count; v++) indices.push(base, base + v - 1, base + v);
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    emissive: Float32Array.from(emissives),
    specular: Float32Array.from(speculars),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}

/**
 * Keep the part of the polygon on the inside of one box face, interpolating across the crossings.
 *
 * Every attribute is carried through the same `t`, which is what makes a clipped normal the normal
 * the surface had at that point rather than one of the corners'.
 */
function clip(
  source: Float64Array,
  count: number,
  sink: Float64Array,
  axis: number,
  sign: number,
  limit: number,
): number {
  let out = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const di = sign * (source[i * 6 + axis] ?? 0) - limit;
    const dj = sign * (source[j * 6 + axis] ?? 0) - limit;
    if (di <= 0) {
      if (out < MAX_POLYGON) copy(source, i, sink, out++);
    }
    if (di > 0 !== dj > 0) {
      const t = di / (di - dj);
      if (out < MAX_POLYGON) {
        for (let k = 0; k < 6; k++) {
          const a = source[i * 6 + k] ?? 0;
          const b = source[j * 6 + k] ?? 0;
          sink[out * 6 + k] = a + (b - a) * t;
        }
        out++;
      }
    }
  }
  return out;
}

function copy(source: Float64Array, from: number, sink: Float64Array, to: number): void {
  for (let k = 0; k < 6; k++) sink[to * 6 + k] = source[from * 6 + k] ?? 0;
}

/** One component of the triangle's own plane normal, unit length. */
function geoNormal(mesh: MeshData, i0: number, i1: number, i2: number, component: number): number {
  const ax = mesh.positions[i0 * 3] ?? 0;
  const ay = mesh.positions[i0 * 3 + 1] ?? 0;
  const az = mesh.positions[i0 * 3 + 2] ?? 0;
  const ux = (mesh.positions[i1 * 3] ?? 0) - ax;
  const uy = (mesh.positions[i1 * 3 + 1] ?? 0) - ay;
  const uz = (mesh.positions[i1 * 3 + 2] ?? 0) - az;
  const vx = (mesh.positions[i2 * 3] ?? 0) - ax;
  const vy = (mesh.positions[i2 * 3 + 1] ?? 0) - ay;
  const vz = (mesh.positions[i2 * 3 + 2] ?? 0) - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return (component === 0 ? nx : component === 1 ? ny : nz) / length;
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

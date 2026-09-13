import { createLineSegments } from './linePoints.ts';
import type { LineSegments } from './linePoints.ts';
import type { MeshData } from './mesh.ts';
import type { ConvexShape } from '@driftengine/physics';
import type { PhysicsWorld } from '@driftengine/physics';

/**
 * Debug geometry, as line segments the renderer already knows how to draw.
 *
 * **This is the generator and not a pass**, and that is the whole reason it is small: `drawLines`
 * has shipped on both backends since the polyline batch landed, with a world-space width and a
 * pixel floor so a distant line does not strobe. What was missing was anything that turns what you
 * want to *see* — a mesh's normals, the colliders a body actually carries — into segments, so every
 * consumer who wanted a normals key wrote the geometry themselves or, far more often, did not.
 *
 * **What its absence has cost, measured rather than supposed.** One consumer wrote geometry with
 * downward normals four separate times: their roads, their ditch banks, their roof planes, and
 * every building in their world lit inside out. Each was found by looking at a screenshot and
 * wondering why tarmac was black at midday, because a flipped normal near a lamp is a dimmer
 * surface rather than an absent one and only a directional light makes it plain. A key that draws
 * normals turns each of those into a ten-second job.
 *
 * **Nothing here throws and nothing here allocates after construction.** A debug drawer that threw
 * when it ran out of room would take the frame with it at exactly the moment somebody was trying to
 * see what was wrong, which is the opposite of its job; so a segment past capacity is counted in
 * `dropped` and discarded, and a consumer who cares reads that number and builds a bigger one.
 */
export class DebugLines {
  readonly segments: LineSegments;
  private overflow = 0;

  constructor(capacity: number) {
    if (!(capacity > 0)) throw new Error(`DebugLines: capacity must be positive, got ${capacity}`);
    this.segments = createLineSegments(capacity);
  }

  /** Segments asked for since the last `clear` that there was no room for. */
  get dropped(): number {
    return this.overflow;
  }

  clear(): void {
    this.segments.count = 0;
    this.overflow = 0;
  }

  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const at = this.segments.count;
    if (at >= this.segments.capacity) {
      this.overflow++;
      return;
    }
    this.segments.from[at * 3] = ax;
    this.segments.from[at * 3 + 1] = ay;
    this.segments.from[at * 3 + 2] = az;
    this.segments.to[at * 3] = bx;
    this.segments.to[at * 3 + 1] = by;
    this.segments.to[at * 3 + 2] = bz;
    this.segments.count = at + 1;
  }

  /**
   * A spike out of every vertex along its normal.
   *
   * `stride` skips vertices, because a mesh of a hundred thousand vertices is a hundred thousand
   * segments and a screen with nothing legible on it. The default draws them all, which is right
   * for the small piece of geometry somebody is actually staring at.
   *
   * **A mesh built from flat faces has four coincident normals per quad**, so what appears is one
   * spike per corner rather than one per face, and that is the honest picture: the attribute is per
   * vertex and this draws the attribute.
   */
  normals(mesh: MeshData, length = 0.25, stride = 1): void {
    const count = mesh.positions.length / 3;
    for (let v = 0; v < count; v += stride) {
      const x = mesh.positions[v * 3] ?? 0;
      const y = mesh.positions[v * 3 + 1] ?? 0;
      const z = mesh.positions[v * 3 + 2] ?? 0;
      this.segment(
        x,
        y,
        z,
        x + (mesh.normals[v * 3] ?? 0) * length,
        y + (mesh.normals[v * 3 + 1] ?? 0) * length,
        z + (mesh.normals[v * 3 + 2] ?? 0) * length,
      );
    }
  }

  /** The twelve edges of a world-axis box. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    for (const [a, b] of BOX_EDGES) {
      this.segment(
        cx + hx * (a[0] ?? 0),
        cy + hy * (a[1] ?? 0),
        cz + hz * (a[2] ?? 0),
        cx + hx * (b[0] ?? 0),
        cy + hy * (b[1] ?? 0),
        cz + hz * (b[2] ?? 0),
      );
    }
  }

  /** Three great circles, which is a sphere as far as an eye looking for one is concerned. */
  sphere(cx: number, cy: number, cz: number, radius: number, points = 24): void {
    this.circle(cx, cy, cz, radius, 1, 0, 0, 0, 0, 1, points);
    this.circle(cx, cy, cz, radius, 1, 0, 0, 0, 1, 0, points);
    this.circle(cx, cy, cz, radius, 0, 1, 0, 0, 0, 1, points);
  }

  /**
   * A closed ring of `points` segments, in the plane the two unit vectors span.
   *
   * The basis is passed in rather than derived from an axis because every caller here already has
   * one, and deriving a perpendicular from an axis has a degenerate case that a caller with a real
   * basis does not need to think about.
   */
  circle(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    ux: number,
    uy: number,
    uz: number,
    vx: number,
    vy: number,
    vz: number,
    points = 24,
  ): void {
    let px = cx + ux * radius;
    let py = cy + uy * radius;
    let pz = cz + uz * radius;
    for (let i = 1; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;
      const c = Math.cos(angle) * radius;
      const s = Math.sin(angle) * radius;
      const nx = cx + ux * c + vx * s;
      const ny = cy + uy * c + vy * s;
      const nz = cz + uz * c + vz * s;
      this.segment(px, py, pz, nx, ny, nz);
      px = nx;
      py = ny;
      pz = nz;
    }
  }

  /**
   * One collider, placed by a body's position and orientation.
   *
   * **Dispatched on what the shape *is* rather than on a stored kind**, which is the same
   * discrimination the narrow phase makes: a `sideRadius` is a cylinder, a `triangles` is a mesh, a
   * `radius` over one point is a sphere and over two is a capsule, and anything with faces is a
   * polytope drawn along its own face loops. A shape that grows a new representation appears here
   * as its polytope hull rather than as nothing, which is the failure worth having.
   */
  shape(
    shape: ConvexShape,
    px: number,
    py: number,
    pz: number,
    qx = 0,
    qy = 0,
    qz = 0,
    qw = 1,
  ): void {
    const points = shape.vertices.length / 3;
    const at = (i: number, out: number[]): void => {
      rotate(
        shape.vertices[i * 3] ?? 0,
        shape.vertices[i * 3 + 1] ?? 0,
        shape.vertices[i * 3 + 2] ?? 0,
        qx,
        qy,
        qz,
        qw,
        out,
      );
      out[0] = (out[0] ?? 0) + px;
      out[1] = (out[1] ?? 0) + py;
      out[2] = (out[2] ?? 0) + pz;
    };

    const mesh = shape.triangles;
    if (mesh !== undefined) {
      for (let t = 0; t < mesh.triangleCount; t++) {
        for (let e = 0; e < 3; e++) {
          const i = mesh.indices[t * 3 + e] ?? 0;
          const j = mesh.indices[t * 3 + ((e + 1) % 3)] ?? 0;
          /* Each interior edge belongs to two triangles; drawing it once is the same picture at
             half the segments, which matters when the capacity is what stops the drawing. */
          if (i > j) continue;
          rotate(
            mesh.positions[i * 3] ?? 0,
            mesh.positions[i * 3 + 1] ?? 0,
            mesh.positions[i * 3 + 2] ?? 0,
            qx,
            qy,
            qz,
            qw,
            A,
          );
          rotate(
            mesh.positions[j * 3] ?? 0,
            mesh.positions[j * 3 + 1] ?? 0,
            mesh.positions[j * 3 + 2] ?? 0,
            qx,
            qy,
            qz,
            qw,
            B,
          );
          this.segment(
            (A[0] ?? 0) + px,
            (A[1] ?? 0) + py,
            (A[2] ?? 0) + pz,
            (B[0] ?? 0) + px,
            (B[1] ?? 0) + py,
            (B[2] ?? 0) + pz,
          );
        }
      }
      return;
    }

    if (points === 1) {
      at(0, A);
      this.sphere(A[0] ?? 0, A[1] ?? 0, A[2] ?? 0, shape.radius);
      return;
    }

    if (points === 2 && (shape.radius > 0 || shape.sideRadius > 0)) {
      at(0, A);
      at(1, B);
      const round = shape.sideRadius > 0 ? shape.sideRadius : shape.radius;
      basis(A, B, U, V);
      if (shape.sideRadius > 0) {
        /* A cylinder: two flat caps and a straight side, with a sharp rim between them. */
        this.circle(
          A[0] ?? 0,
          A[1] ?? 0,
          A[2] ?? 0,
          round,
          U[0] ?? 0,
          U[1] ?? 0,
          U[2] ?? 0,
          V[0] ?? 0,
          V[1] ?? 0,
          V[2] ?? 0,
        );
        this.circle(
          B[0] ?? 0,
          B[1] ?? 0,
          B[2] ?? 0,
          round,
          U[0] ?? 0,
          U[1] ?? 0,
          U[2] ?? 0,
          V[0] ?? 0,
          V[1] ?? 0,
          V[2] ?? 0,
        );
      } else {
        /* A capsule: a ball at each end, which is what its rounding actually is. */
        this.sphere(A[0] ?? 0, A[1] ?? 0, A[2] ?? 0, round);
        this.sphere(B[0] ?? 0, B[1] ?? 0, B[2] ?? 0, round);
      }
      for (const [sx, sy] of SIDE_ANGLES) {
        const ox = (U[0] ?? 0) * sx * round + (V[0] ?? 0) * sy * round;
        const oy = (U[1] ?? 0) * sx * round + (V[1] ?? 0) * sy * round;
        const oz = (U[2] ?? 0) * sx * round + (V[2] ?? 0) * sy * round;
        this.segment(
          (A[0] ?? 0) + ox,
          (A[1] ?? 0) + oy,
          (A[2] ?? 0) + oz,
          (B[0] ?? 0) + ox,
          (B[1] ?? 0) + oy,
          (B[2] ?? 0) + oz,
        );
      }
      return;
    }

    const faces = shape.faceVertexStart.length - 1;
    for (let f = 0; f < faces; f++) {
      const start = shape.faceVertexStart[f] ?? 0;
      const end = shape.faceVertexStart[f + 1] ?? 0;
      for (let k = start; k < end; k++) {
        const i = shape.faceVertexIndices[k] ?? 0;
        const j = shape.faceVertexIndices[k + 1 === end ? start : k + 1] ?? 0;
        /* Every edge is in two face loops, once each way round. Keeping the ascending one draws it
           exactly once. */
        if (i > j) continue;
        at(i, A);
        at(j, B);
        this.segment(A[0] ?? 0, A[1] ?? 0, A[2] ?? 0, B[0] ?? 0, B[1] ?? 0, B[2] ?? 0);
      }
    }
  }

  /**
   * Every body's collider in a world, where it is this tick.
   *
   * The other half of the key the report asked for. Bodies with no shape are skipped rather than
   * refused: a world may hold one for a frame while it is being built.
   */
  colliders(world: PhysicsWorld): void {
    const bodies = world.bodies;
    for (let i = 0; i < bodies.count; i++) {
      const shape = bodies.shape[i];
      if (shape === undefined) continue;
      this.shape(
        shape,
        bodies.posX[i] ?? 0,
        bodies.posY[i] ?? 0,
        bodies.posZ[i] ?? 0,
        bodies.rotX[i] ?? 0,
        bodies.rotY[i] ?? 0,
        bodies.rotZ[i] ?? 0,
        bodies.rotW[i] ?? 1,
      );
    }
  }
}

/** Scratch, at module scope because a debug frame draws thousands of these. */
const A: number[] = [0, 0, 0];
const B: number[] = [0, 0, 0];
const U: number[] = [0, 0, 0];
const V: number[] = [0, 0, 0];

/** Where the four side lines of a capsule or cylinder sit around its axis. */
const SIDE_ANGLES: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

const BOX_EDGES: readonly (readonly [readonly number[], readonly number[]])[] = (() => {
  const corners: number[][] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
  const edges: [number[], number[]][] = [];
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i] as number[];
      const b = corners[j] as number[];
      let differing = 0;
      for (let k = 0; k < 3; k++) if (a[k] !== b[k]) differing++;
      if (differing === 1) edges.push([a, b]);
    }
  }
  return edges;
})();

/** `q * v * q⁻¹`, the standard two-cross form, into `out`. */
function rotate(
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: number[],
): void {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Two unit vectors perpendicular to the segment `a → b`, and to each other.
 *
 * The perpendicular is taken against whichever world axis the segment points along least, which is
 * what stops the cross product collapsing for an axis-aligned shape — and every capsule and
 * cylinder anybody builds is axis-aligned, so the degenerate case is the common one rather than the
 * exotic one.
 */
function basis(a: number[], b: number[], u: number[], v: number[]): void {
  let ax = (b[0] ?? 0) - (a[0] ?? 0);
  let ay = (b[1] ?? 0) - (a[1] ?? 0);
  let az = (b[2] ?? 0) - (a[2] ?? 0);
  const length = Math.hypot(ax, ay, az) || 1;
  ax /= length;
  ay /= length;
  az /= length;
  const absX = Math.abs(ax);
  const absY = Math.abs(ay);
  const absZ = Math.abs(az);
  const px = absX <= absY && absX <= absZ ? 1 : 0;
  const py = absY < absX && absY <= absZ ? 1 : 0;
  const pz = px === 0 && py === 0 ? 1 : 0;
  let ux = ay * pz - az * py;
  let uy = az * px - ax * pz;
  let uz = ax * py - ay * px;
  const ulength = Math.hypot(ux, uy, uz) || 1;
  ux /= ulength;
  uy /= ulength;
  uz /= ulength;
  u[0] = ux;
  u[1] = uy;
  u[2] = uz;
  v[0] = ay * uz - az * uy;
  v[1] = az * ux - ax * uz;
  v[2] = ax * uy - ay * ux;
}

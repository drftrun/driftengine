/**
 * Boolean operations on closed solids — union, subtraction, intersection — by binary space
 * partitioning.
 *
 * The algorithm is the one Evan Wallace's csg.js made well known, implemented afresh here — named
 * at the point it is used, as `CREDITS.md` asks of a published method: each operand becomes a BSP tree of its own polygons, each tree clips the
 * other's polygons to the region it keeps, and the survivors are rebuilt into one tree. Polygons
 * carry position, normal and texture coordinates, interpolated where a plane splits them, so a cut
 * face keeps the texture of the face it was cut from.
 *
 * **Only what the other operand reaches is split.** Each tree is used for its planes alone: an
 * operand's own polygons are clipped as they arrived, never as its tree's construction cut them,
 * and a polygon whose bounds clear the other operand's is passed through whole — kept or dropped
 * as the operation says of everything outside that operand. The result is the two clipped lists
 * side by side, where the published method rebuilds one tree from them and splits the second list
 * along every plane of the first on the way. Neither changes the surface; together they are what
 * kept a wall cut five times with its end faces at two triangles each instead of eight, and a
 * city's worth of cut towers out of the millions.
 *
 * **What it gives up.** A polygon the other operand does reach is still split along every plane of
 * its tree that crosses it, and nothing is re-merged, so a heavily cut solid grows, and the pieces
 * meet with T-junctions: closed as a surface — its volume exact — but not edge for edge. Welding
 * and simplification are the caller's afterwards. The tree is built iteratively, so a large
 * operand cannot overflow the stack; clipping recurses to the tree's depth, which a solid of a few
 * thousand faces keeps shallow.
 *
 * **Empty operands are answered before any tree is built**, because clipping against an empty tree
 * keeps everything — which is the right answer for a union and the wrong one for an intersection.
 */
import type { Solid } from './solid.ts';
import { emptySolid } from './solid.ts';
import { SolidWriter } from './solidWriter.ts';

/** Distance within which a point counts as on a plane. */
const EPSILON = 1e-5;

interface Vertex {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
}

interface Plane {
  nx: number;
  ny: number;
  nz: number;
  w: number;
}

interface Polygon {
  vertices: Vertex[];
  plane: Plane;
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

function planeFrom(a: Vertex, b: Vertex, c: Vertex): Plane | null {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  nx /= len;
  ny /= len;
  nz /= len;
  return { nx, ny, nz, w: nx * a.x + ny * a.y + nz * a.z };
}

function flipPolygon(p: Polygon): Polygon {
  const vertices = p.vertices
    .slice()
    .reverse()
    .map((v) => ({ ...v, nx: -v.nx, ny: -v.ny, nz: -v.nz }));
  return { vertices, plane: { nx: -p.plane.nx, ny: -p.plane.ny, nz: -p.plane.nz, w: -p.plane.w } };
}

function lerp(a: Vertex, b: Vertex, t: number): Vertex {
  let nx = a.nx + (b.nx - a.nx) * t;
  let ny = a.ny + (b.ny - a.ny) * t;
  let nz = a.nz + (b.nz - a.nz) * t;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    nx,
    ny,
    nz,
    u: a.u + (b.u - a.u) * t,
    v: a.v + (b.v - a.v) * t,
  };
}

/**
 * Sort `polygon` against `plane` into the four lists, splitting it where it spans. A coplanar
 * polygon goes to the front list when it faces the same way as the plane, the back one otherwise.
 */
function split(
  plane: Plane,
  polygon: Polygon,
  coplanarFront: Polygon[],
  coplanarBack: Polygon[],
  front: Polygon[],
  back: Polygon[],
): void {
  let kind = 0;
  const types: number[] = [];
  for (const v of polygon.vertices) {
    const t = plane.nx * v.x + plane.ny * v.y + plane.nz * v.z - plane.w;
    const type = t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
    kind |= type;
    types.push(type);
  }
  if (kind === COPLANAR) {
    const facing =
      plane.nx * polygon.plane.nx + plane.ny * polygon.plane.ny + plane.nz * polygon.plane.nz;
    (facing > 0 ? coplanarFront : coplanarBack).push(polygon);
  } else if (kind === FRONT) {
    front.push(polygon);
  } else if (kind === BACK) {
    back.push(polygon);
  } else if (kind === SPANNING) {
    const f: Vertex[] = [];
    const b: Vertex[] = [];
    const n = polygon.vertices.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ti = types[i] ?? COPLANAR;
      const tj = types[j] ?? COPLANAR;
      const vi = polygon.vertices[i];
      const vj = polygon.vertices[j];
      if (!vi || !vj) continue;
      if (ti !== BACK) f.push(vi);
      if (ti !== FRONT) b.push(vi);
      if ((ti | tj) === SPANNING) {
        const di = plane.nx * vi.x + plane.ny * vi.y + plane.nz * vi.z;
        const dj = plane.nx * vj.x + plane.ny * vj.y + plane.nz * vj.z;
        const t = (plane.w - di) / (dj - di);
        const mid = lerp(vi, vj, t);
        f.push(mid);
        b.push({ ...mid });
      }
    }
    if (f.length >= 3) front.push({ vertices: f, plane: polygon.plane });
    if (b.length >= 3) back.push({ vertices: b, plane: polygon.plane });
  }
}

/** A BSP tree of an operand's planes. Its polygons only choose the planes and are not kept. */
class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;

  /** Add `polygons`' planes to the tree, splitting down it, without recursion. */
  build(polygons: Polygon[]): void {
    const work: [Node, Polygon[]][] = [[this, polygons]];
    const coplanar: Polygon[] = [];
    while (work.length > 0) {
      const item = work.pop();
      if (!item) break;
      const [node, list] = item;
      if (list.length === 0) continue;
      const first = list[0];
      if (!node.plane && first) node.plane = { ...first.plane };
      const plane = node.plane;
      if (!plane) continue;
      const f: Polygon[] = [];
      const b: Polygon[] = [];
      for (const p of list) split(plane, p, coplanar, coplanar, f, b);
      coplanar.length = 0;
      if (f.length > 0) {
        node.front ??= new Node();
        work.push([node.front, f]);
      }
      if (b.length > 0) {
        node.back ??= new Node();
        work.push([node.back, b]);
      }
    }
  }

  /** Turn the tree inside out: every plane reversed, front and back swapped. */
  invert(): Node {
    const stack: Node[] = [this];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) break;
      if (node.plane) {
        node.plane = {
          nx: -node.plane.nx,
          ny: -node.plane.ny,
          nz: -node.plane.nz,
          w: -node.plane.w,
        };
      }
      const f = node.front;
      node.front = node.back;
      node.back = f;
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
    return this;
  }

  /** The parts of `polygons` outside this tree's solid. */
  clipPolygons(polygons: Polygon[]): Polygon[] {
    if (!this.plane) return polygons.slice();
    let f: Polygon[] = [];
    let b: Polygon[] = [];
    for (const p of polygons) split(this.plane, p, f, b, f, b);
    if (this.front) f = this.front.clipPolygons(f);
    b = this.back ? this.back.clipPolygons(b) : [];
    return f.concat(b);
  }
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

function boundsOf(polygons: readonly Polygon[]): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of polygons) {
    for (const v of p.vertices) {
      if (v.x < min[0]) min[0] = v.x;
      if (v.y < min[1]) min[1] = v.y;
      if (v.z < min[2]) min[2] = v.z;
      if (v.x > max[0]) max[0] = v.x;
      if (v.y > max[1]) max[1] = v.y;
      if (v.z > max[2]) max[2] = v.z;
    }
  }
  return { min, max };
}

/**
 * `polygons` split into those that may meet `bounds` and those clear of it by more than the plane
 * tolerance on some axis — which are outside the solid `bounds` encloses, with no tree to ask.
 */
function partition(polygons: readonly Polygon[], bounds: Bounds): [Polygon[], Polygon[]] {
  const near: Polygon[] = [];
  const clear: Polygon[] = [];
  const { min, max } = bounds;
  for (const p of polygons) {
    let lx = Infinity;
    let ly = Infinity;
    let lz = Infinity;
    let hx = -Infinity;
    let hy = -Infinity;
    let hz = -Infinity;
    for (const v of p.vertices) {
      lx = Math.min(lx, v.x);
      ly = Math.min(ly, v.y);
      lz = Math.min(lz, v.z);
      hx = Math.max(hx, v.x);
      hy = Math.max(hy, v.y);
      hz = Math.max(hz, v.z);
    }
    const apart =
      hx < min[0] - EPSILON ||
      hy < min[1] - EPSILON ||
      hz < min[2] - EPSILON ||
      lx > max[0] + EPSILON ||
      ly > max[1] + EPSILON ||
      lz > max[2] + EPSILON;
    (apart ? clear : near).push(p);
  }
  return [near, clear];
}

const flipAll = (polygons: readonly Polygon[]): Polygon[] => polygons.map(flipPolygon);

function toPolygons(solid: Solid): Polygon[] {
  const out: Polygon[] = [];
  const p = solid.positions;
  const n = solid.normals;
  const uv = solid.uvs;
  const vertex = (i: number): Vertex => ({
    x: p[i * 3] ?? 0,
    y: p[i * 3 + 1] ?? 0,
    z: p[i * 3 + 2] ?? 0,
    nx: n[i * 3] ?? 0,
    ny: n[i * 3 + 1] ?? 0,
    nz: n[i * 3 + 2] ?? 0,
    u: uv[i * 2] ?? 0,
    v: uv[i * 2 + 1] ?? 0,
  });
  for (let t = 0; t < solid.indices.length; t += 3) {
    const a = vertex(solid.indices[t] ?? 0);
    const b = vertex(solid.indices[t + 1] ?? 0);
    const c = vertex(solid.indices[t + 2] ?? 0);
    const plane = planeFrom(a, b, c);
    if (plane) out.push({ vertices: [a, b, c], plane });
  }
  return out;
}

/** Polygons back to a solid, each fanned from its first corner — they are convex. */
function fromPolygons(polygons: Polygon[]): Solid {
  const out = new SolidWriter();
  for (const polygon of polygons) {
    const base = out.vertexCount;
    for (const v of polygon.vertices) out.vertex(v.x, v.y, v.z, v.nx, v.ny, v.nz, v.u, v.v);
    for (let i = 1; i + 1 < polygon.vertices.length; i++)
      out.triangle(base, base + i, base + i + 1);
  }
  return out.finish();
}

function tree(polygons: Polygon[]): Node {
  const node = new Node();
  node.build(polygons);
  return node;
}

const isEmpty = (s: Solid): boolean => s.indices.length === 0;

/**
 * Both operands' polygons, each split by the other's bounds. The three operations below are the
 * published method's steps written over these lists, with the clear polygons settled by the rule
 * each operation applies to everything outside the other operand.
 */
function operands(a: Solid, b: Solid) {
  const pa = toPolygons(a);
  const pb = toPolygons(b);
  const [aNear, aClear] = partition(pa, boundsOf(pb));
  const [bNear, bClear] = partition(pb, boundsOf(pa));
  return { pa, pb, aNear, aClear, bNear, bClear };
}

/** Everything inside either solid. */
export function solidUnion(a: Solid, b: Solid): Solid {
  if (isEmpty(b)) return a;
  if (isEmpty(a)) return b;
  const { pa, pb, aNear, aClear, bNear, bClear } = operands(a, b);
  const ta = tree(pa);
  const aKept = tree(pb).clipPolygons(aNear);
  /* B outside A, then without the faces lying on A's facing the same way, which A already has. */
  const bKept = flipAll(ta.clipPolygons(flipAll(ta.clipPolygons(bNear))));
  return fromPolygons([...aClear, ...aKept, ...bClear, ...bKept]);
}

/** Everything inside `a` and outside `b`. */
export function solidSubtract(a: Solid, b: Solid): Solid {
  if (isEmpty(a)) return emptySolid();
  if (isEmpty(b)) return a;
  const { pa, pb, aNear, aClear, bNear } = operands(a, b);
  const outside = tree(pa).invert();
  const aKept = flipAll(tree(pb).clipPolygons(flipAll(aNear)));
  /* B inside A, turned to face into the cavity it leaves. */
  const bKept = outside.clipPolygons(flipAll(outside.clipPolygons(bNear)));
  return fromPolygons([...aClear, ...aKept, ...bKept]);
}

/** Everything inside both solids. */
export function solidIntersect(a: Solid, b: Solid): Solid {
  if (isEmpty(a) || isEmpty(b)) return emptySolid();
  const { pa, pb, aNear, bNear } = operands(a, b);
  const outsideA = tree(pa).invert();
  const outsideB = tree(pb).invert();
  const aKept = flipAll(outsideB.clipPolygons(flipAll(aNear)));
  const bKept = flipAll(outsideA.clipPolygons(flipAll(outsideA.clipPolygons(bNear))));
  return fromPolygons([...aKept, ...bKept]);
}

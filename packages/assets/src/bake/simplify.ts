/**
 * A textured mesh brought down to the triangles its shape needs, at bake time, within a distance.
 *
 * **A bought scene is modelled for a renderer that is not in a hurry.** A courtyard measured here
 * holds two million triangles of curtain, five million of ivy leaf and fifteen hundred a candle: at
 * 4K a triangle of that cloth covers two pixels, and a GPU shades whole 2 × 2 quads, so most of the
 * work is shading pixels nobody sees, in every shadow pass and every probe face as well as the frame.
 *
 * **Quadric error, half-edge collapses, and a hard bound.** Each vertex carries the planes of the
 * faces around it, and a collapse is costed by the mean squared distance the moving vertex's planes
 * are from where it lands, so a flat stretch goes first and a fold holds (Garland and Heckbert). The
 * vertex moves onto a neighbour rather than to an optimal point, so every vertex that is left is one
 * the author placed, with the normal, uv, colour and tangent they gave it: nothing is interpolated,
 * and a texture stays where it was painted. Nothing collapses once the cheapest collapse would move
 * the surface further than `maxError`.
 *
 * **What is held.** A vertex that shares its place with another is on a uv seam or a hard edge, and
 * moving either copy opens the seam, so both stay. An open border simplifies only along itself,
 * costed by planes standing on its edges, so a leaf keeps its outline to the same bound. A collapse
 * that turns a face more than about seventy degrees, folds the texture over, stretches it more than
 * half again, or joins two vertices whose normals part by more than twenty-five degrees is refused,
 * and so is one after which a vertex taken in, by it or any collapse before, no longer finds its own
 * uv on the surface that is left (`collapseMeasures.ts` measures both). A mesh with joints or morph
 * targets comes back as it went in: a vertex there is a promise to a rig.
 *
 * **What it gives up** is a better placed vertex at the same count, which a full-edge collapse to
 * the quadric's minimum would find, at the price of interpolating every attribute. What would make
 * it wrong is a model whose detail is in its geometry rather than its maps at the scale of the bound.
 */
import type { MeshData } from '@driftengine/drft';
import { keepVertices } from '../weld.ts';
import { CollapseHeap } from './collapseHeap.ts';
import {
  addBorderPlanes,
  addFacePlanes,
  edgeKey,
  quadricAt,
  triangleNormal,
  uvArea,
  uvMiss,
} from './collapseMeasures.ts';

export interface SimplifyOptions {
  /** The furthest the surface may move, in the mesh's units: metres, for a baked scene. */
  readonly maxError: number;
  /**
   * The furthest a texture may slide under the surface, in uv units: a texel of a 1,024 map by
   * default. Checked at every vertex a collapse has removed, so it cannot accumulate.
   */
  readonly maxUvError?: number;
  /** Stop once this share of the triangles is left, whatever the error. 0 by default. */
  readonly minRatio?: number;
}

/** The most a collapse may turn a face: cos 70°. */
const MIN_FACE_TURN = 0.34;
/** The widest two shading normals a collapse may join: cos 25°. */
const MIN_NORMAL_AGREEMENT = 0.906;
/** How far a face's texture may stretch or shrink, as a ratio of its uv area to its area. */
const MAX_UV_STRETCH = 1.5;
/** A texel of a 1,024 map. */
const DEFAULT_MAX_UV_ERROR = 1 / 1024;

export function simplifyMesh(mesh: MeshData, options: SimplifyOptions): MeshData {
  if (mesh.joints !== undefined || mesh.weights !== undefined || mesh.morphTargets !== undefined) {
    return mesh;
  }
  const faceCount = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  if (faceCount === 0) return mesh;
  const s = new Simplifier(mesh, options.maxError, options.maxUvError ?? DEFAULT_MAX_UV_ERROR);
  const floor = Math.ceil(faceCount * Math.max(0, Math.min(1, options.minRatio ?? 0)));
  s.run(floor);
  if (s.alive === faceCount) return mesh;
  return s.output(vertexCount);
}

class Simplifier {
  private readonly mesh: MeshData;
  private readonly maxCost: number;
  private readonly p: Float64Array;
  private readonly faces: Uint32Array;
  private readonly faceAlive: Uint8Array;
  private readonly facesOf: number[][];
  private readonly quadric: Float64Array;
  private readonly area: Float64Array;
  private readonly locked: Uint8Array;
  private readonly removed: Uint8Array;
  private readonly version: Uint32Array;
  /** The vertices each survivor has taken in, whose painted uvs every later collapse must keep. */
  private readonly absorbed: number[][];
  private readonly maxUvError: number;
  private readonly heap = new CollapseHeap();
  alive: number;

  constructor(mesh: MeshData, maxError: number, maxUvError: number) {
    this.mesh = mesh;
    this.maxCost = maxError * maxError;
    this.maxUvError = maxUvError;
    const v = mesh.positions.length / 3;
    this.p = Float64Array.from(mesh.positions);
    this.faces = Uint32Array.from(mesh.indices);
    const f = this.faces.length / 3;
    this.alive = f;
    this.faceAlive = new Uint8Array(f).fill(1);
    this.facesOf = Array.from({ length: v }, () => []);
    this.quadric = new Float64Array(v * 10);
    this.area = new Float64Array(v);
    this.locked = new Uint8Array(v);
    this.removed = new Uint8Array(v);
    this.version = new Uint32Array(v);
    this.absorbed = Array.from({ length: v }, () => []);
    for (let face = 0; face < f; face++) {
      for (let k = 0; k < 3; k++)
        (this.facesOf[this.faces[face * 3 + k] as number] as number[]).push(face);
    }
    const edges = countEdges(this.faces, v);
    this.lockShared(edges);
    addFacePlanes(this.p, this.faces, this.quadric, this.area);
    addBorderPlanes(this.p, this.faces, edges, this.quadric);
    for (let u = 0; u < v; u++) this.consider(u);
  }

  /** Every vertex that shares its place with another, and both ends of an edge three faces share. */
  private lockShared(edges: ReadonlyMap<number, number>): void {
    const v = this.p.length / 3;
    const bits = new Float32Array(
      this.mesh.positions.buffer,
      this.mesh.positions.byteOffset,
      v * 3,
    );
    const words = new Uint32Array(bits.buffer, bits.byteOffset, v * 3);
    const first = new Map<string, number>();
    for (let u = 0; u < v; u++) {
      const key = `${words[u * 3]},${words[u * 3 + 1]},${words[u * 3 + 2]}`;
      const seen = first.get(key);
      if (seen === undefined) first.set(key, u);
      else {
        this.locked[u] = 1;
        this.locked[seen] = 1;
      }
    }
    for (const [key, count] of edges) {
      if (count <= 2) continue;
      this.locked[Math.floor(key / v)] = 1;
      this.locked[key % v] = 1;
    }
  }

  /** The alive faces around `u`, in order, without the dead ones it still lists. */
  private around(u: number): number[] {
    const list = this.facesOf[u] as number[];
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const face = list[i] as number;
      if (this.faceAlive[face] === 1 && this.hasVertex(face, u)) list[write++] = face;
    }
    list.length = write;
    return list;
  }

  private hasVertex(face: number, u: number): boolean {
    return (
      this.faces[face * 3] === u || this.faces[face * 3 + 1] === u || this.faces[face * 3 + 2] === u
    );
  }

  /** How many alive faces hold the edge `a`–`b`. */
  private edgeFaces(a: number, b: number): number {
    let n = 0;
    for (const face of this.around(a)) if (this.hasVertex(face, b)) n++;
    return n;
  }

  /** The best collapse of `u` onto a neighbour, pushed on the heap under `u`'s current version. */
  private consider(u: number): void {
    if (this.removed[u] === 1 || this.locked[u] === 1) return;
    const faces = this.around(u);
    if (faces.length === 0) return;
    /* A border vertex moves only along its border, and only if it has exactly two border edges. */
    const neighbours: number[] = [];
    const borderNeighbours: number[] = [];
    for (const face of faces) {
      for (let k = 0; k < 3; k++) {
        const w = this.faces[face * 3 + k] as number;
        if (w === u || neighbours.includes(w)) continue;
        neighbours.push(w);
        if (this.edgeFaces(u, w) === 1) borderNeighbours.push(w);
      }
    }
    if (borderNeighbours.length !== 0 && borderNeighbours.length !== 2) return;
    const candidates = borderNeighbours.length === 2 ? borderNeighbours : neighbours;
    let best = -1;
    let bestCost = Infinity;
    for (const v of candidates) {
      const cost = this.cost(u, v);
      if (cost >= bestCost || cost > this.maxCost) continue;
      if (!this.valid(u, v, faces)) continue;
      best = v;
      bestCost = cost;
    }
    if (best >= 0) this.heap.push(bestCost, u, best, this.version[u] as number);
  }

  /** The mean squared distance from both vertices' planes to where `u` lands, at `v`. */
  private cost(u: number, v: number): number {
    const x = this.p[v * 3]!;
    const y = this.p[v * 3 + 1]!;
    const z = this.p[v * 3 + 2]!;
    const sum = quadricAt(this.quadric, u, x, y, z) + quadricAt(this.quadric, v, x, y, z);
    return Math.max(0, sum) / Math.max(this.area[u]! + this.area[v]!, 1e-30);
  }

  private valid(u: number, v: number, faces: readonly number[]): boolean {
    if (this.removed[v] === 1) return false;
    const normals = this.mesh.normals;
    const agree =
      normals[u * 3]! * normals[v * 3]! +
      normals[u * 3 + 1]! * normals[v * 3 + 1]! +
      normals[u * 3 + 2]! * normals[v * 3 + 2]!;
    if (agree < MIN_NORMAL_AGREEMENT) return false;
    if (!this.linkHolds(u, v, faces)) return false;
    const before = [0, 0, 0];
    const after = [0, 0, 0];
    const uvs = this.mesh.uvs;
    for (const face of faces) {
      if (this.hasVertex(face, v)) continue;
      const a = this.faces[face * 3] as number;
      const b = this.faces[face * 3 + 1] as number;
      const c = this.faces[face * 3 + 2] as number;
      const areaBefore = triangleNormal(this.p, a, b, c, before);
      const areaAfter = triangleNormal(
        this.p,
        a === u ? v : a,
        b === u ? v : b,
        c === u ? v : c,
        after,
      );
      if (areaAfter <= areaBefore * 1e-6) return false;
      const turn = before[0]! * after[0]! + before[1]! * after[1]! + before[2]! * after[2]!;
      if (turn < MIN_FACE_TURN) return false;
      if (uvs !== undefined && areaBefore > 0) {
        const uvBefore = uvArea(uvs, a, b, c);
        const uvAfter = uvArea(uvs, a === u ? v : a, b === u ? v : b, c === u ? v : c);
        if (uvBefore !== 0 && Math.sign(uvBefore) !== Math.sign(uvAfter)) return false;
        const stretch =
          Math.abs(uvAfter) / areaAfter / Math.max(Math.abs(uvBefore) / areaBefore, 1e-30);
        if (uvBefore !== 0 && (stretch > MAX_UV_STRETCH || stretch < 1 / MAX_UV_STRETCH))
          return false;
      }
    }
    return uvs === undefined || this.texturesHold(u, v, faces, uvs);
  }

  /**
   * Whether every vertex the collapse leaves behind, `u` and all it and `v` have taken in, still finds
   * its own uv on the surface that is left: interpolated by the face it lies over, within
   * `maxUvError`. The per-face checks above see only corners, and a curved mapping can pass them
   * collapse by collapse while the texture slides a long way; this is measured against what was
   * painted, so it cannot accumulate.
   */
  private texturesHold(u: number, v: number, faces: readonly number[], uvs: Float32Array): boolean {
    const after: number[] = [];
    for (const face of faces) {
      if (this.hasVertex(face, v)) continue;
      for (let k = 0; k < 3; k++) {
        const w = this.faces[face * 3 + k] as number;
        after.push(w === u ? v : w);
      }
    }
    for (const face of this.around(v)) {
      if (this.hasVertex(face, u)) continue;
      for (let k = 0; k < 3; k++) after.push(this.faces[face * 3 + k] as number);
    }
    if (after.length === 0) return false;
    const samples = [u, ...(this.absorbed[u] as number[]), ...(this.absorbed[v] as number[])];
    for (const sample of samples) {
      if (uvMiss(this.p, uvs, after, sample) > this.maxUvError) return false;
    }
    return true;
  }

  /**
   * The link condition: the neighbours `u` and `v` share are exactly the far corners of the faces
   * they share. Otherwise the collapse pinches the surface into a fin or a non-manifold edge.
   *
   * No test here isolates it: every pinch built for one also folded a face, which the check before
   * it refuses. It stays as the standard guard for a closed surface, where that need not hold.
   */
  private linkHolds(u: number, v: number, faces: readonly number[]): boolean {
    const opposite: number[] = [];
    const ofU: number[] = [];
    for (const face of faces) {
      const shared = this.hasVertex(face, v);
      for (let k = 0; k < 3; k++) {
        const w = this.faces[face * 3 + k] as number;
        if (w === u || w === v) continue;
        if (shared) opposite.push(w);
        if (!ofU.includes(w)) ofU.push(w);
      }
    }
    for (const face of this.around(v)) {
      for (let k = 0; k < 3; k++) {
        const w = this.faces[face * 3 + k] as number;
        if (w === u || w === v) continue;
        if (ofU.includes(w) && !opposite.includes(w)) return false;
      }
    }
    return opposite.length > 0;
  }

  run(floor: number): void {
    const heap = this.heap;
    while (heap.size > 0 && this.alive > floor) {
      const cost = heap.topCost();
      if (cost > this.maxCost) break;
      const { u, v, version } = heap.pop();
      if (version !== this.version[u] || this.removed[u] === 1 || this.removed[v] === 1) continue;
      const faces = this.around(u);
      /* The world may have moved under a queued collapse; ask again before making it. */
      if (!this.valid(u, v, faces)) {
        this.version[u] = this.version[u]! + 1;
        this.consider(u);
        continue;
      }
      this.collapse(u, v, faces);
    }
  }

  private collapse(u: number, v: number, faces: readonly number[]): void {
    this.removed[u] = 1;
    const toV = this.facesOf[v] as number[];
    for (const face of faces) {
      if (this.hasVertex(face, v)) {
        this.faceAlive[face] = 0;
        this.alive--;
        continue;
      }
      for (let k = 0; k < 3; k++) if (this.faces[face * 3 + k] === u) this.faces[face * 3 + k] = v;
      toV.push(face);
    }
    for (let k = 0; k < 10; k++)
      this.quadric[v * 10 + k] = this.quadric[v * 10 + k]! + this.quadric[u * 10 + k]!;
    this.area[v] = this.area[v]! + this.area[u]!;
    (this.absorbed[v] as number[]).push(u, ...(this.absorbed[u] as number[]));
    (this.absorbed[u] as number[]).length = 0;
    (this.facesOf[u] as number[]).length = 0;
    /* Everything whose best move could have changed: `v` and every vertex round it. */
    const touched: number[] = [v];
    for (const face of this.around(v)) {
      for (let k = 0; k < 3; k++) {
        const w = this.faces[face * 3 + k] as number;
        if (!touched.includes(w)) touched.push(w);
      }
    }
    for (const w of touched) {
      this.version[w] = this.version[w]! + 1;
      this.consider(w);
    }
  }

  output(vertexCount: number): MeshData {
    const keep = new Int32Array(vertexCount).fill(-1);
    const indices = new Uint32Array(this.alive * 3);
    let count = 0;
    let at = 0;
    const f = this.faces.length / 3;
    for (let face = 0; face < f; face++) {
      if (this.faceAlive[face] !== 1) continue;
      for (let k = 0; k < 3; k++) {
        const old = this.faces[face * 3 + k] as number;
        if (keep[old] === -1) keep[old] = count++;
        indices[at++] = keep[old] as number;
      }
    }
    return keepVertices(this.mesh, keep, count, indices);
  }
}

/** How many faces hold each edge, keyed by `edgeKey`. */
function countEdges(faces: Uint32Array, v: number): Map<number, number> {
  const edges = new Map<number, number>();
  const f = faces.length / 3;
  for (let face = 0; face < f; face++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(
        faces[face * 3 + k] as number,
        faces[face * 3 + ((k + 1) % 3)] as number,
        v,
      );
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges;
}

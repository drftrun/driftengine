/**
 * A `.blend` mesh as triangle primitives, one per material slot, in glTF's conventions.
 *
 * **The same conversion serves every route out of a `.blend`.** `blendGltf.ts` writes these into a
 * glTF document for `readModel`, and a bake that keeps a world's instancing calls this once per
 * distinct mesh rather than once per object. So what a corner becomes — its position turned Y up,
 * its UV flipped to glTF's origin, its colour linear — is decided here and nowhere else.
 *
 * **Vertices are shared where every attribute agrees exactly**, which is how Blender's exporter
 * builds them, found by walking the exported copies of each source vertex rather than by hashing,
 * so a fifty-million-corner city costs a scan rather than fifty million string keys.
 *
 * **Faces are triangulated as Blender does it**: a quad split from its first corner, an ngon by ear
 * clipping in its own plane. Blender clips ears in a different order, so an ngon's diagonals can
 * differ from Blender's; on a planar face that changes no pixel, on a bent one it changes the bend.
 */

import type { BlendMeshData } from './blendMesh.ts';
import { POINT } from './blendMesh.ts';
import { faceNormals } from './blendNormals.ts';

/** What a material slot asks of the geometry that wears it. */
export interface SlotNeeds {
  /** Which colour attribute to carry as `COLOR_0`: a name, `''` for the render one, or null. */
  readonly vertexColor: string | null;
  /** Which UV map to carry as `TEXCOORD_0`, by name, or null for the render map. */
  readonly uvMap: string | null;
  /** A 3x3 affine transform applied to that map in Blender's UV space, or null. */
  readonly uvTransform: readonly number[] | null;
}

export interface BlendPrimitive {
  /** The material slot, or -1 where the object has none. */
  readonly slot: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array | null;
  readonly colors: Float32Array | null;
  readonly indices: Uint32Array;
  /** The source vertex each exported vertex came from, for shape keys and weights. */
  readonly sourceVertex: Int32Array;
  /** The source corner each exported vertex first came from, for per-corner shape normals. */
  readonly sourceCorner: Int32Array;
}

/** Blender Z up to glTF Y up: (x, y, z) becomes (x, z, -y). */
export function toYUp(out: Float32Array, at: number, x: number, y: number, z: number): void {
  out[at] = x;
  out[at + 1] = z;
  out[at + 2] = -y;
}

/** Triangles of one face, as corner indices, appended to `out`. */
export function triangulateFace(
  mesh: BlendMeshData,
  face: number,
  normal: readonly number[],
  out: number[],
): void {
  const start = mesh.faceOffsets[face] as number;
  const end = mesh.faceOffsets[face + 1] as number;
  const n = end - start;
  if (n < 3) return;
  if (n === 3) {
    out.push(start, start + 1, start + 2);
    return;
  }
  if (n === 4) {
    out.push(start, start + 1, start + 2, start, start + 2, start + 3);
    return;
  }
  /* Project onto the face's plane, then clip ears. */
  const [nx, ny, nz] = normal as [number, number, number];
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  const drop = az >= ax && az >= ay ? 2 : ax >= ay ? 0 : 1;
  const flip = (drop === 2 ? nz : drop === 0 ? nx : ny) < 0;
  const p = mesh.positions;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let c = start; c < end; c++) {
    const v = (mesh.cornerVerts[c] as number) * 3;
    /* The two axes left after dropping one, in right-handed order: (y, z), (z, x) or (x, y). */
    const a = p[v + ((drop + 1) % 3)] as number;
    const b = p[v + ((drop + 2) % 3)] as number;
    xs.push(flip ? b : a);
    ys.push(flip ? a : b);
  }
  const ring = Array.from({ length: n }, (_, i) => i);
  const cross = (i: number, j: number, k: number): number =>
    ((xs[j] as number) - (xs[i] as number)) * ((ys[k] as number) - (ys[i] as number)) -
    ((ys[j] as number) - (ys[i] as number)) * ((xs[k] as number) - (xs[i] as number));
  const inside = (i: number, j: number, k: number, q: number): boolean =>
    cross(i, j, q) >= 0 && cross(j, k, q) >= 0 && cross(k, i, q) >= 0;
  let guard = 0;
  while (ring.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let r = 0; r < ring.length; r++) {
      const i = ring[(r + ring.length - 1) % ring.length] as number;
      const j = ring[r] as number;
      const k = ring[(r + 1) % ring.length] as number;
      if (cross(i, j, k) <= 0) continue;
      let blocked = false;
      for (const q of ring) {
        if (q !== i && q !== j && q !== k && inside(i, j, k, q)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push(start + i, start + j, start + k);
      ring.splice(r, 1);
      clipped = true;
      break;
    }
    /* A face too bent or degenerate to clip: fan the rest, which is what remains drawable. */
    if (!clipped) break;
  }
  for (let r = 1; r + 1 < ring.length; r++)
    out.push(
      start + (ring[0] as number),
      start + (ring[r] as number),
      start + (ring[r + 1] as number),
    );
}

/** Split a mesh into one primitive per material slot it uses. */
export function meshPrimitives(
  mesh: BlendMeshData,
  normals: Float32Array,
  slots: number,
  needs: (slot: number) => SlotNeeds,
): BlendPrimitive[] {
  const faces = mesh.faceOffsets.length - 1;
  const face = faceNormals(mesh);
  const bySlot = new Map<number, number[]>();
  for (let f = 0; f < faces; f++) {
    const raw = mesh.materialIndex === null ? 0 : (mesh.materialIndex[f] as number);
    const slot = slots === 0 ? -1 : Math.max(0, Math.min(slots - 1, raw));
    let list = bySlot.get(slot);
    if (list === undefined) bySlot.set(slot, (list = []));
    list.push(f);
  }
  const out: BlendPrimitive[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const need = slot < 0 ? { vertexColor: null, uvMap: null, uvTransform: null } : needs(slot);
    const corners: number[] = [];
    for (const f of bySlot.get(slot) as number[])
      triangulateFace(
        mesh,
        f,
        [face[f * 3] as number, face[f * 3 + 1] as number, face[f * 3 + 2] as number],
        corners,
      );
    out.push(build(mesh, normals, slot, need, corners));
  }
  return out;
}

function uvLayer(mesh: BlendMeshData, name: string | null): Float32Array | null {
  if (mesh.uvs.length === 0) return null;
  const found = name === null ? -1 : mesh.uvs.findIndex((u) => u.name === name);
  return (mesh.uvs[found >= 0 ? found : mesh.renderUv] ?? mesh.uvs[0])?.uv ?? null;
}

function colorLayer(
  mesh: BlendMeshData,
  name: string | null,
): BlendMeshData['colors'][number] | null {
  if (name === null || mesh.colors.length === 0) return null;
  const found = name === '' ? -1 : mesh.colors.findIndex((c) => c.name === name);
  return mesh.colors[found >= 0 ? found : mesh.renderColor] ?? null;
}

function build(
  mesh: BlendMeshData,
  normals: Float32Array,
  slot: number,
  need: SlotNeeds,
  corners: number[],
): BlendPrimitive {
  const uv = uvLayer(mesh, need.uvMap);
  const color = colorLayer(mesh, need.vertexColor);
  const t = need.uvTransform;
  const verts = mesh.positions.length / 3;
  /* Exported copies of each source vertex, as a chain: head per vertex, next per copy. */
  const head = new Int32Array(verts).fill(-1);
  const next: number[] = [];
  const corner: number[] = [];
  const source: number[] = [];
  const indices = new Uint32Array(corners.length);
  const same = (a: number, b: number): boolean => {
    for (let k = 0; k < 3; k++) if (normals[a * 3 + k] !== normals[b * 3 + k]) return false;
    if (uv !== null) for (let k = 0; k < 2; k++) if (uv[a * 2 + k] !== uv[b * 2 + k]) return false;
    if (color !== null && color.domain !== POINT)
      for (let k = 0; k < 4; k++) if (color.rgba[a * 4 + k] !== color.rgba[b * 4 + k]) return false;
    return true;
  };
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i] as number;
    const v = mesh.cornerVerts[c] as number;
    let found = -1;
    for (let e = head[v] as number; e >= 0; e = next[e] as number) {
      if (same(corner[e] as number, c)) {
        found = e;
        break;
      }
    }
    if (found < 0) {
      found = corner.length;
      corner.push(c);
      source.push(v);
      next.push(head[v] as number);
      head[v] = found;
    }
    indices[i] = found;
  }
  const count = corner.length;
  const positions = new Float32Array(count * 3);
  const outNormals = new Float32Array(count * 3);
  const uvs = uv === null ? null : new Float32Array(count * 2);
  const colors = color === null ? null : new Float32Array(count * 4);
  const p = mesh.positions;
  for (let e = 0; e < count; e++) {
    const c = corner[e] as number;
    const v = source[e] as number;
    toYUp(positions, e * 3, p[v * 3] as number, p[v * 3 + 1] as number, p[v * 3 + 2] as number);
    toYUp(
      outNormals,
      e * 3,
      normals[c * 3] as number,
      normals[c * 3 + 1] as number,
      normals[c * 3 + 2] as number,
    );
    if (uvs !== null) {
      let u = uv?.[c * 2] as number;
      let w = uv?.[c * 2 + 1] as number;
      if (t !== null) {
        const tu = (t[0] as number) * u + (t[3] as number) * w + (t[6] as number);
        const tv = (t[1] as number) * u + (t[4] as number) * w + (t[7] as number);
        u = tu;
        w = tv;
      }
      uvs[e * 2] = u;
      uvs[e * 2 + 1] = 1 - w;
    }
    if (colors !== null && color !== null) {
      const at = color.domain === POINT ? v : c;
      for (let k = 0; k < 4; k++) colors[e * 4 + k] = color.rgba[at * 4 + k] as number;
    }
  }
  return {
    slot,
    positions,
    normals: outNormals,
    uvs,
    colors,
    indices,
    sourceVertex: Int32Array.from(source),
    sourceCorner: Int32Array.from(corner),
  };
}

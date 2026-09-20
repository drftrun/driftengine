/**
 * A captured mesh cut into surfaces, by its geometry alone.
 *
 * **This is what a consumer with no weights gets, and it is not a degraded version of anything.**
 * Connected runs of triangles that share a plane find a room's floor, its walls and the top of a
 * table without knowing what any of them *is* — which is most of what a scene needs to be useful,
 * and is available to every build where a licence does not permit shipping a model. `masks.ts` is
 * the other source of regions, not the real one.
 *
 * **Deterministic.** A mesh segmented twice gives the same regions in the same order, because a
 * region's number ends up in a file and a consumer's scene refers to it.
 */
import { exactCos } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

/** What a region is, once something has decided where it is. */
export interface Region {
  /** Triangles belonging to it. */
  readonly triangles: readonly number[];
  /** `minX, minY, minZ, maxX, maxY, maxZ`, in the capture's world. */
  readonly bounds: Float64Array;
  /** Its area-weighted mean normal, which is what makes a floor a floor. */
  readonly normal: Float64Array;
  readonly area: number;
  /** A label somebody attached, or null — which is the ordinary case. */
  readonly label: string | null;
}

export interface SegmentOptions {
  /**
   * How far two triangles' normals may turn and still be one surface, in degrees.
   *
   * **The one number that decides what a region is.** Too small and a gently curved wall becomes a
   * hundred slivers; too large and a floor swallows the skirting board.
   */
  readonly creaseDegrees?: number;
  /** Below this area a run of triangles is not a region. */
  readonly minimumArea?: number;
}

const DEFAULT_CREASE = 20;
const DEFAULT_MINIMUM_AREA = 0.02;

/**
 * Regions from the geometry alone: runs of triangles that share a plane.
 *
 * Two triangles join when they share an edge and their normals agree within the crease angle. Two
 * surfaces that are parallel but apart — a table top and the floor under it — stay apart because
 * they share no edge, not because anything measured the gap.
 *
 * **A plane offset is deliberately not compared, and the reason is worth keeping.** It was, and the
 * check could never say what it claimed: two triangles either side of a shared edge both contain
 * that edge, so equal normals force equal offsets, and unequal normals make the difference grow
 * with distance from *the origin* — the same crease would join near the origin and split far from
 * it, on a capture whose origin is wherever the first camera happened to stand.
 */
export function segmentGeometry(mesh: MeshData, options: SegmentOptions = {}): Region[] {
  const crease = exactCos(((options.creaseDegrees ?? DEFAULT_CREASE) * Math.PI) / 180);
  const minimumArea = options.minimumArea ?? DEFAULT_MINIMUM_AREA;
  const triangles = mesh.indices.length / 3;
  const planes = new Float64Array(triangles * 4);
  const areas = new Float64Array(triangles);
  for (let face = 0; face < triangles; face += 1) planeOf(mesh, face, planes, areas);

  /* Which triangles share an edge: the pair on each undirected edge of the mesh. */
  const parent = new Int32Array(triangles);
  for (let face = 0; face < triangles; face += 1) parent[face] = face;
  const owner = new Map<number, number>();
  const vertices = mesh.positions.length / 3;
  const welded = weldPositions(mesh);
  for (let face = 0; face < triangles; face += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      const a = welded[mesh.indices[face * 3 + slot] as number] as number;
      const b = welded[mesh.indices[face * 3 + ((slot + 1) % 3)] as number] as number;
      const key = a < b ? a * vertices + b : b * vertices + a;
      const held = owner.get(key);
      if (held === undefined) {
        owner.set(key, face);
        continue;
      }
      if (joins(planes, held, face, crease)) union(parent, held, face);
    }
  }

  /* Gathered in the order their lowest triangle appears, so the numbering is the mesh's own. */
  const members = new Map<number, number[]>();
  for (let face = 0; face < triangles; face += 1) {
    const root = find(parent, face);
    const held = members.get(root);
    if (held === undefined) members.set(root, [face]);
    else held.push(face);
  }

  const out: Region[] = [];
  for (const [, faces] of members) {
    const region = regionOf(mesh, faces, planes, areas);
    if (region.area < minimumArea) continue;
    out.push(region);
  }
  /* Largest first, so a consumer reading a prefix reads the parts of the scene that matter. */
  out.sort((a, b) => b.area - a.area);
  return out;
}

/**
 * One vertex per distinct position, so a mesh whose faces do not share vertices still has edges.
 *
 * **Flat shading splits every vertex**, and so does any export that keeps a hard crease: each face
 * arrives with its own copy of each corner. Joining by vertex index alone then finds no shared edge
 * anywhere on such a mesh and answers *every triangle is its own region* — a segmentation that
 * found nothing, returned with a straight face. What it gives up: two surfaces that touch without
 * being joined in the file are joined here, which is what the crease and offset tests are for.
 *
 * Welded on the exact bits of the position rather than within a tolerance, because that is what a
 * duplicate is — a copy — and a tolerance would make the result depend on which vertex was met
 * first. This engine's own marching welds already, so on a capture's own mesh it is a no-op.
 */
function weldPositions(mesh: MeshData): Int32Array {
  const vertices = mesh.positions.length / 3;
  const out = new Int32Array(vertices);
  const seen = new Map<string, number>();
  for (let v = 0; v < vertices; v += 1) {
    const key = `${mesh.positions[v * 3]},${mesh.positions[v * 3 + 1]},${mesh.positions[v * 3 + 2]}`;
    const held = seen.get(key);
    if (held === undefined) {
      seen.set(key, v);
      out[v] = v;
    } else out[v] = held;
  }
  return out;
}

export function planeOf(
  mesh: MeshData,
  face: number,
  planes: Float64Array,
  areas: Float64Array,
): void {
  const a = mesh.indices[face * 3] as number;
  const b = mesh.indices[face * 3 + 1] as number;
  const c = mesh.indices[face * 3 + 2] as number;
  const ux = (mesh.positions[b * 3] as number) - (mesh.positions[a * 3] as number);
  const uy = (mesh.positions[b * 3 + 1] as number) - (mesh.positions[a * 3 + 1] as number);
  const uz = (mesh.positions[b * 3 + 2] as number) - (mesh.positions[a * 3 + 2] as number);
  const vx = (mesh.positions[c * 3] as number) - (mesh.positions[a * 3] as number);
  const vy = (mesh.positions[c * 3 + 1] as number) - (mesh.positions[a * 3 + 1] as number);
  const vz = (mesh.positions[c * 3 + 2] as number) - (mesh.positions[a * 3 + 2] as number);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  areas[face] = length / 2;
  if (!(length > 0)) return;
  planes[face * 4] = nx / length;
  planes[face * 4 + 1] = ny / length;
  planes[face * 4 + 2] = nz / length;
  planes[face * 4 + 3] =
    (nx / length) * (mesh.positions[a * 3] as number) +
    (ny / length) * (mesh.positions[a * 3 + 1] as number) +
    (nz / length) * (mesh.positions[a * 3 + 2] as number);
}

function joins(planes: Float64Array, first: number, second: number, crease: number): boolean {
  let facing = 0;
  for (let k = 0; k < 3; k += 1) {
    facing += (planes[first * 4 + k] as number) * (planes[second * 4 + k] as number);
  }
  return facing >= crease;
}

export function regionOf(
  mesh: MeshData,
  faces: readonly number[],
  planes: Float64Array,
  areas: Float64Array,
): Region {
  const bounds = Float64Array.from([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const normal = new Float64Array(3);
  let area = 0;
  for (const face of faces) {
    const weight = areas[face] as number;
    area += weight;
    for (let k = 0; k < 3; k += 1) {
      normal[k] = (normal[k] as number) + (planes[face * 4 + k] as number) * weight;
    }
    for (let slot = 0; slot < 3; slot += 1) {
      const vertex = mesh.indices[face * 3 + slot] as number;
      for (let k = 0; k < 3; k += 1) {
        const value = mesh.positions[vertex * 3 + k] as number;
        bounds[k] = Math.min(bounds[k] as number, value);
        bounds[k + 3] = Math.max(bounds[k + 3] as number, value);
      }
    }
  }
  const length = Math.sqrt(
    (normal[0] as number) * (normal[0] as number) +
      (normal[1] as number) * (normal[1] as number) +
      (normal[2] as number) * (normal[2] as number),
  );
  if (length > 0) for (let k = 0; k < 3; k += 1) normal[k] = (normal[k] as number) / length;
  return { triangles: [...faces].sort((a, b) => a - b), bounds, normal, area, label: null };
}

function find(parent: Int32Array, at: number): number {
  let root = at;
  while ((parent[root] as number) !== root) root = parent[root] as number;
  let walk = at;
  while ((parent[walk] as number) !== root) {
    const next = parent[walk] as number;
    parent[walk] = root;
    walk = next;
  }
  return root;
}

function union(parent: Int32Array, a: number, b: number): void {
  const first = find(parent, a);
  const second = find(parent, b);
  if (first !== second) parent[second] = first;
}

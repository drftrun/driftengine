/**
 * The district cut into square regions: what each one draws at each distance, copies and collides
 * as.
 *
 * **A placement belongs to the region its origin stands in**, and a region's box grows to hold what
 * it was given, so a terrain tile three hundred metres across is one region's and that region's box
 * covers it.
 *
 * **The finest level is the source.** Statics are merged by material, cut into meshes of at most
 * 65,536 vertices so their indices are 16-bit; copies are grouped by the piece and the material
 * they wear, one instanced draw a group. **The coarser levels are clusterings** (`cluster.ts`) of
 * the copies alone, at `LEVELS` metres, each from the one before. **Statics are drawn whole at every
 * distance**: the generated city's towers, its ground and its roads are a few million triangles
 * for the whole map, and keep their pictures to the horizon, while the hand-made props and
 * buildings, which are most of the triangles, are what a distance can afford to lose.
 *
 * **What a region collides as is its statics clustered at `COLLIDE` metres**: the ground, the
 * roads, the buildings, within a metre of where they are drawn, and a small fraction of their
 * triangles — at thirty centimetres the collision of a whole city was a third of its container.
 * The props it copies are walked through, which is what a later pass can give bodies.
 *
 * **Past the core, a region is skyline**: everything in it, statics and copies alike, clustered at
 * `SKYLINE` metres with its pictures' colours and its windows' glow in the vertices, and nothing
 * else — no props, no collision, no pictures. The city a visitor walks is the core; the rest is
 * what they see of it from there and fly over, and a whole three-kilometre city at full detail
 * was more than four gigabytes. What it gives up is the detail of a street outside the core seen
 * from inside it, which is a block of the right colour with its lit windows where they are.
 */
import type { BlendStruct } from '@driftengine/assets';
import type { MeshData } from '@driftengine/drft';

import { clusterLevel } from './cluster.ts';
import type { ClusterInput } from './cluster.ts';
import type { KitPiece } from './kit.ts';
import { movedBounds, transformed } from './merge.ts';
import type { Sampler } from './sample.ts';
import type { Placement } from './scene.ts';

/** The coarse levels' cell sizes, metres, finest first; each level's error is its cell. */
export const LEVELS = [0.75, 3, 12] as const;
/** A skyline region's levels, metres: its nearest and its farthest. */
export const SKYLINE = [4, 16] as const;
const COLLIDE = 1;
/** A copy at least this across, metres, corner to corner, collides: a kiosk does, a bin does not. */
const SOLID_SIZE = 3;
const MAX_VERTICES = 65536;

export interface RegionGroup {
  readonly piece: string;
  readonly part: number;
  readonly material: number;
  readonly transforms: Float32Array;
}

export interface BakedRegion {
  readonly id: number;
  readonly bounds: number[];
  /** The finest level: one mesh a chunk of a material. */
  readonly statics: { material: number; mesh: MeshData }[];
  readonly groups: RegionGroup[];
  /** The coarse levels, finest first, each one mesh or none. */
  readonly coarse: (MeshData | null)[];
  readonly collision: { positions: Float32Array; indices: Uint32Array } | null;
  readonly triangles: number;
  /** Outside the core: `coarse` is its only content, at `SKYLINE` metres. */
  readonly skyline: boolean;
}

function grow(bounds: number[], add: ArrayLike<number>): void {
  for (let k = 0; k < 3; k++) {
    bounds[k] = Math.min(bounds[k] as number, add[k] as number);
    bounds[k + 3] = Math.max(bounds[k + 3] as number, add[k + 3] as number);
  }
}

/** A mesh cut into meshes of at most `MAX_VERTICES`, by its triangles in order. */
export function chunked(mesh: MeshData): MeshData[] {
  if (mesh.positions.length / 3 <= MAX_VERTICES) return [mesh];
  const out: MeshData[] = [];
  const idx = mesh.indices;
  let t = 0;
  while (t < idx.length) {
    const remap = new Map<number, number>();
    const order: number[] = [];
    const tris: number[] = [];
    while (t < idx.length && remap.size + 3 <= MAX_VERTICES) {
      for (let k = 0; k < 3; k++) {
        const v = idx[t + k] as number;
        let at = remap.get(v);
        if (at === undefined) {
          at = order.length;
          remap.set(v, at);
          order.push(v);
        }
        tris.push(at);
      }
      t += 3;
    }
    out.push(pick(mesh, order, Uint32Array.from(tris)));
  }
  return out;
}

/** The vertices `order` names, with every attribute the mesh carries. */
function pick(mesh: MeshData, order: readonly number[], indices: Uint32Array): MeshData {
  const out: Record<string, unknown> = { indices };
  const count = mesh.positions.length / 3;
  for (const [name, value] of Object.entries(mesh)) {
    if (name === 'indices' || !(value instanceof Float32Array)) continue;
    const width = value.length / count;
    if (!Number.isInteger(width)) continue;
    const picked = new Float32Array(order.length * width);
    order.forEach((v, i) => picked.set(value.subarray(v * width, v * width + width), i * width));
    out[name] = picked;
  }
  return out as unknown as MeshData;
}

/** Join meshes of one material into one. */
function join(meshes: readonly MeshData[]): MeshData {
  if (meshes.length === 1) return meshes[0] as MeshData;
  let vertices = 0;
  let triangles = 0;
  for (const m of meshes) {
    vertices += m.positions.length / 3;
    triangles += m.indices.length;
  }
  const out: Record<string, unknown> = {};
  const first = meshes[0] as MeshData;
  for (const [name, value] of Object.entries(first)) {
    if (name === 'indices' || !(value instanceof Float32Array)) continue;
    const width = value.length / (first.positions.length / 3);
    if (
      !meshes.every((m) => (m as unknown as Record<string, unknown>)[name] instanceof Float32Array)
    )
      continue;
    const joined = new Float32Array(vertices * width);
    let at = 0;
    for (const m of meshes) {
      const source = (m as unknown as Record<string, Float32Array>)[name] as Float32Array;
      joined.set(source, at);
      at += source.length;
    }
    out[name] = joined;
  }
  const indices = new Uint32Array(triangles);
  let base = 0;
  let at = 0;
  for (const m of meshes) {
    for (let i = 0; i < m.indices.length; i++) indices[at + i] = (m.indices[i] as number) + base;
    at += m.indices.length;
    base += m.positions.length / 3;
  }
  out['indices'] = indices;
  return out as unknown as MeshData;
}

export interface RegionInput {
  readonly statics: readonly Placement[];
  readonly copies: ReadonlyMap<string, readonly Placement[]>;
  readonly pieces: ReadonlyMap<string, KitPiece>;
  /** The material row each part of a placement wears. */
  readonly materialOf: (placement: Placement, part: number) => number;
  /** A row whose parts are left out of the regions altogether: the water, drawn as water. */
  readonly skip?: (row: number) => boolean;
  /** The Blender material a row samples its colours from. */
  readonly sourceOf: (row: number) => BlendStruct | null;
  readonly sampler: Sampler;
  readonly size: number;
  /** Whether what stands at (x, z) is baked at all: the whole source unless given. */
  readonly keep?: (x: number, z: number) => boolean;
  /** Whether a region centred at (x, z) is baked whole; elsewhere it is skyline. Everywhere unless given. */
  readonly core?: (x: number, z: number) => boolean;
  readonly log?: (line: string) => void;
}

/**
 * A mesh cut along the region grid: each cell's part as its own mesh, the painted colours beside it.
 *
 * **Clipped, not sorted.** A triangle inside one cell goes to it whole. A triangle crossing cells is
 * cut along their borders — the ground of the source is a few triangles a kilometre across — and
 * every attribute of a vertex the cut makes is interpolated across the triangle, so a cut leaves the
 * surface, its UVs and its colours exactly where they were. A region's box then holds what it was
 * given and no more.
 */
function clipToCells(
  mesh: MeshData,
  extras: readonly Float32Array[],
  size: number,
  keep: ((x: number, z: number) => boolean) | undefined,
): Map<string, { mesh: MeshData; extras: Float32Array[] }> {
  const p = mesh.positions;
  const idx = mesh.indices;
  const count = p.length / 3;
  const attributes: { name: string; data: Float32Array; width: number }[] = [];
  for (const [name, value] of Object.entries(mesh)) {
    if (name === 'indices' || !(value instanceof Float32Array)) continue;
    const width = value.length / count;
    if (Number.isInteger(width) && width > 0) attributes.push({ name, data: value, width });
  }
  extras.forEach((data, i) => attributes.push({ name: `#${i}`, data, width: data.length / count }));
  interface Builder {
    values: number[][];
    indices: number[];
    remap: Map<number, number>;
  }
  const cells = new Map<string, Builder>();
  const builder = (key: string): Builder => {
    let b = cells.get(key);
    if (b === undefined)
      cells.set(key, (b = { values: attributes.map(() => []), indices: [], remap: new Map() }));
    return b;
  };
  const original = (b: Builder, v: number): number => {
    let at = b.remap.get(v);
    if (at === undefined) {
      at = (b.values[0]?.length ?? 0) / (attributes[0]?.width ?? 1);
      attributes.forEach((a, i) =>
        (b.values[i] as number[]).push(...a.data.subarray(v * a.width, v * a.width + a.width)),
      );
      b.remap.set(v, at);
    }
    return at;
  };
  /* A vertex at barycentric (u, v, w) of a triangle's three corners. */
  const blended = (b: Builder, corners: readonly number[], weights: readonly number[]): number => {
    const at = (b.values[0]?.length ?? 0) / (attributes[0]?.width ?? 1);
    attributes.forEach((a, i) => {
      for (let k = 0; k < a.width; k++) {
        let sum = 0;
        for (let c = 0; c < 3; c++)
          sum += (a.data[(corners[c] as number) * a.width + k] as number) * (weights[c] as number);
        (b.values[i] as number[]).push(sum);
      }
    });
    return at;
  };
  const xz = (v: number): [number, number] => [p[v * 3] as number, p[v * 3 + 2] as number];
  for (let t = 0; t < idx.length; t += 3) {
    const corners = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number];
    const pts = corners.map(xz);
    const cx = pts.map((q) => Math.floor(q[0] / size));
    const cz = pts.map((q) => Math.floor(q[1] / size));
    const [x0, x1, z0, z1] = [Math.min(...cx), Math.max(...cx), Math.min(...cz), Math.max(...cz)];
    if (x0 === x1 && z0 === z1) {
      const centre = [
        (pts[0]![0] + pts[1]![0] + pts[2]![0]) / 3,
        (pts[0]![1] + pts[1]![1] + pts[2]![1]) / 3,
      ];
      if (keep !== undefined && !keep(centre[0] as number, centre[1] as number)) continue;
      const b = builder(`${x0},${z0}`);
      for (const v of corners) b.indices.push(original(b, v));
      continue;
    }
    /* The triangle in its own barycentric coordinates, clipped cell by cell in the ground plane. */
    for (let i = x0; i <= x1; i++) {
      for (let j = z0; j <= z1; j++) {
        let polygon: { xz: [number, number]; w: number[] }[] = pts.map((q, c) => ({
          xz: q,
          w: [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0],
        }));
        const planes: [number, number, number][] = [
          [1, 0, -i * size],
          [-1, 0, (i + 1) * size],
          [0, 1, -j * size],
          [0, -1, (j + 1) * size],
        ];
        for (const [a, c, d] of planes) {
          const next: typeof polygon = [];
          for (let k = 0; k < polygon.length; k++) {
            const P = polygon[k] as (typeof polygon)[number];
            const Q = polygon[(k + 1) % polygon.length] as (typeof polygon)[number];
            const dp = a * P.xz[0] + c * P.xz[1] + d;
            const dq = a * Q.xz[0] + c * Q.xz[1] + d;
            if (dp >= 0) next.push(P);
            if (dp >= 0 !== dq >= 0) {
              const f = dp / (dp - dq);
              next.push({
                xz: [P.xz[0] + (Q.xz[0] - P.xz[0]) * f, P.xz[1] + (Q.xz[1] - P.xz[1]) * f],
                w: P.w.map((v, n) => v + ((Q.w[n] as number) - v) * f),
              });
            }
          }
          polygon = next;
          if (polygon.length < 3) break;
        }
        if (polygon.length < 3) continue;
        const mid = polygon.reduce(
          (m, q) => [m[0] + q.xz[0] / polygon.length, m[1] + q.xz[1] / polygon.length],
          [0, 0],
        );
        if (keep !== undefined && !keep(mid[0] as number, mid[1] as number)) continue;
        const b = builder(`${i},${j}`);
        const made = polygon.map((q) => {
          const whole = q.w.findIndex((v) => v > 1 - 1e-9);
          return whole >= 0 ? original(b, corners[whole] as number) : blended(b, corners, q.w);
        });
        for (let k = 1; k + 1 < made.length; k++)
          b.indices.push(made[0] as number, made[k] as number, made[k + 1] as number);
      }
    }
  }
  const out = new Map<string, { mesh: MeshData; extras: Float32Array[] }>();
  for (const [key, b] of cells) {
    if (b.indices.length === 0) continue;
    const built: Record<string, unknown> = { indices: Uint32Array.from(b.indices) };
    const extra: Float32Array[] = [];
    attributes.forEach((a, i) => {
      const data = Float32Array.from(b.values[i] as number[]);
      if (a.name.startsWith('#')) extra.push(data);
      else built[a.name] = data;
    });
    out.set(key, { mesh: built as unknown as MeshData, extras: extra });
  }
  return out;
}

function boundsOf(positions: Float32Array): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k] as number;
      if (v < (b[k] as number)) b[k] = v;
      if (v > (b[k + 3] as number)) b[k + 3] = v;
    }
  }
  return b;
}

/** Cut placements into regions. */
export async function buildRegions(input: RegionInput): Promise<BakedRegion[]> {
  interface Cell {
    bounds: number[];
    /** Static triangles that fall here, already in the world, by material row, painted. */
    statics: Map<
      number,
      { mesh: MeshData; colors: Float32Array; glows: Float32Array; solid: boolean }[]
    >;
    copies: { placement: Placement; key: string }[];
    /** Outside the core: everything, in the world, painted, for the skyline's clustering. */
    skyline: ClusterInput[] | null;
  }
  const cells = new Map<string, Cell>();
  const inCore = (key: string): boolean => {
    if (input.core === undefined) return true;
    const [i, j] = key.split(',').map(Number) as [number, number];
    return input.core((i + 0.5) * input.size, (j + 0.5) * input.size);
  };
  const at = (x: number, z: number): Cell =>
    cellAt(`${Math.floor(x / input.size)},${Math.floor(z / input.size)}`);
  function cellAt(key: string): Cell {
    let found = cells.get(key);
    if (found === undefined) {
      found = {
        bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
        statics: new Map(),
        copies: [],
        skyline: inCore(key) ? null : [],
      };
      cells.set(key, found);
    }
    return found;
  }
  /* A part's colours as a row paints it, computed once however many copies wear it. */
  const painted = new Map<string, { colors: Float32Array; glows: Float32Array }>();
  const paint = async (
    key: string,
    part: number,
    row: number,
    mesh: MeshData,
  ): Promise<{ colors: Float32Array; glows: Float32Array }> => {
    const id = `${key}#${part}#${row}`;
    let known = painted.get(id);
    if (known === undefined) {
      known = await input.sampler.paint(mesh, input.sourceOf(row));
      painted.set(id, known);
    }
    return known;
  };

  /*
   * **A static is cut by its triangles, not placed by its origin.** The source's generated city is
   * a hundred tiles a few hundred metres across, every one with its origin at the world's: placed
   * by origin, the whole of it fell into one region. Each triangle goes to the region its centre
   * stands in, which is where it would be merged with its neighbours anyway.
   */
  for (const placement of input.statics) {
    const piece = input.pieces.get(placement.key);
    if (piece === undefined) continue;
    for (let p = 0; p < piece.parts.length; p++) {
      const part = piece.parts[p] as KitPiece['parts'][number];
      const row = input.materialOf(placement, p);
      if (input.skip?.(row) === true) continue;
      const moved = transformed(part.mesh, placement.world);
      const colours = await paint(placement.key, p, row, part.mesh);
      const m = part.material;
      /* What a walker stands on and bumps into: opaque surfaces, not glass or anything blended. */
      const solid = m.opacity >= 1 && m.blend !== true && (m.transmission ?? 0) === 0;
      for (const [cellKey, cut] of clipToCells(
        moved,
        [colours.colors, colours.glows],
        input.size,
        input.keep,
      )) {
        const cell = cellAt(cellKey);
        grow(cell.bounds, boundsOf(cut.mesh.positions));
        if (cell.skyline !== null) {
          cell.skyline.push({
            positions: cut.mesh.positions,
            indices: cut.mesh.indices,
            colors: cut.extras[0] as Float32Array,
            glows: cut.extras[1] as Float32Array,
          });
          continue;
        }
        const list = cell.statics.get(row) ?? [];
        list.push({
          mesh: cut.mesh,
          colors: cut.extras[0] as Float32Array,
          glows: cut.extras[1] as Float32Array,
          solid,
        });
        cell.statics.set(row, list);
      }
    }
  }
  for (const [key, placements] of input.copies) {
    const piece = input.pieces.get(key);
    if (piece === undefined) continue;
    for (const placement of placements) {
      const moved = movedBounds(piece.bounds, placement.world);
      const cx = ((moved[0] as number) + (moved[3] as number)) / 2;
      const cz = ((moved[2] as number) + (moved[5] as number)) / 2;
      if (input.keep !== undefined && !input.keep(cx, cz)) continue;
      const cell = at(cx, cz);
      grow(cell.bounds, moved);
      cell.copies.push({ placement, key });
    }
  }

  const out: BakedRegion[] = [];
  let id = 0;
  for (const cell of cells.values()) {
    const started = performance.now();
    if (cell.skyline !== null) {
      /* The copies placed in the world only now, a region at a time, so the city is never all in memory at once. */
      for (const { placement, key } of cell.copies) {
        const piece = input.pieces.get(key) as KitPiece;
        for (let p = 0; p < piece.parts.length; p++) {
          const part = piece.parts[p] as KitPiece['parts'][number];
          const row = input.materialOf(placement, p);
          if (input.skip?.(row) === true) continue;
          const colours = await paint(key, p, row, part.mesh);
          const world = transformed(part.mesh, placement.world);
          cell.skyline.push({
            positions: world.positions,
            indices: world.indices,
            colors: colours.colors,
            glows: colours.glows,
          });
        }
      }
      const near = clusterLevel(cell.skyline, SKYLINE[0]);
      const far =
        near === null
          ? null
          : clusterLevel(
              [
                {
                  positions: near.positions,
                  indices: near.indices,
                  colors: near.colors as Float32Array,
                  glows: emissiveOf(near),
                },
              ],
              SKYLINE[1],
            );
      const triangles = cell.skyline.reduce((n, c) => n + c.indices.length / 3, 0);
      cell.skyline = [];
      out.push({
        id: id++,
        bounds: cell.bounds,
        statics: [],
        groups: [],
        coarse: [near, far],
        collision: null,
        triangles,
        skyline: true,
      });
      input.log?.(
        `  region ${id - 1}: skyline of ${(triangles / 1e6).toFixed(2)} M triangles, ${((near?.indices.length ?? 0) / 3 / 1000).toFixed(0)}k / ${((far?.indices.length ?? 0) / 3 / 1000).toFixed(0)}k, ${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
      continue;
    }
    const byMaterial = new Map<number, MeshData[]>();
    const solid: ClusterInput[] = [];
    const everything: ClusterInput[] = [];
    let triangles = 0;
    for (const [row, list] of cell.statics) {
      for (const entry of list) {
        const meshes = byMaterial.get(row) ?? [];
        meshes.push(entry.mesh);
        byMaterial.set(row, meshes);
        const clustered = {
          positions: entry.mesh.positions,
          indices: entry.mesh.indices,
          colors: entry.colors,
          glows: entry.glows,
        };
        if (entry.solid) solid.push(clustered);
        triangles += entry.mesh.indices.length / 3;
      }
    }
    const groups = new Map<
      string,
      { piece: string; part: number; material: number; matrices: number[] }
    >();
    for (const { placement, key } of cell.copies) {
      const piece = input.pieces.get(key) as KitPiece;
      for (let p = 0; p < piece.parts.length; p++) {
        const part = piece.parts[p] as KitPiece['parts'][number];
        const row = input.materialOf(placement, p);
        if (input.skip?.(row) === true) continue;
        const groupKey = `${key}#${p}#${row}`;
        let group = groups.get(groupKey);
        if (group === undefined) {
          group = { piece: key, part: p, material: row, matrices: [] };
          groups.set(groupKey, group);
        }
        group.matrices.push(...placement.world);
        const colours = await paint(key, p, row, part.mesh);
        const moved = transformed(part.mesh, placement.world);
        const clustered = {
          positions: moved.positions,
          indices: moved.indices,
          colors: colours.colors,
          glows: colours.glows,
        };
        everything.push(clustered);
        /* A building is a copy as often as not; anything larger than a person stops one. */
        const b = piece.bounds;
        const large =
          Math.hypot(
            (b[3] as number) - (b[0] as number),
            (b[4] as number) - (b[1] as number),
            (b[5] as number) - (b[2] as number),
          ) > SOLID_SIZE;
        const m = part.material;
        if (large && m.opacity >= 1 && m.blend !== true && (m.transmission ?? 0) === 0)
          solid.push(clustered);
        triangles += moved.indices.length / 3;
      }
    }

    const coarse: (MeshData | null)[] = [];
    let previous: ClusterInput[] = everything;
    for (const size of LEVELS) {
      const level = clusterLevel(previous, size);
      coarse.push(level);
      if (level !== null)
        previous = [
          {
            positions: level.positions,
            indices: level.indices,
            colors: level.colors,
            glows: emissiveOf(level),
          },
        ];
    }
    const collision = clusterLevel(solid, COLLIDE);
    const statics: { material: number; mesh: MeshData }[] = [];
    for (const [material, meshes] of byMaterial)
      for (const mesh of chunked(join(meshes))) statics.push({ material, mesh });
    out.push({
      id: id++,
      bounds: cell.bounds,
      statics,
      groups: [...groups.values()].map((g) => ({
        piece: g.piece,
        part: g.part,
        material: g.material,
        transforms: Float32Array.from(g.matrices),
      })),
      coarse,
      collision:
        collision === null ? null : { positions: collision.positions, indices: collision.indices },
      triangles,
      skyline: false,
    });
    input.log?.(
      `  region ${id - 1}: ${(triangles / 1e6).toFixed(2)} M triangles, coarse ${coarse.map((c) => ((c?.indices.length ?? 0) / 3 / 1000).toFixed(0) + 'k').join(' / ')}, ` +
        `collision ${((collision?.indices.length ?? 0) / 3 / 1000).toFixed(0)}k, ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
  }
  return out;
}

/** A clustered level's glow back as three floats a vertex, for the next level down. */
function emissiveOf(level: MeshData): Float32Array {
  const count = level.positions.length / 3;
  const out = new Float32Array(count * 3);
  const colour = level.emissiveColor;
  if (colour === undefined) return out;
  for (let i = 0; i < count * 3; i++) out[i] = Math.max(0, colour[i] as number);
  return out;
}

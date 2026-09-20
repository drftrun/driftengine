/**
 * Hierarchical detail: one proxy for a whole group of cells, and one sprite for a whole object.
 *
 * **A distant city has to become a handful of draws, and there are only two ways to do it.** Merge
 * the geometry down until a group of cells is one coarse mesh, which is what a proxy is; or stop
 * drawing geometry at all and draw the object's own picture, which is what an impostor is. This
 * module bakes both, offline, so nothing here runs per frame and it may allocate freely.
 *
 * **The proxy is not a new mesh merger.** `coarseLevel.ts` already builds one mesh from many, by
 * emitting the boundary of an occupancy grid rather than decimating a surface — and it already
 * argues, at length, why the decimation it replaced grew triangles straight through a car's
 * bodywork. A cell group is the same problem one level up, so what is new here is the *grouping*
 * and the level-to-resolution schedule, not the geometry.
 *
 * **And a proxy is a budget, so it can be refused.** The plan for this said a proxy has fewer
 * triangles than the sum of its members; a grid-based merge cannot promise that, because its output
 * scales with the group's surface area and not with the input's triangle count. Four plain boxes
 * are forty-eight triangles and every grid that resolves them at all produces more. So the budget
 * is checked — `isOutlineWorthWriting`'s half, the same rule the container already uses — and a
 * group that is already cheap gets `null` rather than something bigger than what it replaced.
 *
 * **The impostor's hard part is its edges, not its views.** Rasterising a mesh from sixty-four
 * directions is arithmetic. What makes distant trees glow is that the texels *outside* the
 * silhouette are left at the clear colour, and a bilinear tap at the edge blends the object with
 * black — a dark rim under a lit pass, a bright one under an additive pass. Two things fix it and
 * both are here: colour is dilated outward so a transparent texel carries its nearest opaque
 * neighbour's colour, and every tile is surrounded by a gutter repeating its edge so a tap near a
 * tile boundary cannot reach the next direction's picture.
 */
import type { MeshData } from '@driftengine/drft';

import { buildCoarseLevel, isOutlineWorthWriting } from '../coarseLevel.ts';

/** A cell's geometry, keyed by the identifier `core/src/world/cell.ts` gives it. */
export interface ProxyCell {
  readonly id: number;
  readonly meshes: readonly MeshData[];
}

/**
 * Grid cells along the longest axis of a level-0 proxy.
 *
 * Coarser than `DEFAULT_COARSE_CELLS` because the subject is different: that outline stands in for
 * one asset arriving over a network and is looked at from a few metres, this one stands in for a
 * block of a city seen from the far side of a valley.
 */
export const PROXY_BASE_CELLS = 32;

/** The finest a proxy is allowed to get, matching `buildCoarseLevel`'s own floor. */
export const PROXY_MIN_CELLS = 4;

/** The grid a level uses. Each level halves the last, which is what makes it a hierarchy. */
export function proxyResolution(level: number): number {
  const at = Math.max(0, Math.floor(level));
  return Math.max(PROXY_MIN_CELLS, PROXY_BASE_CELLS >> at);
}

/**
 * One mesh standing in for a whole cell group, or `null` when it is not worth having.
 *
 * `null` in three cases, and they are all the same case: there is nothing to gain. An empty group,
 * a group whose geometry does not span a single grid cell, and a group already cheaper than any
 * proxy of it would be.
 */
export function buildProxy(cells: readonly ProxyCell[], level: number): MeshData | null {
  const meshes: MeshData[] = [];
  for (const cell of cells) for (const mesh of cell.meshes) meshes.push(mesh);
  /* No guard for an empty group: `buildCoarseLevel` answers `null` for one, for the same reason,
     and a second check here would be a copy of a rule rather than a rule. */
  const proxy = buildCoarseLevel(meshes, { cells: proxyResolution(level) });
  if (proxy === null) return null;
  if (!isOutlineWorthWriting(proxy, meshes)) return null;
  return proxy;
}

/**
 * The sphere a bake frames its views on: a centre and a radius, and nothing about direction.
 *
 * **Carried on the impostor rather than recomputed by its consumer**, because an atlas on its own
 * cannot be placed. The quad a sprite is drawn on needs the object's centre and half-extent, and a
 * consumer deriving them a second time from geometry it may no longer be holding is a consumer
 * whose sprite sits somewhere the object is not.
 */
export interface ViewFrame {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly radius: number;
}

/** The frame that fits every mesh given. A radius of zero for a point, rather than a NaN. */
export function frameOf(meshes: readonly MeshData[]): ViewFrame {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const mesh of meshes) {
    for (let at = 0; at + 2 < mesh.positions.length; at += 3) {
      const x = mesh.positions[at] as number;
      const y = mesh.positions[at + 1] as number;
      const z = mesh.positions[at + 2] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return { cx: 0, cy: 0, cz: 0, radius: 0 };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let radius = 0;
  for (const mesh of meshes) {
    for (let at = 0; at + 2 < mesh.positions.length; at += 3) {
      const d = Math.hypot(
        (mesh.positions[at] as number) - cx,
        (mesh.positions[at + 1] as number) - cy,
        (mesh.positions[at + 2] as number) - cz,
      );
      if (d > radius) radius = d;
    }
  }
  return { cx, cy, cz, radius };
}

function signOf(value: number): number {
  return value >= 0 ? 1 : -1;
}

/**
 * The direction a tile of the atlas was baked from, for an octahedral coordinate in `[0, 1]`.
 *
 * **The whole sphere and not a hemisphere.** A hemi-octahedral map spends its texels on the upper
 * half and is right for anything standing on ground the viewer also stands on; a tree seen from a
 * bridge, a rock seen from a cliff and anything at all seen by a flying camera need the underside,
 * and a map that does not carry it substitutes the horizon view and reads as a card.
 */
export function octahedralDirection(u: number, v: number, out: Float32Array): void {
  const ex = u * 2 - 1;
  const ez = v * 2 - 1;
  let y = 1 - Math.abs(ex) - Math.abs(ez);
  let x = ex;
  let z = ez;
  if (y < 0) {
    x = (1 - Math.abs(ez)) * signOf(ex);
    z = (1 - Math.abs(ex)) * signOf(ez);
  }
  const length = Math.hypot(x, y, z);
  if (length === 0) {
    out[0] = 0;
    out[1] = -1;
    out[2] = 0;
    return;
  }
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
  y = 0;
}

/** The octahedral coordinate a direction came from: the inverse of `octahedralDirection`. */
export function octahedralCoord(dir: ArrayLike<number>, out: Float32Array): void {
  const x = dir[0] as number;
  const y = dir[1] as number;
  const z = dir[2] as number;
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (l1 === 0) {
    out[0] = 0.5;
    out[1] = 0.5;
    return;
  }
  const px = x / l1;
  const py = y / l1;
  const pz = z / l1;
  let ex = px;
  let ez = pz;
  if (py < 0) {
    ex = (1 - Math.abs(pz)) * signOf(px);
    ez = (1 - Math.abs(px)) * signOf(pz);
  }
  out[0] = ex * 0.5 + 0.5;
  out[1] = ez * 0.5 + 0.5;
}

/**
 * An orthographic rasterisation of a mesh from one direction, as `resolution²` RGBA texels.
 *
 * `dir` points *from the object toward the viewer*. Alpha is 1 where a triangle covers the texel
 * centre and 0 where none does — coverage rather than an anti-aliased edge, because what this
 * feeds is a silhouette comparison and an atlas whose edge ramp comes from its own filtering.
 *
 * Exported because the claim a proxy has to meet is about its silhouette, and a test that cannot
 * rasterise cannot check one.
 */
export function rasteriseView(
  mesh: MeshData,
  frame: ViewFrame,
  dir: ArrayLike<number>,
  resolution: number,
  out: Float32Array,
): void {
  out.fill(0);
  const radius = frame.radius;
  if (radius <= 0) return;

  const wx = dir[0] as number;
  const wy = dir[1] as number;
  const wz = dir[2] as number;
  const wl = Math.hypot(wx, wy, wz);
  if (wl === 0) return;
  const w = [wx / wl, wy / wl, wz / wl];
  /* Any up vector not parallel to the view. Chosen by a threshold so the basis never degenerates. */
  const up = Math.abs(w[1] as number) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const ux = (up[1] as number) * (w[2] as number) - (up[2] as number) * (w[1] as number);
  const uy = (up[2] as number) * (w[0] as number) - (up[0] as number) * (w[2] as number);
  const uz = (up[0] as number) * (w[1] as number) - (up[1] as number) * (w[0] as number);
  const ul = Math.hypot(ux, uy, uz);
  const u = [ux / ul, uy / ul, uz / ul];
  const v = [
    (w[1] as number) * (u[2] as number) - (w[2] as number) * (u[1] as number),
    (w[2] as number) * (u[0] as number) - (w[0] as number) * (u[2] as number),
    (w[0] as number) * (u[1] as number) - (w[1] as number) * (u[0] as number),
  ];

  const vertices = mesh.positions.length / 3;
  const screen = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i += 1) {
    const dx = (mesh.positions[i * 3] as number) - frame.cx;
    const dy = (mesh.positions[i * 3 + 1] as number) - frame.cy;
    const dz = (mesh.positions[i * 3 + 2] as number) - frame.cz;
    const sx = (dx * (u[0] as number) + dy * (u[1] as number) + dz * (u[2] as number)) / radius;
    const sy = (dx * (v[0] as number) + dy * (v[1] as number) + dz * (v[2] as number)) / radius;
    const depth = dx * (w[0] as number) + dy * (w[1] as number) + dz * (w[2] as number);
    screen[i * 3] = (sx * 0.5 + 0.5) * resolution;
    screen[i * 3 + 1] = (0.5 - sy * 0.5) * resolution;
    screen[i * 3 + 2] = depth;
  }

  const depths = new Float32Array(resolution * resolution).fill(-Infinity);
  const colours = mesh.colors;
  for (let tri = 0; tri * 3 + 2 < mesh.indices.length; tri += 1) {
    const ia = mesh.indices[tri * 3] as number;
    const ib = mesh.indices[tri * 3 + 1] as number;
    const ic = mesh.indices[tri * 3 + 2] as number;
    const ax = screen[ia * 3] as number;
    const ay = screen[ia * 3 + 1] as number;
    const bx = screen[ib * 3] as number;
    const by = screen[ib * 3 + 1] as number;
    const cx = screen[ic * 3] as number;
    const cy = screen[ic * 3 + 1] as number;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;
    /* Either winding rasterises: an impostor sees both sides of a shell that is not closed. */
    const flip = area < 0 ? -1 : 1;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const e0 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * flip;
        const e1 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * flip;
        const e2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * flip;
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        const sum = e0 + e1 + e2;
        if (sum <= 0) continue;
        const wa = e0 / sum;
        const wb = e1 / sum;
        const wc = e2 / sum;
        const depth =
          wa * (screen[ia * 3 + 2] as number) +
          wb * (screen[ib * 3 + 2] as number) +
          wc * (screen[ic * 3 + 2] as number);
        const at = y * resolution + x;
        if (depth <= (depths[at] as number)) continue;
        depths[at] = depth;
        const o = at * 4;
        for (let c = 0; c < 3; c += 1) {
          out[o + c] =
            wa * (colours[ia * 3 + c] as number) +
            wb * (colours[ib * 3 + c] as number) +
            wc * (colours[ic * 3 + c] as number);
        }
        out[o + 3] = 1;
      }
    }
  }
}

/** Texels a tile's picture occupies, before its gutter. */
export const IMPOSTOR_TILE = 24;

/**
 * Texels of edge repeat around every tile.
 *
 * Two, not one: a bilinear tap needs one, and a mip of the atlas needs the second. One gutter is
 * the version that looks right until somebody enables mipping on the atlas, which is exactly when
 * the object is far enough away for an impostor to be in use.
 */
export const IMPOSTOR_GUTTER = 2;

/** How far colour is pushed outward past the silhouette. Covers the gutter and a tap beyond it. */
const DILATE_PASSES = IMPOSTOR_GUTTER + 2;

export interface Impostor {
  /** `size * size` RGBA texels. */
  readonly atlas: Float32Array;
  /** Texels across the whole atlas. */
  readonly size: number;
  /** Tiles across one axis; the atlas holds this squared. */
  readonly directions: number;
  /** The sphere the views were framed on, which is what places the sprite. */
  readonly frame: ViewFrame;
}

/**
 * Bake `directions²` views of a mesh into one atlas.
 *
 * At least two directions a side, because a single tile has no octahedral coordinate to be at and
 * an impostor of one view is a billboard — a different thing with a different failure.
 */
export function buildImpostor(mesh: MeshData, directions: number): Impostor {
  const n = Math.floor(directions);
  if (!(n >= 2)) throw new Error(`buildImpostor: needs at least 2 directions a side, got ${n}`);

  const frame = frameOf([mesh]);
  const stride = IMPOSTOR_TILE + IMPOSTOR_GUTTER * 2;
  const size = stride * n;
  const atlas = new Float32Array(size * size * 4);
  const tile = new Float32Array(IMPOSTOR_TILE * IMPOSTOR_TILE * 4);
  const dir = new Float32Array(3);

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      octahedralDirection(i / (n - 1), j / (n - 1), dir);
      rasteriseView(mesh, frame, dir, IMPOSTOR_TILE, tile);
      dilateColour(tile, IMPOSTOR_TILE);
      /* The gutter is the clamp, written rather than implied, because the sampler is a shader. */
      for (let y = 0; y < stride; y += 1) {
        for (let x = 0; x < stride; x += 1) {
          const sx = Math.min(IMPOSTOR_TILE - 1, Math.max(0, x - IMPOSTOR_GUTTER));
          const sy = Math.min(IMPOSTOR_TILE - 1, Math.max(0, y - IMPOSTOR_GUTTER));
          const from = (sy * IMPOSTOR_TILE + sx) * 4;
          const to = ((j * stride + y) * size + i * stride + x) * 4;
          for (let c = 0; c < 4; c += 1) atlas[to + c] = tile[from + c] as number;
        }
      }
    }
  }
  return { atlas, size, directions: n, frame };
}

/**
 * Push colour outward into the transparent texels, leaving alpha alone.
 *
 * Alpha is the silhouette and must not move; what moves is the colour underneath it, so that the
 * blend a filtered tap produces at the edge is the object's own colour at a lower alpha rather than
 * the object mixed with the clear value. A pass writes into a copy and swaps at the end, so the
 * result does not depend on the order texels are visited and the bake stays deterministic.
 */
function dilateColour(texels: Float32Array, resolution: number): void {
  const filled = new Uint8Array(resolution * resolution);
  for (let at = 0; at < filled.length; at += 1)
    filled[at] = (texels[at * 4 + 3] as number) > 0 ? 1 : 0;

  for (let pass = 0; pass < DILATE_PASSES; pass += 1) {
    const added: number[] = [];
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const at = y * resolution + x;
        if (filled[at] === 1) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= resolution || ny >= resolution) continue;
            const n = ny * resolution + nx;
            if (filled[n] !== 1) continue;
            r += texels[n * 4] as number;
            g += texels[n * 4 + 1] as number;
            b += texels[n * 4 + 2] as number;
            count += 1;
          }
        }
        if (count === 0) continue;
        texels[at * 4] = r / count;
        texels[at * 4 + 1] = g / count;
        texels[at * 4 + 2] = b / count;
        added.push(at);
      }
    }
    if (added.length === 0) return;
    for (const at of added) filled[at] = 1;
  }
}

/**
 * Sample the impostor as the shader would: bilinear inside a tile, bilinear across the four tiles
 * around the requested direction.
 *
 * **No parallax correction**, which is the whole of the error between baked directions and is
 * stated here rather than discovered: blending four flat pictures of a shape with depth ghosts it.
 * The remedy is more directions, and it costs their square.
 */
export function sampleImpostor(
  impostor: Impostor,
  dir: ArrayLike<number>,
  u: number,
  v: number,
  out: Float32Array,
): void {
  const coord = new Float32Array(2);
  octahedralCoord(dir, coord);
  const n = impostor.directions;
  const fu = (coord[0] as number) * (n - 1);
  const fv = (coord[1] as number) * (n - 1);
  const i0 = Math.min(n - 1, Math.max(0, Math.floor(fu)));
  const j0 = Math.min(n - 1, Math.max(0, Math.floor(fv)));
  const i1 = Math.min(n - 1, i0 + 1);
  const j1 = Math.min(n - 1, j0 + 1);
  const wu = Math.min(1, Math.max(0, fu - i0));
  const wv = Math.min(1, Math.max(0, fv - j0));

  const corner = new Float32Array(4);
  for (let c = 0; c < 4; c += 1) out[c] = 0;
  const weights = [
    [i0, j0, (1 - wu) * (1 - wv)],
    [i1, j0, wu * (1 - wv)],
    [i0, j1, (1 - wu) * wv],
    [i1, j1, wu * wv],
  ];
  for (const [i, j, weight] of weights) {
    if ((weight as number) <= 0) continue;
    sampleTile(impostor, i as number, j as number, u, v, corner);
    for (let c = 0; c < 4; c += 1)
      out[c] = (out[c] as number) + (corner[c] as number) * (weight as number);
  }
}

/** One tile, bilinear, reading through the gutter exactly as a clamped sampler would. */
function sampleTile(
  impostor: Impostor,
  i: number,
  j: number,
  u: number,
  v: number,
  out: Float32Array,
): void {
  const stride = IMPOSTOR_TILE + IMPOSTOR_GUTTER * 2;
  const originX = i * stride + IMPOSTOR_GUTTER;
  const originY = j * stride + IMPOSTOR_GUTTER;
  const tu = u * IMPOSTOR_TILE - 0.5;
  const tv = v * IMPOSTOR_TILE - 0.5;
  const x0 = Math.floor(tu);
  const y0 = Math.floor(tv);
  const fx = tu - x0;
  const fy = tv - y0;
  /*
   * Clamped to the tile and not into its gutter, which would read the same values: the gutter
   * repeats the edge, so a padded read and a clamped one cannot differ. It exists for the hardware
   * sampler, which clamps to the whole *atlas* and would otherwise walk into the next direction's
   * picture, and the test that walks every gutter texel is what holds it.
   */
  const clamp = (value: number): number => Math.min(IMPOSTOR_TILE - 1, Math.max(0, value));
  const ax = clamp(x0);
  const bx = clamp(x0 + 1);
  const ay = clamp(y0);
  const by = clamp(y0 + 1);
  const read = (x: number, y: number, c: number): number =>
    impostor.atlas[((originY + y) * impostor.size + originX + x) * 4 + c] as number;
  for (let c = 0; c < 4; c += 1) {
    const top = read(ax, ay, c) * (1 - fx) + read(bx, ay, c) * fx;
    const bottom = read(ax, by, c) * (1 - fx) + read(bx, by, c) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

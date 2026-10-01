/**
 * The district's water: what the source models as a flat sheet of water, kept out of the drawn
 * geometry and handed to the runtime as bodies of the engine's own water — waves, Fresnel, the
 * mirror of the street above it — at the sheet's level.
 *
 * **A body is a rectangle, and a river is not one**, so the sheet is cut into rectangles that each
 * cover mostly water: its footprint rasterised at `CELL` metres, then a rectangle fitted to the
 * footprint along its own principal axis and split in two across that axis wherever it covers less
 * than `FILL` of it in water or runs longer than `LONGEST`, down to `SHORTEST`. A straight canal is
 * one body; a river's bend is a few, overlapping a little where they meet. The footprint is closed
 * first: a river of five hundred separate faces rasterised with seams between them, no rectangle
 * ever covered enough of it, and a three-kilometre river came back as fourteen hundred bodies.
 *
 * What it gives up: water past a rectangle's edge where a bend is cut coarsely, which lies under
 * the bank's own ground and is hidden by it, and a doubled blend where two bodies overlap, which on
 * water as murky as a city's reads as the same water. What would make it wrong is a sheet that is
 * not level — a weir, a cascade — which is one body per level and not handled here.
 */
import type { MeshData } from '@driftengine/drft';

const CELL = 2;
const FILL = 0.68;
const LONGEST = 220;
/** A body this short is not split again, whatever it covers: a bend is a few bodies, not hundreds. */
const SHORTEST = 30;
/** Gaps in the footprint closed before it is cut, cells: a sheet of separate faces rasterises with seams. */
const CLOSE = 2;
/** How far past its cells a body reaches, metres, so neighbours meet rather than leave a seam. */
const MARGIN = 1.5;

/** One rectangle of water, as `WaterBounds` takes it. */
export interface WaterRect {
  readonly x: number;
  readonly z: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly forwardX: number;
  readonly forwardZ: number;
}

export interface DistrictWater {
  readonly level: number;
  /** The sheet's own colour, linear: what the deep water looks like. */
  readonly color: readonly [number, number, number];
  readonly bodies: readonly WaterRect[];
}

/** What a material's name says about whether it is a body of water. */
export function isWater(name: string): boolean {
  const n = name.toLowerCase();
  if (/manhole|bottle|tower|tank|heater|pipe|fountain|pool_light|cooler|drain/.test(n))
    return false;
  return /(^|_)(river|canal|harbou?r|lake|pond|ocean)(_|$)/.test(n) || /(^|_)water$/.test(n);
}

/** The water sheets of `meshes`, in world space, as bodies; null where there is none. */
export function waterBodies(
  meshes: readonly MeshData[],
  color: readonly [number, number, number],
  keep?: (x: number, z: number) => boolean,
): DistrictWater | null {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  let levelSum = 0;
  let areaSum = 0;
  for (const mesh of meshes) {
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [
        (idx[t] as number) * 3,
        (idx[t + 1] as number) * 3,
        (idx[t + 2] as number) * 3,
      ];
      const area =
        Math.abs(
          ((p[b] as number) - (p[a] as number)) * ((p[c + 2] as number) - (p[a + 2] as number)) -
            ((p[c] as number) - (p[a] as number)) * ((p[b + 2] as number) - (p[a + 2] as number)),
        ) / 2;
      levelSum += (((p[a + 1] as number) + (p[b + 1] as number) + (p[c + 1] as number)) / 3) * area;
      areaSum += area;
      for (const v of [a, b, c]) {
        x0 = Math.min(x0, p[v] as number);
        x1 = Math.max(x1, p[v] as number);
        z0 = Math.min(z0, p[v + 2] as number);
        z1 = Math.max(z1, p[v + 2] as number);
      }
    }
  }
  if (areaSum <= 0) return null;
  const W = Math.ceil((x1 - x0) / CELL) + 1;
  const H = Math.ceil((z1 - z0) / CELL) + 1;
  const wet = new Uint8Array(W * H);
  for (const mesh of meshes) {
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [
        (idx[t] as number) * 3,
        (idx[t + 1] as number) * 3,
        (idx[t + 2] as number) * 3,
      ];
      const [ax, az, bx, bz, cx, cz] = [
        p[a],
        p[a + 2],
        p[b],
        p[b + 2],
        p[c],
        p[c + 2],
      ] as number[] as [number, number, number, number, number, number];
      const gx0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / CELL));
      const gx1 = Math.min(W - 1, Math.floor((Math.max(ax, bx, cx) - x0) / CELL));
      const gz0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / CELL));
      const gz1 = Math.min(H - 1, Math.floor((Math.max(az, bz, cz) - z0) / CELL));
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const px = x0 + (gx + 0.5) * CELL;
          const pz = z0 + (gz + 0.5) * CELL;
          const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
          const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
          const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
          const inside = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
          if (inside && (keep === undefined || keep(px, pz))) wet[gz * W + gx] = 1;
        }
      }
    }
  }
  const closed = erode(dilate(wet, W, H, CLOSE), W, H, CLOSE);
  const cells: number[] = [];
  for (let i = 0; i < closed.length; i++)
    if (closed[i] === 1)
      cells.push(x0 + ((i % W) + 0.5) * CELL, z0 + (Math.floor(i / W) + 0.5) * CELL);
  if (cells.length === 0) return null;
  const bodies: WaterRect[] = [];
  split(cells, bodies);
  return { level: levelSum / areaSum, color, bodies };
}

/** Fit a rectangle to `cells` (x, z pairs), or split them across its long axis and recurse. */
function split(cells: readonly number[], out: WaterRect[]): void {
  const n = cells.length / 2;
  let mx = 0;
  let mz = 0;
  for (let i = 0; i < n; i++) {
    mx += cells[i * 2] as number;
    mz += cells[i * 2 + 1] as number;
  }
  mx /= n;
  mz /= n;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (let i = 0; i < n; i++) {
    const dx = (cells[i * 2] as number) - mx;
    const dz = (cells[i * 2 + 1] as number) - mz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }
  /* The principal axis: the direction the footprint is longest along. */
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const [ux, uz] = [Math.cos(angle), Math.sin(angle)];
  let [a0, a1, b0, b1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const dx = (cells[i * 2] as number) - mx;
    const dz = (cells[i * 2 + 1] as number) - mz;
    const along = dx * ux + dz * uz;
    const across = -dx * uz + dz * ux;
    a0 = Math.min(a0, along);
    a1 = Math.max(a1, along);
    b0 = Math.min(b0, across);
    b1 = Math.max(b1, across);
  }
  const length = a1 - a0 + CELL;
  const width = b1 - b0 + CELL;
  const fill = (n * CELL * CELL) / (length * width);
  if (n > 4 && length > SHORTEST && (fill < FILL || length > LONGEST)) {
    const middle = (a0 + a1) / 2;
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < n; i++) {
      const along = ((cells[i * 2] as number) - mx) * ux + ((cells[i * 2 + 1] as number) - mz) * uz;
      (along < middle ? near : far).push(cells[i * 2] as number, cells[i * 2 + 1] as number);
    }
    if (near.length > 0 && far.length > 0) {
      split(near, out);
      split(far, out);
      return;
    }
  }
  const ca = (a0 + a1) / 2;
  const cb = (b0 + b1) / 2;
  /* The body's own z runs along the footprint and its x across it. */
  out.push({
    x: mx + ca * ux - cb * uz,
    z: mz + ca * uz + cb * ux,
    halfX: width / 2 + MARGIN,
    halfZ: length / 2 + MARGIN,
    forwardX: ux,
    forwardZ: uz,
  });
}

/** Every cell within `r` of a wet one, wet: a square neighbourhood, which is what a grid's seam is. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue;
      for (let dy = Math.max(0, y - r); dy <= Math.min(h - 1, y + r); dy++)
        for (let dx = Math.max(0, x - r); dx <= Math.min(w - 1, x + r); dx++) out[dy * w + dx] = 1;
    }
  }
  return out;
}

/** Every cell with a dry one within `r`, dry: `dilate`'s undoing, so a closing keeps the outline. */
function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let dy = y - r; dy <= y + r && all === 1; dy++) {
        for (let dx = x - r; dx <= x + r; dx++) {
          if (dy < 0 || dx < 0 || dy >= h || dx >= w || mask[dy * w + dx] !== 1) {
            all = 0;
            break;
          }
        }
      }
      out[y * w + x] = all;
    }
  }
  return out;
}

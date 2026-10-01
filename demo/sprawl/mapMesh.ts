/**
 * The city as a map: every block filled in its district's colour, the monorail lines in their
 * tints, the destinations and the skyports as marks — one flat mesh baked once, which the minimap
 * and the city map both draw. The streets are what is left between the blocks.
 *
 * **Lit by its own emissive alone**, in an environment of its own with no sun, no ambient and no
 * fog and the night factor at one, since the engine gates emissive by the night. So the map's
 * colours are its vertices' colours, at any hour.
 *
 * A block is filled by ear clipping, as a few are concave where the diagonal cuts them.
 */
import { createEnvironment } from '../../packages/core/src/index';
import type { Environment, MeshData } from '../../packages/core/src/index';

type Rgb = readonly [number, number, number];

export interface MapInput {
  readonly districts: readonly { readonly index: number; readonly accent: number }[];
  readonly blocks: readonly { readonly district: number; readonly outline: readonly number[] }[];
  readonly lines: readonly { readonly path: readonly number[]; readonly tint: number }[];
  readonly marks: readonly { readonly x: number; readonly z: number; readonly color: Rgb }[];
}

/** How bright a block's district colour is on the map, and how wide a line and a mark are. */
const BLOCK_SHADE = 0.32;
const LINE_M = 5;
const MARK_M = 16;

/** The map's light: its emissive and nothing else. */
export function mapEnvironment(): Environment {
  return createEnvironment({
    directionalColor: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    nightFactor: 1,
    emissiveGain: 1,
    fogDensity: 0,
  });
}

export function buildMapMesh(input: MapInput): MeshData {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const quad = (
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    y: number,
    color: Rgb,
  ): void => {
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) {
      positions.push(p[0] as number, y, p[1] as number);
      colors.push(...color);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const accent = new Map(input.districts.map((d) => [d.index, unpack(d.accent)]));
  for (const block of input.blocks) {
    const c = accent.get(block.district) ?? [0.5, 0.5, 0.5];
    const shade: Rgb = [c[0] * BLOCK_SHADE, c[1] * BLOCK_SHADE, c[2] * BLOCK_SHADE];
    const base = positions.length / 3;
    const n = block.outline.length / 2;
    for (let i = 0; i < n; i++) {
      positions.push(block.outline[i * 2] as number, 0, block.outline[i * 2 + 1] as number);
      colors.push(...shade);
    }
    for (const t of earClip(block.outline)) indices.push(base + t);
  }
  for (const line of input.lines) {
    const color = unpack(line.tint);
    const n = line.path.length / 3;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = line.path[i * 3] as number;
      const az = line.path[i * 3 + 2] as number;
      const bx = line.path[j * 3] as number;
      const bz = line.path[j * 3 + 2] as number;
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (-(bz - az) / len) * (LINE_M / 2);
      const nz = ((bx - ax) / len) * (LINE_M / 2);
      quad(
        [ax + nx, az + nz],
        [bx + nx, bz + nz],
        [bx - nx, bz - nz],
        [ax - nx, az - nz],
        0.5,
        color,
      );
    }
  }
  const h = MARK_M / 2;
  for (const m of input.marks) {
    quad(
      [m.x - h, m.z - h],
      [m.x + h, m.z - h],
      [m.x + h, m.z + h],
      [m.x - h, m.z + h],
      1,
      m.color,
    );
  }
  /* Every triangle turned to face up, whichever way its outline or ribbon wound: the renderer
     culls a face turned away, and the map is only ever seen from above. */
  for (let t = 0; t < indices.length; t += 3) {
    const a = (indices[t] as number) * 3;
    const b = (indices[t + 1] as number) * 3;
    const c = (indices[t + 2] as number) * 3;
    const up =
      ((positions[b + 2] as number) - (positions[a + 2] as number)) *
        ((positions[c] as number) - (positions[a] as number)) -
      ((positions[b] as number) - (positions[a] as number)) *
        ((positions[c + 2] as number) - (positions[a + 2] as number));
    if (up < 0) {
      indices[t + 1] = c / 3;
      indices[t + 2] = b / 3;
    }
  }
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  return {
    positions: Float32Array.from(positions),
    normals,
    colors: Float32Array.from(colors),
    emissive: new Float32Array(count).fill(1),
    indices: Uint32Array.from(indices),
  };
}

/** 0xRRGGBBAA, sRGB, as a linear colour. */
export function unpack(rgba: number): Rgb {
  const linear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [linear((rgba >>> 24) & 255), linear((rgba >>> 16) & 255), linear((rgba >>> 8) & 255)];
}

/** A simple polygon's triangles, x z a corner, as indices into its corners: ear clipping, whichever way it winds. */
export function earClip(outline: readonly number[]): number[] {
  const n = outline.length / 2;
  const x = (i: number): number => outline[i * 2] as number;
  const z = (i: number): number => outline[i * 2 + 1] as number;
  let area = 0;
  for (let i = 0; i < n; i++) area += x(i) * z((i + 1) % n) - x((i + 1) % n) * z(i);
  const ccw = area > 0;
  const left = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const cross = (a: number, b: number, c: number): number =>
    (x(b) - x(a)) * (z(c) - z(a)) - (z(b) - z(a)) * (x(c) - x(a));
  const inside = (p: number, a: number, b: number, c: number): boolean => {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    /* On an edge counts: a concave corner lying on a candidate's long edge must stop it. */
    return ccw ? d1 >= 0 && d2 >= 0 && d3 >= 0 : d1 <= 0 && d2 <= 0 && d3 <= 0;
  };
  let guard = 0;
  while (left.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < left.length; k++) {
      const a = left[(k + left.length - 1) % left.length] as number;
      const b = left[k] as number;
      const c = left[(k + 1) % left.length] as number;
      const turn = cross(a, b, c);
      if (ccw ? turn <= 0 : turn >= 0) continue;
      if (left.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      out.push(a, b, c);
      left.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (left.length === 3) out.push(left[0] as number, left[1] as number, left[2] as number);
  return out;
}

/**
 * Which district a point stands in: the block holding it, found through a grid of the blocks'
 * bounds so a lookup tests a handful rather than every block. Built once; a lookup allocates
 * nothing.
 */
export class DistrictIndex {
  private readonly cells = new Map<number, number[]>();

  constructor(
    private readonly blocks: readonly {
      readonly district: number;
      readonly outline: readonly number[];
    }[],
    private readonly cell = 100,
  ) {
    blocks.forEach((b, i) => {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < b.outline.length; k += 2) {
        x0 = Math.min(x0, b.outline[k] as number);
        x1 = Math.max(x1, b.outline[k] as number);
        z0 = Math.min(z0, b.outline[k + 1] as number);
        z1 = Math.max(z1, b.outline[k + 1] as number);
      }
      for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
        for (let gz = Math.floor(z0 / cell); gz <= Math.floor(z1 / cell); gz++) {
          const key = (gx + 1000) * 2048 + (gz + 1000);
          const list = this.cells.get(key) ?? [];
          list.push(i);
          this.cells.set(key, list);
        }
      }
    });
  }

  /** The district index at (x, z), or −1 in a street. */
  at(x: number, z: number): number {
    const key = (Math.floor(x / this.cell) + 1000) * 2048 + (Math.floor(z / this.cell) + 1000);
    const list = this.cells.get(key);
    if (list === undefined) return -1;
    for (let k = 0; k < list.length; k++) {
      const b = this.blocks[list[k] as number];
      if (b !== undefined && holds(b.outline, x, z)) return b.district;
    }
    return -1;
  }
}

/** Whether the polygon holds (x, z), by the crossings of a ray along +x. */
function holds(outline: readonly number[], x: number, z: number): boolean {
  let inside = false;
  const n = outline.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = outline[i * 2] as number;
    const zi = outline[i * 2 + 1] as number;
    const xj = outline[j * 2] as number;
    const zj = outline[j * 2 + 1] as number;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

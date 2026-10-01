/**
 * Glass that the source draws in the body's material, found where another copy of the model keeps
 * its glass.
 *
 * **The commonest lamp in the source has no glass.** One street lamp is placed some three and a
 * half thousand times as a light variant of a single material, its panes faces of the iron, while
 * a rarer, heavier variant of the same lamp carries its panes as a part of their own; so the glass
 * of nearly every lamp in the city could not be declared glass by its material's name, and drew as
 * an opaque white box round the bulb. The light variant's panes do not even sample the region of
 * the picture the heavy one's glass does — measured, 1 of its 220 faces at the panes' height — but
 * they lie where its glass lies: the two variants share their frame and their shape.
 *
 * So a face of a piece wearing the same picture as a glass part's piece, of the same size, whose
 * centre lies on that glass, within `NEAR` of its plane and inside one of its triangles, and faces
 * the way it does, is a pane, and is cut out as
 * a part of its own wearing the glass part's material. What it gives up: a variant modelled in a
 * different frame, whose panes are not found. What would make it wrong is an opaque face lying on
 * the glass, which a lamp does not have.
 */
import type { MeshData } from '@driftengine/drft';

import type { KitPart, KitPiece } from './kit.ts';

/**
 * How near a face's centre must lie to the glass's plane, metres, inside one of its triangles. At
 * four centimetres and with that much slack at the edges, the iron bars framing each pane were
 * taken as glass too: 2,461 faces of a variant whose own glass is 272.
 */
const NEAR = 0.012;
/** How nearly it must face the way the glass does there, as a cosine. */
const FACING = 0.8;
/** How alike two pieces' sizes must be to be variants of one model, as a share of the larger. */
const ALIKE = 0.05;

interface Glass {
  readonly part: KitPart;
  readonly image: number;
  readonly bounds: Float32Array;
  /** Each glass triangle's corners and unit normal, twelve floats a triangle. */
  readonly triangles: Float32Array;
}

/** Cut every pane out of a piece that keeps its glass in its body; how many parts gave some up. */
export function splitPanes(
  pieces: ReadonlyMap<string, KitPiece>,
  isGlass: (name: string) => boolean,
): number {
  const glasses: Glass[] = [];
  for (const piece of pieces.values()) {
    for (const part of piece.parts) {
      if (!isGlass(part.source?.idName() ?? part.material.name)) continue;
      /* The picture its piece's body wears names the model; the glass may wear another. */
      const body = piece.parts.find((p) => p !== part && p.images.albedo >= 0);
      if (body === undefined) continue;
      glasses.push({
        part,
        image: body.images.albedo,
        bounds: piece.bounds,
        triangles: trianglesOf(part.mesh),
      });
    }
  }
  let split = 0;
  for (const piece of pieces.values()) {
    if (piece.parts.some((p) => isGlass(p.source?.idName() ?? p.material.name))) continue;
    const count = piece.parts.length;
    for (let i = 0; i < count; i++) {
      const part = piece.parts[i] as KitPart;
      const glass = glasses.find(
        (g) => g.image === part.images.albedo && alike(g.bounds, piece.bounds),
      );
      if (glass === undefined) continue;
      const panes: number[] = [];
      const rest: number[] = [];
      const p = part.mesh.positions;
      const idx = part.mesh.indices;
      for (let t = 0; t < idx.length; t += 3) {
        const a = (idx[t] as number) * 3;
        const b = (idx[t + 1] as number) * 3;
        const c = (idx[t + 2] as number) * 3;
        const cx = ((p[a] as number) + (p[b] as number) + (p[c] as number)) / 3;
        const cy = ((p[a + 1] as number) + (p[b + 1] as number) + (p[c + 1] as number)) / 3;
        const cz = ((p[a + 2] as number) + (p[b + 2] as number) + (p[c + 2] as number)) / 3;
        const ux = (p[b] as number) - (p[a] as number);
        const uy = (p[b + 1] as number) - (p[a + 1] as number);
        const uz = (p[b + 2] as number) - (p[a + 2] as number);
        const vx = (p[c] as number) - (p[a] as number);
        const vy = (p[c + 1] as number) - (p[a + 1] as number);
        const vz = (p[c + 2] as number) - (p[a + 2] as number);
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const n = Math.hypot(nx, ny, nz) || 1;
        (onGlass(glass.triangles, cx, cy, cz, nx / n, ny / n, nz / n) ? panes : rest).push(t);
      }
      if (panes.length === 0 || rest.length === 0) continue;
      piece.parts[i] = { ...part, mesh: subset(part.mesh, rest) };
      piece.parts.push({
        mesh: subset(part.mesh, panes),
        material: glass.part.material,
        source: glass.part.source,
        images: glass.part.images,
        wears: glass.part.source,
      });
      /* No slot of a copy stands for the panes: the part names what it wears. */
      (piece.slotOf as number[]).push(-1);
      split++;
    }
  }
  return split;
}

/** Whether two pieces are one size, each extent within `ALIKE` of the other's. */
function alike(a: Float32Array, b: Float32Array): boolean {
  for (let k = 0; k < 3; k++) {
    const ea = (a[k + 3] as number) - (a[k] as number);
    const eb = (b[k + 3] as number) - (b[k] as number);
    if (Math.abs(ea - eb) > ALIKE * Math.max(ea, eb, 1e-3)) return false;
  }
  return true;
}

/** Each triangle of `mesh` as its three corners and its unit normal, twelve floats a triangle. */
function trianglesOf(mesh: MeshData): Float32Array {
  const p = mesh.positions;
  const idx = mesh.indices;
  const out = new Float32Array((idx.length / 3) * 12);
  for (let t = 0, o = 0; t < idx.length; t += 3, o += 12) {
    for (let k = 0; k < 3; k++) {
      const v = (idx[t + k] as number) * 3;
      out[o + k * 3] = p[v] as number;
      out[o + k * 3 + 1] = p[v + 1] as number;
      out[o + k * 3 + 2] = p[v + 2] as number;
    }
    const ux = (out[o + 3] as number) - (out[o] as number);
    const uy = (out[o + 4] as number) - (out[o + 1] as number);
    const uz = (out[o + 5] as number) - (out[o + 2] as number);
    const vx = (out[o + 6] as number) - (out[o] as number);
    const vy = (out[o + 7] as number) - (out[o + 1] as number);
    const vz = (out[o + 8] as number) - (out[o + 2] as number);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const n = Math.hypot(nx, ny, nz) || 1;
    out[o + 9] = nx / n;
    out[o + 10] = ny / n;
    out[o + 11] = nz / n;
  }
  return out;
}

/** Whether (x, y, z) lies within `NEAR` of a glass triangle facing nearly as (nx, ny, nz) does. */
function onGlass(
  tris: Float32Array,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
): boolean {
  for (let o = 0; o < tris.length; o += 12) {
    const gx = tris[o + 9] as number;
    const gy = tris[o + 10] as number;
    const gz = tris[o + 11] as number;
    /* Either way round: a pane is seen from both sides and one variant may wind it the other way. */
    if (Math.abs(gx * nx + gy * ny + gz * nz) < FACING) continue;
    const off =
      (x - (tris[o] as number)) * gx +
      (y - (tris[o + 1] as number)) * gy +
      (z - (tris[o + 2] as number)) * gz;
    if (Math.abs(off) > NEAR) continue;
    if (inside(tris, o, x - off * gx, y - off * gy, z - off * gz, gx, gy, gz)) return true;
  }
  return false;
}

/** Whether a point on a triangle's plane is inside it. */
function inside(
  t: Float32Array,
  o: number,
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
): boolean {
  for (let e = 0; e < 3; e++) {
    const a = o + e * 3;
    const b = o + ((e + 1) % 3) * 3;
    const ex = (t[b] as number) - (t[a] as number);
    const ey = (t[b + 1] as number) - (t[a + 1] as number);
    const ez = (t[b + 2] as number) - (t[a + 2] as number);
    const qx = px - (t[a] as number);
    const qy = py - (t[a + 1] as number);
    const qz = pz - (t[a + 2] as number);
    /* Which side of the edge, along the normal: inside is positive for the triangle's own winding. */
    const side = (ey * qz - ez * qy) * nx + (ez * qx - ex * qz) * ny + (ex * qy - ey * qx) * nz;
    if (side < 0) return false;
  }
  return true;
}

/** The triangles starting at `starts` of `mesh`, with every per-vertex attribute it carries. */
function subset(mesh: MeshData, starts: readonly number[]): MeshData {
  const idx = mesh.indices;
  const count = mesh.positions.length / 3;
  const remap = new Map<number, number>();
  const order: number[] = [];
  const indices = new Uint32Array(starts.length * 3);
  starts.forEach((t, n) => {
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k] as number;
      let at = remap.get(v);
      if (at === undefined) {
        at = order.length;
        remap.set(v, at);
        order.push(v);
      }
      indices[n * 3 + k] = at;
    }
  });
  const out: Record<string, unknown> = { indices };
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

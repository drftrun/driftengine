/**
 * Crease-angle normal smoothing: every vertex takes the average of the faces meeting at its
 * position whose normals lie within the crease angle of its own, so a cylinder's side goes round
 * while its rim stays sharp.
 *
 * **Weighted by the corner angle each face makes at the vertex, not by area.** A quad split into
 * two triangles meets a vertex with one triangle at one corner and two at the next, so area weights
 * favour whichever side the split fell on and lean every normal of a smooth side a degree or two off
 * true. The corner angle a quad makes is 90° however it was split, which is what makes the average
 * belong to the shape rather than to its triangulation.
 *
 * Positions are welded at 1e-5 for the lookup only; the solid keeps its vertices, indices and
 * texture coordinates, and each vertex's incoming normal chooses which faces it joins — so a
 * faceted solid's own face normals decide the creases.
 */
import type { Solid } from './solid.ts';

export function smoothSolidNormals(solid: Solid, creaseDeg: number): Solid {
  const p = solid.positions;
  const idx = solid.indices;
  const count = p.length / 3;
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);

  const weld = new Map<string, number>();
  const group = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    const key = `${Math.round((p[v * 3] ?? 0) * 1e5)},${Math.round((p[v * 3 + 1] ?? 0) * 1e5)},${Math.round((p[v * 3 + 2] ?? 0) * 1e5)}`;
    let id = weld.get(key);
    if (id === undefined) {
      id = weld.size;
      weld.set(key, id);
    }
    group[v] = id;
  }

  /* For each welded position, the faces meeting there: unit normal and the corner angle. */
  const corners: number[][] = Array.from({ length: weld.size }, () => []);
  for (let t = 0; t < idx.length; t += 3) {
    const ids = [idx[t] ?? 0, idx[t + 1] ?? 0, idx[t + 2] ?? 0];
    const at = (i: number, c: number): number => p[(ids[i] ?? 0) * 3 + c] ?? 0;
    const ux = at(1, 0) - at(0, 0);
    const uy = at(1, 1) - at(0, 1);
    const uz = at(1, 2) - at(0, 2);
    const vx = at(2, 0) - at(0, 0);
    const vy = at(2, 1) - at(0, 1);
    const vz = at(2, 2) - at(0, 2);
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let k = 0; k < 3; k++) {
      const o = (k + 1) % 3;
      const q = (k + 2) % 3;
      const ax = at(o, 0) - at(k, 0);
      const ay = at(o, 1) - at(k, 1);
      const az = at(o, 2) - at(k, 2);
      const bx = at(q, 0) - at(k, 0);
      const by = at(q, 1) - at(k, 1);
      const bz = at(q, 2) - at(k, 2);
      const denom = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) || 1;
      const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / denom)));
      corners[group[ids[k] ?? 0] ?? 0]?.push(nx, ny, nz, angle);
    }
  }

  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const own = [
      solid.normals[v * 3] ?? 0,
      solid.normals[v * 3 + 1] ?? 0,
      solid.normals[v * 3 + 2] ?? 0,
    ];
    const list = corners[group[v] ?? 0] ?? [];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let c = 0; c < list.length; c += 4) {
      const fx = list[c] ?? 0;
      const fy = list[c + 1] ?? 0;
      const fz = list[c + 2] ?? 0;
      if (fx * (own[0] ?? 0) + fy * (own[1] ?? 0) + fz * (own[2] ?? 0) < cosCrease) continue;
      const w = list[c + 3] ?? 0;
      sx += fx * w;
      sy += fy * w;
      sz += fz * w;
    }
    const len = Math.hypot(sx, sy, sz);
    if (len < 1e-12) {
      normals[v * 3] = own[0] ?? 0;
      normals[v * 3 + 1] = own[1] ?? 0;
      normals[v * 3 + 2] = own[2] ?? 0;
    } else {
      normals[v * 3] = sx / len;
      normals[v * 3 + 1] = sy / len;
      normals[v * 3 + 2] = sz / len;
    }
  }
  return { positions: solid.positions, normals, uvs: solid.uvs, indices: solid.indices };
}

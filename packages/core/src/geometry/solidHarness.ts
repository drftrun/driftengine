/**
 * Checks a closed surface can be held to, for the solid and CSG tests.
 *
 * **Not a `.test.ts` file**, for the reason `rendererHarness.ts` gives: Vitest registers a test
 * when the file declaring it is imported, so helpers living beside tests would re-run them in every
 * file that imported them.
 *
 * `edgesPairOnce` welds by position and asks that every edge be shared by exactly two triangles
 * running opposite ways, which is what closed and consistently wound means. `normalsFaceOutward`
 * asks that every vertex normal lie on the outward side of its triangle. The matrices are
 * column-major, as `transformSolid` takes them.
 */
import type { Solid } from './solid.ts';

export function edgesPairOnce(solid: Solid): boolean {
  const p = solid.positions;
  const key = (i: number): string =>
    `${Math.round((p[i * 3] ?? 0) * 1e5)},${Math.round((p[i * 3 + 1] ?? 0) * 1e5)},${Math.round((p[i * 3 + 2] ?? 0) * 1e5)}`;
  const directed = new Map<string, number>();
  const idx = solid.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(idx[t + e] ?? 0);
      const b = key(idx[t + ((e + 1) % 3)] ?? 0);
      if (a === b) continue;
      const k = `${a}>${b}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of directed) {
    const [a, b] = k.split('>');
    if (n !== 1 || directed.get(`${b}>${a}`) !== 1) return false;
  }
  return directed.size > 0;
}

export function normalsFaceOutward(solid: Solid): boolean {
  const p = solid.positions;
  const n = solid.normals;
  const idx = solid.indices;
  const at = (i: number, c: number): number => p[i * 3 + c] ?? 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] ?? 0;
    const b = idx[t + 1] ?? 0;
    const c = idx[t + 2] ?? 0;
    const ux = at(b, 0) - at(a, 0);
    const uy = at(b, 1) - at(a, 1);
    const uz = at(b, 2) - at(a, 2);
    const vx = at(c, 0) - at(a, 0);
    const vy = at(c, 1) - at(a, 1);
    const vz = at(c, 2) - at(a, 2);
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    if (Math.hypot(gx, gy, gz) < 1e-12) continue;
    for (const v of [a, b, c]) {
      if (gx * (n[v * 3] ?? 0) + gy * (n[v * 3 + 1] ?? 0) + gz * (n[v * 3 + 2] ?? 0) <= 0) {
        return false;
      }
    }
  }
  return true;
}

export function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(x: number, y: number, z: number): number[] {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

export function rotationX(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function rotationY(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

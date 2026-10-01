import { describe, expect, it } from 'vitest';

import { DistrictIndex, buildMapMesh, earClip } from './mapMesh';

/* An L: a 30 × 30 square missing its 15 × 15 top-right quarter, 675 m², wound either way. */
const L = [0, 0, 30, 0, 30, 15, 15, 15, 15, 30, 0, 30];
const reversed = (o: number[]): number[] => {
  const out: number[] = [];
  for (let i = o.length / 2 - 1; i >= 0; i--) out.push(o[i * 2] as number, o[i * 2 + 1] as number);
  return out;
};
function area(outline: number[], tris: number[]): number {
  let sum = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map((i) => [
      outline[(i as number) * 2] as number,
      outline[(i as number) * 2 + 1] as number,
    ]) as [number[], number[], number[]];
    sum +=
      Math.abs(
        ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
          ((b[1] as number) - (a[1] as number)) * ((c[0] as number) - (a[0] as number)),
      ) / 2;
  }
  return sum;
}

describe('the map', () => {
  it('A CONCAVE BLOCK IS FILLED EXACTLY, IN FOUR TRIANGLES, WHICHEVER WAY IT WINDS', () => {
    /* And started at its concave corner, which the clipper then tries first. */
    const cornerFirst = [15, 15, 15, 30, 0, 30, 0, 0, 30, 0, 30, 15];
    for (const outline of [L, reversed(L), cornerFirst, reversed(cornerFirst)]) {
      const tris = earClip(outline);
      expect(tris.length).toBe(4 * 3);
      expect(area(outline, tris)).toBeCloseTo(675, 6);
    }
  });

  it('EVERY TRIANGLE OF THE MAP FACES UP, SO NONE IS CULLED FROM ABOVE', () => {
    const mesh = buildMapMesh({
      districts: [{ index: 0, accent: 0xff8000ff }],
      blocks: [
        { district: 0, outline: L },
        { district: 0, outline: reversed(L).map((v) => v + 100) },
      ],
      lines: [{ path: [0, 14, -50, 100, 14, -50, 100, 14, -150], tint: 0x60c8ffff }],
      marks: [{ x: 60, z: 60, color: [1, 1, 1] }],
    });
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]].map(
        (i) => (i as number) * 3,
      ) as [number, number, number];
      const up =
        ((p[b + 2] as number) - (p[a + 2] as number)) * ((p[c] as number) - (p[a] as number)) -
        ((p[b] as number) - (p[a] as number)) * ((p[c + 2] as number) - (p[a + 2] as number));
      expect(up).toBeGreaterThan(0);
    }
  });

  it('A POINT IS IN THE DISTRICT OF THE BLOCK HOLDING IT, AND IN NONE IN A STREET', () => {
    const index = new DistrictIndex([
      { district: 3, outline: L },
      { district: 5, outline: [200, 0, 260, 0, 260, 60, 200, 60] },
    ]);
    /* The L's foot, its missing quarter, the square, and the street between. */
    expect([index.at(5, 25), index.at(25, 25), index.at(230, 30), index.at(100, 30)]).toEqual([
      3, -1, 5, -1,
    ]);
  });
});

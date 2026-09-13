import { describe, expect, test } from 'vitest';
import { Spline } from './spline.ts';
import { RIBBON_COLLIDER_GIVE_M, buildRibbon } from './ribbon.ts';
import type { SplinePoint } from './spline.ts';
import type { MeshData } from '../render/mesh.ts';

function pt(x: number, y: number, z: number, bankRad = 0, widthM = 6): SplinePoint {
  return { x, y, z, bankRad, widthM };
}

const COLOR: [number, number, number] = [0.5, 0.6, 0.7];

/**
 * Deliberately *not* at y = 0. The signed-volume check below integrates r·n
 * over the surface, and a face lying in a plane through the origin contributes
 * exactly nothing to it — so a ribbon resting on y = 0 has a top face whose
 * winding the test cannot see at all. It read as passing until the winding was
 * flipped on purpose and it still passed.
 */
const FIXTURE_Y = 5;

function straight(widthM = 6, bankRad = 0): Spline {
  return new Spline([
    pt(0, FIXTURE_Y, 0, bankRad, widthM),
    pt(20, FIXTURE_Y, 0, bankRad, widthM),
    pt(40, FIXTURE_Y, 0, bankRad, widthM),
  ]);
}

/** Position of vertex `i`, quantised so coincident corners share a key. */
function key(mesh: MeshData, i: number): string {
  const q = (v: number): number => Math.round(v * 10_000);
  return `${q(mesh.positions[i * 3] ?? 0)},${q(mesh.positions[i * 3 + 1] ?? 0)},${q(mesh.positions[i * 3 + 2] ?? 0)}`;
}

describe('buildRibbon', () => {
  test('the surface is closed, so there is nowhere to fall through', () => {
    /*
     * Watertightness stated as the property that actually matters, rather than
     * as "vertices are shared": in a closed surface every edge belongs to
     * exactly two triangles. A seam between cross-sections, a missing end cap
     * or a quad wound the wrong way all show up here as an edge with one
     * triangle, and every one of them is a hole a character falls into.
     */
    const spline = new Spline([pt(0, 0, 0), pt(12, 3, 4, 0.3), pt(24, 3, 12, 0.3), pt(30, 0, 20)]);
    const { mesh } = buildRibbon(spline, { color: COLOR, stepM: 2 });
    const edges = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = key(mesh, mesh.indices[t] ?? 0);
      const b = key(mesh, mesh.indices[t + 1] ?? 0);
      const c = key(mesh, mesh.indices[t + 2] ?? 0);
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const id = p < q ? `${p}|${q}` : `${q}|${p}`;
        edges.set(id, (edges.get(id) ?? 0) + 1);
      }
    }
    const open = [...edges.entries()].filter(([, count]) => count !== 2);
    expect(open.map(([id, count]) => `${id} used ${count}x`)).toEqual([]);
  });

  test('the slab is wound outward, and encloses the volume it should', () => {
    /*
     * Back-face culling means a reversed winding is not a subtle shading bug —
     * the surface is simply not drawn, with no GL error to find it by, and this
     * project has already lost two sessions to exactly that on other meshes.
     *
     * Checked by signed volume rather than by comparing each triangle to its
     * own stored normal, which would be circular: the builder derives the
     * normal *from* the winding, so the two can never disagree. Over a closed
     * mesh the divergence theorem gives the enclosed volume, positive only when
     * the surface faces out — and comparing it to length × width × thickness
     * catches a single flipped quad as well as a globally inverted one.
     */
    const spline = straight();
    const { mesh } = buildRibbon(spline, { color: COLOR, stepM: 2, thicknessM: 0.6 });
    let volume6 = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const i = (mesh.indices[t] ?? 0) * 3;
      const j = (mesh.indices[t + 1] ?? 0) * 3;
      const k = (mesh.indices[t + 2] ?? 0) * 3;
      const ax = mesh.positions[i] ?? 0,
        ay = mesh.positions[i + 1] ?? 0,
        az = mesh.positions[i + 2] ?? 0;
      const bx = mesh.positions[j] ?? 0,
        by = mesh.positions[j + 1] ?? 0,
        bz = mesh.positions[j + 2] ?? 0;
      const cx = mesh.positions[k] ?? 0,
        cy = mesh.positions[k + 1] ?? 0,
        cz = mesh.positions[k + 2] ?? 0;
      volume6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    expect(volume6 / 6).toBeCloseTo(spline.lengthM * 6 * 0.6, 1);
  });

  test('every stored normal is a unit vector', () => {
    const { mesh } = buildRibbon(straight(6, 0.3), { color: COLOR, stepM: 2 });
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const length = Math.hypot(
        mesh.normals[i] ?? 0,
        mesh.normals[i + 1] ?? 0,
        mesh.normals[i + 2] ?? 0,
      );
      expect(length, `normal ${i / 3}`).toBeCloseTo(1, 5);
    }
  });

  test('the ribbon is as wide as the spline says', () => {
    const { mesh } = buildRibbon(straight(7), { color: COLOR, stepM: 2 });
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const z = mesh.positions[i + 2] ?? 0;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    expect(maxZ - minZ).toBeCloseTo(7, 2);
  });

  test('a hole in the ribbon is a hole you can fall through', () => {
    /*
     * The interrupted track: where the surface stops, there must be no geometry
     * *and* no collider. A hole that is drawn but still solid is the worst of
     * both — it looks like a jump and plays like a floor.
     */
    const { mesh, colliders } = buildRibbon(straight(), {
      color: COLOR,
      stepM: 1,
      holes: [{ fromM: 15, toM: 25 }],
    });
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      expect(x > 16 && x < 24, `geometry at x=${x} is inside the hole`).toBe(false);
    }
    for (const box of colliders) {
      expect(box.minX > 16 && box.maxX < 24, 'a collider survives inside the hole').toBe(false);
    }
  });

  test('the surface outside a hole is still solid all the way along', () => {
    // The other half of the same defect: a hole that eats its neighbours leaves
    // an approach the player cannot take off from.
    const { colliders } = buildRibbon(straight(), {
      color: COLOR,
      stepM: 1,
      holes: [{ fromM: 15, toM: 25 }],
    });
    for (const x of [1, 5, 10, 14, 26, 30, 39]) {
      const covered = colliders.some((box) => box.minX <= x && box.maxX >= x);
      expect(covered, `no collider at x=${x}`).toBe(true);
    }
  });

  test('a collider is the drawn slab itself, not a box around it', () => {
    /*
     * The boxes used to be a containment shell sunk a hand's width below the
     * surface, because a world-axis lid flush with the floor fought the character
     * for the ground under their feet. A collider now carries the slab it was
     * built from as a convex hull, so the lid IS the drawn surface — the
     * narrow phase resolves the banked face itself, and the old fight cannot
     * happen because a body meets a slope, not a world-axis step. The bounds
     * are only the broad phase, so they must enclose the hull and reach no
     * higher than what is drawn.
     */
    const spline = straight(6, 0.35);
    const { mesh, colliders } = buildRibbon(spline, { color: COLOR, stepM: 1, colliderGiveM: 0 });
    let highest = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      highest = Math.max(highest, mesh.positions[i] ?? 0);
    }
    expect(colliders.length).toBeGreaterThan(0);
    for (const box of colliders) {
      expect(box.shape, 'a collider carries its drawn shape').toBeDefined();
      expect(box.maxY).toBeLessThanOrEqual(highest + 1e-3);
      expect(box.maxY).toBeGreaterThan(FIXTURE_Y - 1e-3);
    }

    // The banked top is a face of the hull: collision at the drawn inclination,
    // whichever way round the spline signs its bank.
    const bank = 0.35;
    const normals = colliders[0]?.shape?.faceNormals ?? new Float32Array(0);
    let banked = false;
    for (let i = 0; i < normals.length; i += 3) {
      const ny = (normals[i + 1] ?? 0) * Math.cos(bank);
      const nz = (normals[i + 2] ?? 0) * Math.sin(bank);
      const aligned = Math.max(Math.abs(ny + nz), Math.abs(ny - nz));
      if (aligned > 1 - 1e-3 && Math.abs(normals[i] ?? 0) < 0.05) banked = true;
    }
    expect(banked, 'the bank survives into the collision shape').toBe(true);
  });

  test('the collider give leaves the ride to the smooth surface', () => {
    /*
     * A consumer's ground query rides the smooth curve; the hulls are the
     * faceted mesh. At a crest a facet ridge stands a few centimetres proud of
     * the curve, and with the hulls exactly flush each ridge is a micro-wall
     * under a character's feet, and the track stops reading as smooth at all. The
     * give drops only the
     * hull's top below the drawn surface, by a configurable tolerance, so the
     * smooth query owns the top few centimetres and the hull owns everything
     * beneath.
     */
    const spline = straight(6, 0.35);
    const flush = buildRibbon(spline, { color: COLOR, colliderGiveM: 0 }).colliders;
    const eased = buildRibbon(spline, { color: COLOR }).colliders;
    expect(eased.length).toBe(flush.length);
    for (let i = 0; i < eased.length; i++) {
      const gap = (flush[i]?.maxY ?? 0) - (eased[i]?.maxY ?? 0);
      expect(gap).toBeGreaterThan(RIBBON_COLLIDER_GIVE_M * 0.5);
      expect(gap).toBeLessThanOrEqual(RIBBON_COLLIDER_GIVE_M + 1e-6);
      // Only the top eases: the slab's underside still seals the world.
      expect(eased[i]?.minY ?? 0).toBeCloseTo(flush[i]?.minY ?? 0, 6);
    }
  });

  test('a degenerate spline produces no geometry rather than NaN', () => {
    for (const points of [[], [pt(1, 2, 3)], [pt(1, 2, 3), pt(1, 2, 3)]]) {
      const { mesh, colliders } = buildRibbon(new Spline(points), { color: COLOR });
      expect(mesh.indices.length).toBe(0);
      expect(colliders.length).toBe(0);
      for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
    }
  });

  test('a hole covering the whole ribbon leaves nothing behind', () => {
    const { mesh, colliders } = buildRibbon(straight(), {
      color: COLOR,
      holes: [{ fromM: -10, toM: 999 }],
    });
    expect(mesh.indices.length).toBe(0);
    expect(colliders.length).toBe(0);
  });
});

test('a band is solid whichever way round its lateral range is given', () => {
  /*
   * The bug this exists to prevent is invisible geometry, which is the worst kind: a slab
   * built from a descending range came out inside-out — signed volume +256 one way and
   * -256 the other — and with back-face culling an inside-out slab cannot be seen from
   * outside. Under a canal bridge the ceiling looks glassy and transparent from below, and
   * fixing one side leaves the opposite one untouched,
   * because a canal on one hand multiplies every lateral offset by -1 and so reverses
   * every range it passes.
   *
   * Signed volume rather than normals: normals are computed from the winding, so asking
   * them whether the winding is right is asking the same question twice — a mistake this
   * repo has already made once, in the ribbon's original winding test.
   */
  const spline = straight();
  const volumeOf = (fromU: number, toU: number): number => {
    const mesh = buildRibbon(spline, {
      color: [0.5, 0.5, 0.5],
      stepM: 4,
      thicknessM: 0.8,
      lateralFromM: fromU,
      lateralToM: toU,
      liftM: 4,
    }).mesh;
    let volume = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = (mesh.indices[i] as number) * 3;
      const b = (mesh.indices[i + 1] as number) * 3;
      const c = (mesh.indices[i + 2] as number) * 3;
      const ax = mesh.positions[a] as number;
      const ay = mesh.positions[a + 1] as number;
      const az = mesh.positions[a + 2] as number;
      const bx = mesh.positions[b] as number;
      const by = mesh.positions[b + 1] as number;
      const bz = mesh.positions[b + 2] as number;
      const cx = mesh.positions[c] as number;
      const cy = mesh.positions[c + 1] as number;
      const cz = mesh.positions[c + 2] as number;
      volume +=
        (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return volume;
  };

  expect(volumeOf(-2, 2), 'ascending range is inside-out').toBeGreaterThan(0);
  expect(volumeOf(2, -2), 'descending range is inside-out').toBeGreaterThan(0);
});

test('a kerb is solid on both edges of the surface', () => {
  /*
   * The same defect as the test above, in the costume that test did not cover.
   *
   * That one guards the `lateralFromM`/`lateralToM` path, because a canal multiplies its
   * offsets by a side and so reverses them. A *kerb* reverses them too and by the same
   * arithmetic — `edgeSide = +1` spans `+half` down to `+half - band`, a descending range
   * — but it arrives through `edgeBandM`/`edgeSide` instead, so it went on being built
   * inside-out for a year with a green suite.
   *
   * Back-face culling then hides the top face of every kerb on one side of every route,
   * and what shows instead is the deck under it. With the depth layers already fixing
   * the other side, the right side's borders and lines still fought the main surface,
   * worst on curves.
   */
  const spline = straight();
  const volumeOf = (edgeSide: -1 | 1): number => {
    const mesh = buildRibbon(spline, {
      color: [0.5, 0.5, 0.5],
      stepM: 4,
      thicknessM: 0.22,
      edgeBandM: 0.7,
      edgeSide,
      liftM: 4,
    }).mesh;
    let volume = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = (mesh.indices[i] as number) * 3;
      const b = (mesh.indices[i + 1] as number) * 3;
      const c = (mesh.indices[i + 2] as number) * 3;
      const ax = mesh.positions[a] as number;
      const ay = mesh.positions[a + 1] as number;
      const az = mesh.positions[a + 2] as number;
      const bx = mesh.positions[b] as number;
      const by = mesh.positions[b + 1] as number;
      const bz = mesh.positions[b + 2] as number;
      const cx = mesh.positions[c] as number;
      const cy = mesh.positions[c + 1] as number;
      const cz = mesh.positions[c + 2] as number;
      volume +=
        (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return volume;
  };

  expect(volumeOf(-1), 'the left kerb is inside-out').toBeGreaterThan(0);
  expect(volumeOf(1), 'the right kerb is inside-out').toBeGreaterThan(0);
});

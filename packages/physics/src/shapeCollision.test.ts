import { describe, expect, it } from 'vitest';
import { AXIS_X, AXIS_Y, AXIS_Z, moveAxis, segmentHit } from './collide/index.ts';
import type { Body } from './collide/index.ts';
import { ColliderSet, boxCollider, colliderFromShape } from './colliderSet.ts';
import { boxShape, hullShape, sphereShape } from './shape.ts';

/**
 * A ribbon-like span: a slab 8 m long (+x), 4 m wide, banked about x by `bank`,
 * its top plane passing through (x, 10, 0) — the exact shape a stretch of
 * banked track hands the collider set.
 */
function bankedSlab(bank: number): number[] {
  const ny = Math.cos(bank);
  const nz = Math.sin(bank);
  const pts: number[] = [];
  for (const x of [0, 8]) {
    for (const z of [-2, 2]) {
      const topY = 10 - (z * nz) / ny;
      pts.push(x, topY, z);
      pts.push(x, topY - 0.6 * ny, z - 0.6 * nz);
    }
  }
  return pts;
}

const BANK = 0.72;
const COS = Math.cos(BANK);
const SIN = Math.sin(BANK);

function characterBody(x: number, y: number, z: number): Body {
  return { x, y, z, hx: 0.35, hy: 0.85, hz: 0.35 };
}

describe('hull colliders', () => {
  it('a falling body lands on the banked face, not on the box around it', () => {
    const set = new ColliderSet([colliderFromShape(hullShape(bankedSlab(BANK)))]);
    const body = characterBody(4, 14, 1.5);
    moveAxis(body, set, AXIS_Y, -8);

    // Upright box against the tilted plane: contact at the downhill corner.
    const reach = COS * 0.85 + SIN * 0.35;
    const expected = (COS * 10 + reach - SIN * 1.5) / COS;
    expect(body.y).toBeCloseTo(expected, 1);

    // The AABB around this slab tops out far above the low side. Landing there
    // would be the old bug: standing on air because the box said so.
    const aabbTop = 10 + 2 * (SIN / COS);
    expect(body.y + 0.85).toBeLessThan(aabbTop);

    // And it is ground now: pushing further down does not sink in.
    const sunk = moveAxis(body, set, AXIS_Y, -1);
    expect(Math.abs(sunk)).toBeLessThan(0.01);
  });

  it('clear air inside the old box is passable: collision lives at the drawn edge', () => {
    const hull = hullShape(bankedSlab(BANK));
    const set = new ColliderSet([colliderFromShape(hull)]);

    // Beside the slab's low edge, level with the empty corner of its AABB.
    const body = characterBody(4, 11, 3);
    const moved = moveAxis(body, set, AXIS_Z, -2);
    expect(moved).toBe(-2);

    // Kept honest by the contrast: the same volume as a plain box blocks here.
    const asBox = new ColliderSet([{ ...colliderFromShape(hull), shape: undefined }]);
    const boxBody = characterBody(4, 11, 3);
    const blockedAt = moveAxis(boxBody, asBox, AXIS_Z, -2);
    expect(blockedAt).toBeGreaterThan(-0.7);

    // Carrying on, the drawn face itself does stop the run.
    const more = moveAxis(body, set, AXIS_Z, -3);
    expect(more).toBeLessThan(-0.6);
    expect(more).toBeGreaterThan(-1.2);
  });

  it('a body tilted onto the bank is held by walls beyond it — no free pass', () => {
    // The transparent-wall regression: a tilted body permanently overlapping a
    // sunk collider lid had the escape hatch open forever. On a hull that IS
    // the drawn face, the aligned body does not overlap, so the hatch stays
    // shut and the wall past the slab still stops the run.
    const wall = { minX: 12, minY: 0, minZ: -10, maxX: 13, maxY: 20, maxZ: 10 };
    const set = new ColliderSet([colliderFromShape(hullShape(bankedSlab(BANK))), wall]);

    const body: Body = {
      x: 4,
      // Centre sits one half-height along the bank normal, a hair clear.
      y: 10 + 0.853 * COS,
      z: 0.853 * SIN,
      hx: 0.35,
      hy: 0.85,
      hz: 0.35,
      upX: 0,
      upY: COS,
      upZ: SIN,
      fwdX: 1,
      fwdY: 0,
      fwdZ: 0,
    };
    const moved = moveAxis(body, set, AXIS_X, 10);
    // Tilted about x, the body's x reach is its hz. Stopping at the wall is the
    // whole assertion — the old defect sailed through to the full 10.
    expect(moved).toBeGreaterThan(7.5);
    expect(moved).toBeLessThan(12 - 4 - 0.35 + 0.01);
  });
});

describe('shaped bodies', () => {
  it('a sphere rests at its radius from the banked face', () => {
    const set = new ColliderSet([colliderFromShape(hullShape(bankedSlab(BANK)))]);
    const body: Body = { x: 4, y: 14, z: 1, hx: 0.4, hy: 0.4, hz: 0.4, shape: sphereShape(0.4) };
    moveAxis(body, set, AXIS_Y, -8);
    const distance = COS * body.y + SIN * body.z - COS * 10;
    expect(distance).toBeCloseTo(0.4, 1);
  });

  it('a compound body collides as its parts, not as its nominal box', () => {
    const ceiling = { minX: -10, minY: 12, minZ: -10, maxX: 10, maxY: 13, maxZ: 10 };
    const wall = { minX: 5, minY: 0, minZ: -10, maxX: 6, maxY: 20, maxZ: 10 };
    const set = new ColliderSet([ceiling, wall]);

    // Nominal box says hy = 0.85, but the drawn body only reaches 0.5 up.
    const body: Body = {
      x: 0,
      y: 10,
      z: 0,
      hx: 0.35,
      hy: 0.85,
      hz: 0.35,
      parts: [
        { shape: boxShape(0.2, 0.5, 0.2), ox: 0, oy: 0, oz: 0 },
        { shape: boxShape(0.35, 0.2, 0.35), ox: 0, oy: -0.65, oz: 0 },
      ],
    };
    const up = moveAxis(body, set, AXIS_Y, 2);
    expect(up).toBeCloseTo(12 - 10.5, 2);

    // Sideways it is the wide foot part, not the narrow torso, that touches.
    const side = moveAxis(body, set, AXIS_X, 6);
    expect(side).toBeCloseTo(5 - 0.35, 2);
  });
});

describe('ColliderSet shapes', () => {
  it('carries a shape per collider and hands it back by index', () => {
    const hull = hullShape([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const set = new ColliderSet([
      colliderFromShape(hull),
      { minX: 5, minY: 5, minZ: 5, maxX: 6, maxY: 6, maxZ: 6 },
    ]);
    expect(set.shapeAt(0)).toBe(hull);
    expect(set.shapeAt(1)).toBeUndefined();
  });

  it('colliderFromShape bounds enclose the shape', () => {
    const collider = colliderFromShape(hullShape(bankedSlab(BANK)));
    expect(collider.minX).toBeCloseTo(0, 5);
    expect(collider.maxX).toBeCloseTo(8, 5);
    expect(collider.maxY).toBeCloseTo(10 + 2 * (SIN / COS), 5);
    expect(collider.shape).toBeDefined();
  });
});

describe('segmentHit through shapes', () => {
  it('a ray through the empty corner of a banked slab passes clear', () => {
    // The camera boom and the grapple both ask this question, and against the
    // broad-phase box they pulled in / anchored on drawn air over the low side
    // of every banked stretch — the camera visibly zooming on curves.
    const set = new ColliderSet([colliderFromShape(hullShape(bankedSlab(BANK)))]);
    const t = segmentHit(-1, 11, 1.5, 10, 0, 0, set, 0.2);
    expect(t).toBe(1);
  });

  it('a ray into the slab stops at the drawn face, not at the box around it', () => {
    const set = new ColliderSet([colliderFromShape(hullShape(bankedSlab(BANK)))]);
    const t = segmentHit(4, 14, 1.5, 0, -8, 0, set, 0);
    expect(t).toBeLessThan(1);
    const hitY = 14 - 8 * t;
    expect(hitY).toBeCloseTo(10 - 1.5 * (SIN / COS), 1);
  });
});

describe('boxCollider', () => {
  it('is the drawn box as both bounds and shape', () => {
    const collider = boxCollider(10, 5, -2, 1.5, 0.5, 2);
    expect(collider.minX).toBeCloseTo(8.5, 6);
    expect(collider.maxY).toBeCloseTo(5.5, 6);
    expect(collider.maxZ).toBeCloseTo(0, 6);
    expect(collider.shape).toBeDefined();
    expect(collider.shape?.vertices.length).toBe(24);
  });

  it('a body at rest on a collider stays at rest, tick after tick', () => {
    // The falling-world regression: contact used to stop AT the face, and a
    // resting body then read as "already overlapping" next tick — the walk-out
    // rule waved the identical move through, and the floor stopped existing
    // one tick after landing. Rest must be a fixed point of the sweep.
    const set = new ColliderSet([boxCollider(0, 5, 0, 10, 1, 10)]);
    const body: Body = {
      x: 0,
      y: 8,
      z: 0,
      hx: 0.35,
      hy: 0.85,
      hz: 0.35,
      parts: [{ shape: boxShape(0.35, 0.85, 0.35), ox: 0, oy: 0, oz: 0 }],
    };
    moveAxis(body, set, AXIS_Y, -5);
    const restY = body.y;
    expect(restY).toBeGreaterThan(6.8);
    for (let tick = 0; tick < 200; tick++) {
      moveAxis(body, set, AXIS_Y, -0.0064);
      moveAxis(body, set, AXIS_X, 0.05);
    }
    expect(body.y).toBeCloseTo(restY, 3);
    expect(body.x).toBeCloseTo(200 * 0.05, 3);
  });

  it('an upright body standing flush on it can still move along it', () => {
    // The reason pads sank their lids a hand's width: a plain box lid flush
    // with the floor fought the character for their own ground. As a shape the
    // narrow phase resolves the touch correctly, so the sink is unnecessary.
    const set = new ColliderSet([boxCollider(0, 5, 0, 10, 1, 10)]);
    const body = characterBody(0, 6 + 0.85, 0);
    const across = moveAxis(body, set, AXIS_X, 5);
    expect(across).toBe(5);
    const down = moveAxis(body, set, AXIS_Y, -1);
    expect(Math.abs(down)).toBeLessThan(0.01);
  });
});

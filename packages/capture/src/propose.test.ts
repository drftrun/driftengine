import { expect, test } from 'vitest';

import {
  MOVABLE_COMPONENTS,
  SCENERY_COMPONENTS,
  WALKABLE_COMPONENTS,
  proposeEntities,
} from './propose.ts';
import type { Region } from './segment.ts';

/**
 * **Everything unlabelled stays scenery.**
 *
 * The regions here are written out rather than segmented from a mesh, because what is under test is
 * the *decision* and nothing else: given a surface of this size, at this angle, with or without a
 * name, what does a scene get offered? A fixture that had to be segmented first would fail for two
 * reasons and only report one.
 */
function region(
  area: number,
  normal: readonly [number, number, number],
  bounds: readonly [number, number, number, number, number, number],
  label: string | null = null,
): Region {
  return {
    triangles: [0],
    bounds: Float64Array.from(bounds),
    normal: Float64Array.from(normal),
    area,
    label,
  };
}

/** A tall wall, a floor, and a block on it — the wall being the largest surface of the three. */
const ROOM: Region[] = [
  region(24, [0, 0, 1], [-2, 0, -2, 2, 6, -2]),
  region(16, [0, 1, 0], [-2, 0, -2, 2, 0, 2]),
  region(0.36, [0, 1, 0], [0.4, 0.5, 0.4, 1, 0.5, 1]),
];

test('AN UNLABELLED REGION BECOMES STATIC SCENERY', () => {
  const proposals = proposeEntities(ROOM);
  expect(proposals.length).toBe(3);

  const walkable = proposals.filter((proposal) => proposal.walkable);
  /*
   * One floor, and it is **the largest surface a character could stand on rather than the largest
   * surface**: the wall is half again the floor's area, so a choice made on size alone hands a
   * navigation mesh to a vertical face. The floor's top sits at y = 0, which no wall's does.
   */
  expect(walkable.length).toBe(1);
  expect(walkable[0]?.components).toEqual(WALKABLE_COMPONENTS);
  expect(walkable[0]?.bounds[4]).toBeCloseTo(0, 6);

  /* Everything else is drawn, solid and inert — which is what nobody having named it means. */
  for (const proposal of proposals) {
    if (proposal.walkable) continue;
    expect(proposal.label).toBeNull();
    expect(proposal.components).toEqual(SCENERY_COMPONENTS);
  }
});

test('a named region small enough to shift is offered as movable, and a large one is not', () => {
  const named = ROOM.map((surface) =>
    surface.area < 1 ? { ...surface, label: 'crate' } : { ...surface, label: 'wall' },
  );
  const proposals = proposeEntities(named);
  expect(proposals.find((proposal) => proposal.label === 'crate')?.components).toEqual(
    MOVABLE_COMPONENTS,
  );
  /*
   * A named wall stays scenery: **the name is not what makes a thing movable**, its size is. A
   * capture that made every labelled surface a rigid body would drop the room's walls on the floor.
   */
  const large = proposals.find((proposal) => proposal.label === 'wall' && !proposal.walkable);
  expect(large?.components).toEqual(SCENERY_COMPONENTS);
});

test("a slope too steep to stand on carries no way across it, and the angle is the caller's", () => {
  /*
   * A ramp at 60°, and the largest surface in the scene. Nobody stands on it at the default 45°,
   * and the surface that gets the navigation mesh is the flat one underneath. Tell the proposer
   * that 70° is walkable and the same ramp is the answer — **the angle is a decision a game makes**,
   * about its own character, and this module holds a default rather than an opinion.
   */
  const ramp: Region[] = [
    region(30, [0, 0.5, 0.8660254037844387], [-3, 0, -3, 3, 5, 3]),
    region(16, [0, 1, 0], [-2, 0, -2, 2, 0, 2]),
  ];
  expect(proposeEntities(ramp).findIndex((proposal) => proposal.walkable)).toBe(1);
  expect(proposeEntities(ramp, { slopeDegrees: 70 }).findIndex((p) => p.walkable)).toBe(0);
});

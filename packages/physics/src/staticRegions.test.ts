import { expect, test } from 'vitest';
import { BODY_STATIC } from './bodies.ts';
import { meshShape } from './meshShape.ts';
import { createRayHit } from './query.ts';
import { StaticRegions } from './staticRegions.ts';
import { PhysicsWorld } from './world.ts';

/**
 * A world's static scenery by region: one triangle-mesh body a region, added and removed as the
 * player moves. The world removes a body by moving its last one into the hole, so every index past
 * the removed one can change — which is what these follow, by raycasting onto each floor.
 */

/** A floor ten metres square at y = 0, from `x0` to `x0 + 10` along x. */
function floorAt(x0: number) {
  return meshShape(
    new Float32Array([x0, 0, 0, x0 + 10, 0, 0, x0 + 10, 0, 10, x0, 0, 10]),
    Uint32Array.from([0, 2, 1, 0, 3, 2]),
  );
}

test("A REGION KEEPS ITS BODY THROUGH ANOTHER REGION'S REMOVAL, and a removed region collides with nothing", () => {
  const world = new PhysicsWorld();
  const regions = new StaticRegions(world);
  regions.add(7, { type: BODY_STATIC, shape: floorAt(0) });
  regions.add(8, { type: BODY_STATIC, shape: floorAt(10) });
  regions.add(9, { type: BODY_STATIC, shape: floorAt(20) });
  expect(regions.size).toBe(3);

  /* Region 7 holds body 0; removing it moves the last body — region 9's — into index 0. */
  regions.remove(7);
  const hit = createRayHit();
  expect(world.raycast(25, 5, 5, 0, -1, 0, 10, hit), 'region 9 still stands').toBe(true);
  expect(hit.body, 'and is found at the index its region now names').toBe(regions.bodyOf(9));
  expect(world.raycast(15, 5, 5, 0, -1, 0, 10, hit)).toBe(true);
  expect(hit.body).toBe(regions.bodyOf(8));
  expect(world.raycast(5, 5, 5, 0, -1, 0, 10, hit), 'region 7 is gone').toBe(false);
  expect(regions.has(7)).toBe(false);

  regions.remove(9);
  regions.remove(8);
  expect(regions.size).toBe(0);
  expect(world.raycast(15, 5, 5, 0, -1, 0, 10, hit)).toBe(false);

  regions.add(8, { type: BODY_STATIC, shape: floorAt(10) });
  expect(world.raycast(15, 5, 5, 0, -1, 0, 10, hit), 'a region can come back').toBe(true);
  expect(() => regions.add(8, { type: BODY_STATIC, shape: floorAt(10) })).toThrow(/already/);
  regions.remove(3);
  expect(regions.size, 'removing a region that is not there is nothing').toBe(1);
});

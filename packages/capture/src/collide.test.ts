import { MAX_COLLIDER_POINTS } from '@driftengine/drft';
import { SUPPORT_DIRECTIONS } from '@driftengine/physics';
import {
  BODY_STATIC,
  CharacterController,
  GROUNDED,
  meshShape,
  PhysicsWorld,
} from '@driftengine/physics';
import {
  buildContours,
  buildRegions,
  buildPolyMesh,
  NavMeshQuery,
  voxeliseWalkable,
} from '@driftengine/nav';
import { expect, test } from 'vitest';

import { collisionMesh, propHulls } from './collide.ts';
import { createVolume, type Volume } from './fusion.ts';
import { marchVolume } from './marching.ts';

/**
 * **A captured room you can walk on, and an agent can find its way across.**
 *
 * This is where a capture stops being a picture. Everything before it is judged by eye or by a
 * number; from here it is judged by whether a character stays on the floor and a path reaches the
 * other side of the room — and both of those fail *quietly*. A mesh with an inverted face collides
 * inside-out; a mesh with a triangle of no area has a contact normal pointing at nothing; a
 * navigation mesh built on a surface that is not quite flat leaves an agent walking through a wall.
 *
 * The room is written analytically as a distance field and marched, rather than fitted, because
 * what is under test is the handover to physics and navigation — not the quality of a fit.
 */

const SPACING = 0.1;
const HALF = 2.4;
const HEIGHT = 2.6;

/**
 * A room: a floor at y = 0, four walls, and a step in the middle a character can climb.
 *
 * Written as the distance to the nearest surface of a box turned inside out, which is what a room
 * is — the space you stand in is the *inside*, so the sign is flipped against the usual convention
 * for a solid.
 */
function room(withStep = false): Volume {
  const side = Math.round((HALF * 2) / SPACING) + 1;
  const tall = Math.round((HEIGHT + 0.6) / SPACING) + 1;
  const volume = createVolume([side, tall, side], [-HALF, -0.6, -HALF], SPACING);
  for (let k = 0; k < side; k += 1) {
    for (let j = 0; j < tall; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = -HALF + i * SPACING;
        const y = -0.6 + j * SPACING;
        const z = -HALF + k * SPACING;
        /* Inside the room is empty, so the distance is positive there and negative in the shell. */
        const toWall = Math.min(HALF - 0.4 - Math.abs(x), HALF - 0.4 - Math.abs(z));
        const toFloor = y;
        let distance = Math.min(toWall, toFloor, HEIGHT - y);
        if (withStep) {
          /* A block 0.3 m high in one corner: a step, not a wall. */
          const block = Math.max(
            Math.abs(x - 1.2) - 0.5,
            Math.abs(z - 1.2) - 0.5,
            Math.abs(y - 0.15) - 0.15,
          );
          /* The box's own distance, negative inside it: the step is solid, so it is cut out. */
          distance = Math.min(distance, block);
        }
        const at = (k * tall + j) * side + i;
        volume.distance[at] = distance;
        volume.weight[at] = 1;
      }
    }
  }
  return volume;
}

/** A crate, as a solid box written the ordinary way round. */
function crate(): Volume {
  const side = 21;
  const spacing = 0.05;
  const volume = createVolume([side, side, side], [-0.5, -0.5, -0.5], spacing);
  for (let k = 0; k < side; k += 1) {
    for (let j = 0; j < side; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = -0.5 + i * spacing;
        const y = -0.5 + j * spacing;
        const z = -0.5 + k * spacing;
        const at = (k * side + j) * side + i;
        volume.distance[at] = Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - 0.3;
        volume.weight[at] = 1;
      }
    }
  }
  return volume;
}

test('A CAPTURED ROOM BECOMES A MESH BODY PHYSICS TAKES UNCHANGED', () => {
  const drawn = marchVolume(room());
  expect(drawn.indices.length / 3).toBeGreaterThan(2000);

  const collision = collisionMesh(drawn);
  const shape = meshShape(collision.positions, collision.indices);
  expect(shape).not.toBeNull();

  /* Nothing is invented and nothing is lost but the arealess triangles. */
  expect(collision.indices.length / 3).toBe(drawn.indices.length / 3 - collision.dropped);
  expect(collision.positions.length).toBeLessThanOrEqual(drawn.positions.length);

  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape });
  expect(world).not.toBeNull();
});

test('a triangle with no area is dropped, because a plane needs a normal', () => {
  /* Two real triangles and one whose three vertices are on a line. */
  const mesh = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 0, 0, 3, 0, 0, 4, 0, 0]),
    normals: new Float32Array(18),
    colors: new Float32Array(18),
    emissive: new Float32Array(3),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
  };
  const collision = collisionMesh(mesh);
  expect(collision.dropped).toBe(1);
  expect(collision.indices.length / 3).toBe(1);
  /* And the vertices only the dropped triangle used are gone with it. */
  expect(collision.positions.length / 3).toBe(3);
});

test('the smallest triangle kept is a square millimetre, and it is a real area', () => {
  /*
   * Three triangles: an ordinary one, one of four ten-millionths of a square metre, and one of four
   * millionths — either side of the default. **This is what pins the threshold's units.** A measure
   * that answered twice the area, or the cross product's length without halving it, drops and keeps
   * exactly the same triangles everywhere except here.
   */
  const mesh = {
    positions: Float32Array.from([
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      2,
      0,
      0,
      2 + 8e-4,
      0,
      0,
      2,
      0,
      1e-3,
      3,
      0,
      0,
      3 + 8e-3,
      0,
      0,
      3,
      0,
      1e-3,
    ]),
    normals: new Float32Array(27),
    colors: new Float32Array(27),
    emissive: new Float32Array(3),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
  };
  const collision = collisionMesh(mesh);
  /* 8e-4 × 1e-3 ÷ 2 is 4 · 10⁻⁷ and goes; 8e-3 × 1e-3 ÷ 2 is 4 · 10⁻⁶ and stays. */
  expect(collision.dropped).toBe(1);
  expect(collision.indices.length / 3).toBe(2);
});

test('a hull cannot overflow a collider record, because the decomposition stops first', () => {
  /*
   * **The relationship rather than a check.** A convex part carries at most one point per support
   * direction and a `COLL` record holds sixty-four, so no hull this can produce is too big to
   * write. That is only true while the first number stays under the second, and this is what says
   * so — a guard inside `propHulls` would be a branch nothing can reach.
   */
  expect(SUPPORT_DIRECTIONS).toBeLessThanOrEqual(MAX_COLLIDER_POINTS);
});

test('A CHARACTER WALKS ACROSS A CAPTURED FLOOR AND STAYS ON IT', () => {
  /*
   * **The first test of `CharacterController` against a triangle mesh anywhere in this tree.** Every
   * other one stands it on a box, which has six planes and no seams; a captured floor is thousands
   * of triangles meeting at shallow angles, and the failure it can have is falling through a seam —
   * which is silent, intermittent, and reads as a physics fault rather than a capture one.
   */
  const collision = collisionMesh(marchVolume(room()));
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: meshShape(collision.positions, collision.indices) });

  const walker = new CharacterController();
  walker.teleport(-1.2, 1.0, -1.2);
  const still = { moveX: 0, moveZ: 0, jump: false };
  for (let tick = 0; tick < 120; tick += 1) walker.move(world, 1 / 60, still);
  expect(walker.state).toBe(GROUNDED);
  const settled = walker.y;
  expect(settled).toBeGreaterThan(0.4);
  expect(settled).toBeLessThan(1.4);

  /* A scripted walk the length of the room and back, with the height watched every tick. */
  let lowest = settled;
  let highest = settled;
  let travelled = 0;
  let wasX = walker.x;
  let wasZ = walker.z;
  for (const [moveX, moveZ] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const) {
    for (let tick = 0; tick < 90; tick += 1) {
      walker.move(world, 1 / 60, { moveX, moveZ, jump: false });
      lowest = Math.min(lowest, walker.y);
      highest = Math.max(highest, walker.y);
      travelled += Math.abs(walker.x - wasX) + Math.abs(walker.z - wasZ);
      wasX = walker.x;
      wasZ = walker.z;
    }
  }
  /*
   * **Never below the floor**, which is the one that matters: a walker that drops through a seam
   * keeps falling and its height is the tell. The ceiling allows the step in the corner.
   */
  expect(lowest).toBeGreaterThan(settled - 0.2);
  expect(highest).toBeLessThan(settled + 0.6);
  /*
   * And it comes to rest on the floor when it stops. Asserted after a moment of standing still
   * rather than on the last tick of the walk: a character stepping off the block in the corner is
   * legitimately in the air for a few ticks, and a test that read the state mid-stride would be
   * asserting where the walk happened to end.
   */
  for (let tick = 0; tick < 40; tick += 1) walker.move(world, 1 / 60, still);
  expect(walker.state).toBe(GROUNDED);
  /*
   * And it went somewhere and came back: a walker wedged against the first triangle it met proves
   * nothing, and a square of four legs should end where it started.
   */
  expect(travelled).toBeGreaterThan(2);
  expect(Math.abs(walker.x + 1.2)).toBeLessThan(0.2);
  expect(Math.abs(walker.z + 1.2)).toBeLessThan(0.2);
});

test('a prop becomes convex hulls inside the container’s own caps', () => {
  const drawn = marchVolume(crate());
  const collision = collisionMesh(drawn);
  const { hulls, bloat } = propHulls(collision, { resolution: 24, maxHulls: 4 });
  expect(hulls.length).toBeGreaterThan(0);
  expect(hulls.length).toBeLessThanOrEqual(4);
  for (const hull of hulls) {
    expect(hull.length % 3).toBe(0);
    expect(hull.length / 3).toBeLessThanOrEqual(64);
  }
  /* A box is convex, so one hull should cover it with almost no empty space added. */
  expect(bloat).toBeLessThan(0.3);
});

test('AN AGENT FINDS ITS WAY ACROSS THE ROOM, on the floor and in metres', () => {
  const collision = collisionMesh(marchVolume(room(false)));
  const field = voxeliseWalkable(
    { positions: collision.positions, indices: collision.indices },
    { cellSize: 0.15, cellHeight: 0.1, maxSlope: 45, agentHeight: 1.2, agentRadius: 0.2 },
  );
  expect(field.spans.length).toBeGreaterThan(0);
  const regions = buildRegions(field, { minRegionSpans: 4, maxStep: 1 });
  const mesh = buildPolyMesh(buildContours(field, regions, 0.5), 6, field);
  expect(mesh.polyCount).toBeGreaterThan(0);

  const query = new NavMeshQuery(mesh);
  const out = new Float64Array(256);
  /* Corner to opposite corner, inside the walls. */
  const count = query.findPath(-1.6, -1.6, 1.6, 1.6, 0.4, out);
  expect(count).toBeGreaterThan(1);

  /*
   * **In metres, which is the whole point of a navigation mesh built on a capture.** A path in
   * voxel columns is a path nobody can walk; the placement the field carries is what puts it back
   * in the world, and a path that came out in cells would land tens of metres outside the room.
   */
  const first = [out[0] as number, out[1] as number];
  const last = [out[(count - 1) * 2] as number, out[(count - 1) * 2 + 1] as number];
  expect(Math.abs(first[0] as number)).toBeLessThan(HALF);
  expect(Math.abs(first[1] as number)).toBeLessThan(HALF);
  expect(Math.abs((last[0] as number) - 1.6)).toBeLessThan(0.6);
  expect(Math.abs((last[1] as number) - 1.6)).toBeLessThan(0.6);
  /* And it stays inside the room the whole way, rather than cutting through a wall. */
  for (let at = 0; at < count; at += 1) {
    expect(Math.abs(out[at * 2] as number)).toBeLessThan(HALF);
    expect(Math.abs(out[at * 2 + 1] as number)).toBeLessThan(HALF);
  }
});

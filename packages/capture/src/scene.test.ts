import { readDrft, type DrftMaterial } from '@driftengine/drft';
import {
  NavMeshQuery,
  buildContours,
  buildPolyMesh,
  buildRegions,
  voxeliseWalkable,
} from '@driftengine/nav';
import {
  BODY_STATIC,
  CharacterController,
  GROUNDED,
  PhysicsWorld,
  meshShape,
} from '@driftengine/physics';
import { expect, test } from 'vitest';

import { collisionMesh, propHulls } from './collide.ts';
import { createVolume, type Volume } from './fusion.ts';
import { marchVolume } from './marching.ts';
import { proposeEntities } from './propose.ts';
import {
  PROPOSAL_COMPONENT,
  captureFile,
  proposalScene,
  readProposals,
  type CaptureScene,
} from './scene.ts';
import { segmentGeometry } from './segment.ts';

/**
 * **Every stage lands in one file, and the file opens and can be walked.**
 *
 * Five stages that know nothing about each other produced these parts, and what they have in common
 * is the capture. The test that matters is not that each chunk is present — `@driftengine/drft` has
 * a test per chunk for that — but that what comes *out* still works: a body stands on the mesh, an
 * agent crosses the polygon mesh, and the proposals are the ones that went in.
 */

const SPACING = 0.2;
const HALF = 2.4;
const HEIGHT = 2.4;

/** A room, as the distance to the nearest surface of a box turned inside out. */
function room(): Volume {
  const side = Math.round((HALF * 2) / SPACING) + 1;
  const tall = Math.round((HEIGHT + 0.6) / SPACING) + 1;
  const volume = createVolume([side, tall, side], [-HALF, -0.6, -HALF], SPACING);
  for (let k = 0; k < side; k += 1) {
    for (let j = 0; j < tall; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = -HALF + i * SPACING;
        const y = -0.6 + j * SPACING;
        const z = -HALF + k * SPACING;
        const toWall = Math.min(HALF - 0.4 - Math.abs(x), HALF - 0.4 - Math.abs(z));
        const at = (k * tall + j) * side + i;
        volume.distance[at] = Math.min(toWall, y, HEIGHT - y);
        volume.weight[at] = 1;
      }
    }
  }
  return volume;
}

/** A crate, as a solid box written the ordinary way round. */
function crate(): Volume {
  const side = 15;
  const spacing = 0.075;
  const volume = createVolume([side, side, side], [-0.5, -0.5, -0.5], spacing);
  for (let k = 0; k < side; k += 1) {
    for (let j = 0; j < side; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = -0.5 + i * spacing;
        const y = -0.5 + j * spacing;
        const z = -0.5 + k * spacing;
        volume.distance[(k * side + j) * side + i] =
          Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - 0.3;
        volume.weight[(k * side + j) * side + i] = 1;
      }
    }
  }
  return volume;
}

const MATERIALS: DrftMaterial[] = [
  {
    name: 'captured',
    color: [1, 1, 1],
    specular: 0.5,
    roughness: 1,
    emissive: 0,
    emissiveColor: [0, 0, 0],
    opacity: 1,
    albedo: -1,
    normalMap: -1,
    ormMap: -1,
    emissiveMap: -1,
    roughnessScale: 1,
    metallicScale: 0,
    occlusionStrength: 1,
    reflectivity: 0.5,
    cutout: 0,
  },
];

/** The whole capture, assembled once: five stages' output over one room. */
function capture(): CaptureScene {
  const mesh = marchVolume(room());
  const collision = collisionMesh(mesh);
  const field = voxeliseWalkable(
    { positions: collision.positions, indices: collision.indices },
    { cellSize: 0.15, cellHeight: 0.1, maxSlope: 45, agentHeight: 1.2, agentRadius: 0.2 },
  );
  const navigation = buildPolyMesh(
    buildContours(field, buildRegions(field, { minRegionSpans: 4, maxStep: 1 }), 0.5),
    6,
    field,
  );
  const proposals = proposeEntities(segmentGeometry(mesh, { creaseDegrees: 30 }));
  return {
    mesh,
    materials: MATERIALS,
    hulls: propHulls(collisionMesh(marchVolume(crate())), { resolution: 16, maxHulls: 2 }).hulls,
    navigation,
    proposals,
  };
}

test('EVERY STAGE LANDS IN ONE FILE, AND EVERY PART COMES BACK OUT', () => {
  const scene = capture();
  const asset = readDrft(captureFile(scene));

  expect(asset.meshes.length).toBe(1);
  expect(asset.meshes[0]?.indices.length).toBe(scene.mesh.indices.length);
  expect(asset.materials.length).toBe(1);
  expect(asset.colliders.length).toBeGreaterThan(0);
  expect(asset.navigation?.polyCount).toBe(scene.navigation?.polyCount);
  expect(asset.entities).not.toBeNull();
  /* Nothing was stepped over: every chunk written here is one this reader knows. */
  expect(asset.skipped.length).toBe(0);
});

test('A CHARACTER WALKS THE MESH THAT CAME OUT OF THE FILE', () => {
  /*
   * **The mesh a body stands on is the one the file handed back**, views over a fetched buffer
   * rather than the arrays the marcher produced. That is the difference this test exists for: a
   * stride written wrongly, or a `Uint32Array` read as a `Uint16Array`, produces a mesh that looks
   * like a mesh and collides like a colander.
   */
  const asset = readDrft(captureFile(capture()));
  const drawn = asset.meshes[0];
  expect(drawn).toBeDefined();
  if (drawn === undefined) return;

  const collision = collisionMesh(drawn);
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: meshShape(collision.positions, collision.indices) });

  const walker = new CharacterController();
  walker.teleport(-1.2, 1.0, -1.2);
  const still = { moveX: 0, moveZ: 0, jump: false };
  for (let tick = 0; tick < 120; tick += 1) walker.move(world, 1 / 60, still);
  expect(walker.state).toBe(GROUNDED);

  let lowest = walker.y;
  for (const [moveX, moveZ] of [
    [1, 0],
    [0, 1],
  ] as const) {
    for (let tick = 0; tick < 90; tick += 1) {
      walker.move(world, 1 / 60, { moveX, moveZ, jump: false });
      lowest = Math.min(lowest, walker.y);
    }
  }
  /* Never below the floor: a walker that drops through a seam keeps falling, and the height says so. */
  expect(lowest).toBeGreaterThan(0.4);
});

test('an agent crosses the navigation mesh that came out of the file', () => {
  const asset = readDrft(captureFile(capture()));
  expect(asset.navigation).not.toBeNull();
  if (asset.navigation === null) return;

  const query = new NavMeshQuery(asset.navigation);
  const out = new Float64Array(256);
  const count = query.findPath(-1.6, -1.6, 1.6, 1.6, 0.4, out);
  expect(count).toBeGreaterThan(1);
  /*
   * **In metres, which is what the placement in the chunk is for.** A path that came back in cell
   * indices would land tens of metres outside a room this size, and every assertion about its ends
   * would pass if they were compared in cells too.
   */
  for (let at = 0; at < count; at += 1) {
    expect(Math.abs(out[at * 2] as number)).toBeLessThan(HALF);
    expect(Math.abs(out[at * 2 + 1] as number)).toBeLessThan(HALF);
  }
  expect(Math.abs((out[(count - 1) * 2] as number) - 1.6)).toBeLessThan(0.6);
});

test('A PROPOSAL IS STILL A PROPOSAL ON THE WAY OUT', () => {
  const scene = capture();
  const asset = readDrft(captureFile(scene));
  expect(asset.entities).not.toBeNull();
  if (asset.entities === null) return;

  const back = readProposals(asset.entities);
  const sent = scene.proposals ?? [];
  expect(back.length).toBe(sent.length);
  expect(back.length).toBeGreaterThan(0);
  back.forEach((proposal, at) => {
    const was = sent[at] as (typeof sent)[number];
    /* Its number is its place in the file, which is what a consumer refers to it by. */
    expect(proposal.region).toBe(at);
    expect(proposal.walkable).toBe(was.walkable);
    expect(proposal.label).toBe(was.label);
    expect(proposal.components).toEqual(was.components);
    for (let k = 0; k < 6; k += 1) {
      expect(proposal.bounds[k]).toBeCloseTo(was.bounds[k] as number, 4);
    }
  });
  /* Exactly one is walkable, and it is the floor — the file did not invent a second one. */
  expect(back.filter((proposal) => proposal.walkable).length).toBe(1);
});

test('a scene a consumer added its own things to is read as a guest', () => {
  /*
   * **A capture reading a file is a guest in it.** An editor that accepted two proposals and turned
   * them into a game's own entities leaves a scene holding both kinds; reading it must give back
   * the proposals and pass over everything else, rather than inventing a proposal per entity.
   */
  const scene = proposalScene([
    {
      region: 0,
      bounds: Float64Array.from([-1, 0, -1, 1, 0, 1]),
      label: 'floor',
      components: ['transform', 'mesh'],
      walkable: true,
    },
  ]);
  const shared = {
    ...scene,
    entities: [...scene.entities, { components: { door: { 'game::door::open': true } } }],
  };
  const back = readProposals(shared);
  expect(back.length).toBe(1);
  expect(back[0]?.label).toBe('floor');
  expect(Object.keys(shared.entities[1]?.components ?? {})).not.toContain(PROPOSAL_COMPONENT);
});

test('the field a bound is written under is the bound it is named after', () => {
  /*
   * **Read out of the file rather than through the reader above**, which is the only way this can
   * be checked at all: the writer and the reader share the field table, so a table in the wrong
   * order round-trips perfectly and means something else entirely to everybody outside this
   * module — an editor reading `minX` and getting the maximum.
   */
  const scene = proposalScene([
    {
      region: 0,
      bounds: Float64Array.from([-1, -2, -3, 4, 5, 6]),
      label: null,
      components: ['transform'],
      walkable: false,
    },
  ]);
  const fields = scene.entities[0]?.components[PROPOSAL_COMPONENT] ?? {};
  expect(fields['capture::proposal::minX']).toBe(-1);
  expect(fields['capture::proposal::minY']).toBe(-2);
  expect(fields['capture::proposal::minZ']).toBe(-3);
  expect(fields['capture::proposal::maxX']).toBe(4);
  expect(fields['capture::proposal::maxY']).toBe(5);
  expect(fields['capture::proposal::maxZ']).toBe(6);
  /* And an unlabelled region is written as the empty string, because the field is a `String`. */
  expect(fields['capture::proposal::label']).toBe('');
});

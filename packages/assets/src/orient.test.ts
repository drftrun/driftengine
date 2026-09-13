import { expect, test } from 'vitest';
import {
  UP_AXES,
  convertHandedness,
  mirrorNodes,
  orientMeshes,
  orientNodes,
  parseUpAxis,
} from './orient.ts';
import type { UpAxis } from './orient.ts';
import type { DrftNode, MeshData } from '@driftengine/drft';

/**
 * Orientation, which is the one step in the bake that can be wrong while every number in the
 * file is right.
 *
 * Two contracts, and they are the two ways this has already gone wrong on a real asset. The
 * first is the obvious one: the axis a caller names must end up pointing at the sky. The
 * second is the one that hides — a turn must be a *rotation*. A reflection also puts the
 * named axis up, also leaves the bounding box the right size, and also passes any check made
 * of extents alone, while quietly turning every triangle inside out.
 */

/** The unit vector along a signed axis, so "up" can be stated as a point and then found. */
const DIRECTIONS: Readonly<Record<UpAxis, readonly [number, number, number]>> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

function meshOf(positions: number[], normals: number[]): MeshData {
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(count * 3).fill(0.5),
    emissive: new Float32Array(count),
    indices: new Uint32Array(count).map((_, i) => i),
  };
}

test('the axis a caller names is the axis that ends up pointing up', () => {
  for (const axis of UP_AXES) {
    const [x, y, z] = DIRECTIONS[axis];
    const [turned] = orientMeshes([meshOf([x, y, z], [x, y, z])], axis);
    const positions = turned?.positions as Float32Array;
    expect([positions[0], positions[1], positions[2]], `${axis} should stand up`).toEqual([
      0, 1, 0,
    ]);
    /* Normals travel with their positions or the model is lit for the orientation it left. */
    const normals = turned?.normals as Float32Array;
    expect([normals[0], normals[1], normals[2]], `${axis} normal`).toEqual([0, 1, 0]);
  }
});

test('every turn is a rotation, so winding survives it', () => {
  /*
   * A triangle in the ground plane, wound so its face points at the sky. Hand-derived:
   * (p1 - p0) x (p2 - p0) = (1,0,0) x (0,0,-1) = (0,1,0).
   */
  const source = meshOf([0, 0, 0, 1, 0, 0, 0, 0, -1], [0, 1, 0, 0, 1, 0, 0, 1, 0]);

  for (const axis of UP_AXES) {
    const [turned] = orientMeshes([source], axis);
    const p = turned?.positions as Float32Array;
    const n = turned?.normals as Float32Array;

    const ux = (p[3] as number) - (p[0] as number);
    const uy = (p[4] as number) - (p[1] as number);
    const uz = (p[5] as number) - (p[2] as number);
    const vx = (p[6] as number) - (p[0] as number);
    const vy = (p[7] as number) - (p[1] as number);
    const vz = (p[8] as number) - (p[2] as number);
    /* The normal the winding implies, which a mirror would leave pointing the other way. */
    const wound = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];

    for (let c = 0; c < 3; c++) {
      expect(
        wound[c],
        `${axis}: the winding disagrees with the normal, so the turn mirrored`,
      ).toBeCloseTo(n[c] as number, 6);
    }
  }
});

test('an axis nobody can act on is refused by name', () => {
  expect(parseUpAxis('z')).toBe('+z');
  expect(parseUpAxis('-Y')).toBe('-y');
  expect(() => parseUpAxis('up')).toThrow(/"up" is not an axis/);
});

/**
 * Handedness, the one correction the rotation table above deliberately cannot express.
 *
 * The contract asserted here is that all three halves of a mirror happen together. Any one of
 * them alone leaves geometry that looks right in a bounding box and wrong on screen: negating an
 * axis without reversing winding turns every triangle inside out, and reversing winding without
 * flipping the bitangent sign lights every normal-mapped surface backwards.
 */

/** One triangle wound counter-clockwise, with a normal and a tangent to check. */
function mirrorable(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(1),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
}

test('negates x on positions, normals and tangents', () => {
  const mesh = mirrorable();
  convertHandedness([mesh]);
  expect([...mesh.positions.subarray(3, 6)]).toEqual([-1, 0, 0]);
  expect([...mesh.tangents!.subarray(0, 3)]).toEqual([-1, 0, 0]);
});

test('reverses winding, so a mirrored triangle still faces outward', () => {
  const mesh = mirrorable();
  convertHandedness([mesh]);
  expect([...mesh.indices]).toEqual([0, 2, 1]);
});

test('flips the bitangent sign, or a normal map lights the surface backwards', () => {
  const mesh = mirrorable();
  convertHandedness([mesh]);
  expect(mesh.tangents![3]).toBe(-1);
});

test('applying it twice is the identity', () => {
  const mesh = mirrorable();
  const before = mirrorable();
  convertHandedness([mesh]);
  convertHandedness([mesh]);
  expect([...mesh.positions]).toEqual([...before.positions]);
  expect([...mesh.indices]).toEqual([...before.indices]);
  expect([...mesh.tangents!]).toEqual([...before.tangents!]);
});

test('leaves uvs alone, since a mirror is not a reparameterisation', () => {
  const mesh = mirrorable();
  convertHandedness([mesh]);
  expect([...mesh.uvs!]).toEqual([0, 0, 1, 0, 0, 1]);
});

/**
 * The hierarchy turns with the geometry, or `--up` produces a file whose two halves disagree
 * about where every part is — and both halves individually well formed, so nothing detects it.
 */
const root = (over: Partial<DrftNode>): DrftNode => ({
  parent: -1,
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  mesh: -1,
  name: 'root',
  ...over,
});

test('turns a root node the same way orientMeshes turns geometry', () => {
  const nodes = [root({ translation: [0, 0, 1] })];
  const mesh: MeshData = {
    positions: new Float32Array([0, 0, 1]),
    normals: new Float32Array([0, 0, 1]),
    colors: new Float32Array(3).fill(1),
    emissive: new Float32Array(1),
    indices: new Uint32Array([0, 0, 0]),
  };
  const turnedMesh = orientMeshes([mesh], '+z')[0]!;
  const turnedNode = orientNodes(nodes, '+z')[0]!;
  /* The node's translation lands exactly where the identical vertex landed. */
  expect(turnedNode.translation[0]).toBeCloseTo(turnedMesh.positions[0]!, 6);
  expect(turnedNode.translation[1]).toBeCloseTo(turnedMesh.positions[1]!, 6);
  expect(turnedNode.translation[2]).toBeCloseTo(turnedMesh.positions[2]!, 6);
});

test('leaves children alone, since a parent already carries them', () => {
  const nodes = [root({}), root({ parent: 0, name: 'child', translation: [0, 0, 5] })];
  const turned = orientNodes(nodes, '+z');
  expect(turned[1]!.translation).toEqual([0, 0, 5]);
});

test('+y turns nothing, because it is already the engine frame', () => {
  const nodes = [root({ translation: [1, 2, 3] })];
  expect(orientNodes(nodes, '+y')[0]!.translation).toEqual([1, 2, 3]);
});

/**
 * The hierarchy's half of a mirror, which did not exist and was inlined half-done in the reader.
 *
 * `readModel` negated each node's translation X and left its rotation alone, so a graph with
 * rotations placed its parts somewhere the geometry was not — a metre away and on the other side
 * of the model, with both halves individually well formed. That is the shape `orientNodes` was
 * written to prevent for a *rotation*, and a mirror needs the same pair.
 *
 * The rotation is conjugated rather than negated: reflecting a rotation gives `M R M`, whose
 * quaternion is `(x, −y, −z, w)`. And **every node is conjugated, not only the roots** — that is
 * the one place this differs from `orientNodes`, because `M (A B) M = (M A M)(M B M)` and leaving
 * a child alone would drop the mirror out of the product.
 */
const HALF_ROOT_2 = Math.SQRT1_2;

/** A quarter turn about Y on a node placed away from the origin, which is the case that broke. */
function turned(): DrftNode[] {
  return [
    {
      parent: -1,
      translation: [1, 2, 3],
      rotation: [0, HALF_ROOT_2, 0, HALF_ROOT_2],
      scale: [1, 1, 1],
      mesh: 0,
      name: 'hub',
    },
  ];
}

/** A local point through a node's TRS, which is the composition a consumer actually performs. */
function place(node: DrftNode, point: readonly [number, number, number]): [number, number, number] {
  const [x, y, z, w] = node.rotation;
  const [px, py, pz] = [
    point[0] * node.scale[0],
    point[1] * node.scale[1],
    point[2] * node.scale[2],
  ];
  /* q * (0, p) * q⁻¹, written out. */
  const tx = 2 * (y * pz - z * py);
  const ty = 2 * (z * px - x * pz);
  const tz = 2 * (x * py - y * px);
  return [
    px + w * tx + (y * tz - z * ty) + node.translation[0],
    py + w * ty + (z * tx - x * tz) + node.translation[1],
    pz + w * tz + (x * ty - y * tx) + node.translation[2],
  ];
}

test('mirrors a node by negating its translation x and conjugating its rotation', () => {
  const [node] = mirrorNodes(turned());
  expect(node!.translation).toEqual([-1, 2, 3]);
  expect(node!.rotation[0]).toBeCloseTo(0, 6);
  expect(node!.rotation[1]).toBeCloseTo(-HALF_ROOT_2, 6);
  expect(node!.rotation[2]).toBeCloseTo(0, 6);
  expect(node!.rotation[3]).toBeCloseTo(HALF_ROOT_2, 6);
  expect(node!.scale, 'a reflection about x leaves a diagonal scale alone').toEqual([1, 1, 1]);
});

test('a mirrored node places mirrored geometry exactly where the mirror put it', () => {
  /*
   * The invariant that matters, and the one nothing downstream could have checked: a point the
   * geometry mirror moved to `M p` must land under the node at `M (p through the original)`.
   * Hand-derived for [1, 0, 0]: a quarter turn about Y takes it to [0, 0, −1], the translation
   * puts it at [1, 2, 2], and the mirror at [−1, 2, 2].
   */
  const before = turned()[0]!;
  const after = mirrorNodes(turned())[0]!;
  for (const point of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.5, -2, 3],
  ] as const) {
    const expected = place(before, point);
    const actual = place(after, [-point[0], point[1], point[2]]);
    expect(actual[0]).toBeCloseTo(-expected[0], 5);
    expect(actual[1]).toBeCloseTo(expected[1], 5);
    expect(actual[2]).toBeCloseTo(expected[2], 5);
  }
  /* And the case the reader shipped: the same check with the rotation left alone must fail. */
  const halfDone = { ...before, translation: [-1, 2, 3] as [number, number, number] };
  expect(place(halfDone, [-1, 0, 0])[2]).not.toBeCloseTo(place(before, [1, 0, 0])[2], 5);
});

test('mirrors every node and not only the roots, unlike an up-axis turn', () => {
  const nodes: DrftNode[] = [
    {
      parent: -1,
      translation: [1, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      mesh: -1,
      name: 'root',
    },
    {
      parent: 0,
      translation: [2, 0, 0],
      rotation: [0, HALF_ROOT_2, 0, HALF_ROOT_2],
      scale: [1, 1, 1],
      mesh: 0,
      name: 'child',
    },
  ];
  const mirrored = mirrorNodes(nodes);
  expect(mirrored[1]!.translation).toEqual([-2, 0, 0]);
  expect(mirrored[1]!.rotation[1]).toBeCloseTo(-HALF_ROOT_2, 6);
});

test('mirroring a hierarchy twice is the identity', () => {
  const [node] = mirrorNodes(mirrorNodes(turned()));
  expect(node!.translation).toEqual([1, 2, 3]);
  expect(node!.rotation[1]).toBeCloseTo(HALF_ROOT_2, 6);
});

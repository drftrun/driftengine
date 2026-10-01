import { expect, test } from 'vitest';
import { dropDefaultAttributes, weldMesh } from './weld.ts';
import type { MeshData } from '@driftengine/drft';

/**
 * The weld, and the one thing it must never do quietly: change the model.
 *
 * Two contracts, and both were broken for as long as the optional attributes have existed.
 * **An attribute that arrives has to leave** — a merged mesh that comes back without its rig is
 * a character that has stopped animating, and nothing anywhere raises. And **an attribute
 * decides identity**: two corners differing in one of them are different vertices, exactly as
 * the header says about a normal, so merging them keeps one corner's value and silently
 * discards the other's.
 */

/** A mesh with two coincident corners, so a weld has something to merge, and no optional data. */
function pair(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 0, 0, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0]),
    indices: new Uint32Array([0, 1]),
  };
}

test('the two corners this fixture is built from do merge', () => {
  /* The premise every test below rests on: without an attribute to tell them apart, they are
     one vertex. A fixture that never merged would pass every assertion here for nothing. */
  expect(weldMesh(pair()).positions).toHaveLength(3);
});

test('every attribute that arrives leaves again', () => {
  const welded = weldMesh({
    ...pair(),
    uvs: new Float32Array([0.25, 0.5, 0.25, 0.5]),
    specular: new Float32Array([0.3, 0.3]),
    roughness: new Float32Array([0.6, 0.6]),
    grain: new Float32Array([0.7, 0.7]),
    relief: new Float32Array([0.8, 0.8]),
    emissiveColor: new Float32Array([0.1, 0.2, 0.3, 0.1, 0.2, 0.3]),
    tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1]),
    joints: new Float32Array([2, 3, 0, 0, 2, 3, 0, 0]),
    weights: new Float32Array([0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0]),
  });

  expect(welded.positions, 'the fixture merged').toHaveLength(3);
  /* One vertex now, so every array is one vertex wide — and present, which is the half that
     was missing: a dropped rig is not a smaller file, it is a mesh that no longer moves. */
  expect(welded.uvs, 'uvs').toEqual(new Float32Array([0.25, 0.5]));
  expect(welded.specular, 'specular').toEqual(new Float32Array([0.3]));
  expect(welded.roughness, 'roughness').toEqual(new Float32Array([0.6]));
  expect(welded.grain, 'grain').toEqual(new Float32Array([0.7]));
  expect(welded.relief, 'relief').toEqual(new Float32Array([0.8]));
  expect(welded.emissiveColor, 'emissiveColor').toEqual(new Float32Array([0.1, 0.2, 0.3]));
  expect(welded.tangents, 'tangents').toEqual(new Float32Array([1, 0, 0, 1]));
  expect(welded.joints, 'joints').toEqual(new Float32Array([2, 3, 0, 0]));
  expect(welded.weights, 'weights').toEqual(new Float32Array([0.5, 0.5, 0, 0]));
});

test('morph deltas survive a weld, and their count with them', () => {
  /* Two targets a vertex, interleaved by vertex: the layout `MeshData.morphTargets` specifies. */
  const welded = weldMesh({
    ...pair(),
    morphTargets: new Float32Array([1, 0, 0, 0, 2, 0, 1, 0, 0, 0, 2, 0]),
    morphTargetCount: 2,
  });

  expect(welded.positions, 'the fixture merged').toHaveLength(3);
  expect(welded.morphTargets).toEqual(new Float32Array([1, 0, 0, 0, 2, 0]));
  expect(welded.morphTargetCount, 'an array without its count moves nothing').toBe(2);
});

/*
 * Identity, one attribute at a time. Each case is two corners alike in everything the weld
 * already compared, differing in one thing that decides which vertex they are.
 */
const DISTINCT: readonly { readonly name: string; readonly extra: Partial<MeshData> }[] = [
  {
    /* The rig: merging these weights the surviving vertex to one corner's joints, so half the
       geometry follows the wrong bone — a rig fault, in a mesh nothing reports as faulty. */
    name: 'joints',
    extra: {
      joints: new Float32Array([1, 0, 0, 0, 7, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
    },
  },
  {
    name: 'weights',
    extra: {
      joints: new Float32Array([1, 2, 0, 0, 1, 2, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
    },
  },
  {
    /* A mirrored UV shell: same position, same normal, **same uv**, opposite handedness. The
       existing key cannot tell these apart, and the sign is what keeps one side of a model from
       being lit inside out. */
    name: 'the bitangent sign',
    extra: {
      uvs: new Float32Array([0.5, 0.5, 0.5, 0.5]),
      tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, -1]),
    },
  },
  { name: 'relief', extra: { relief: new Float32Array([0, 1]) } },
  {
    name: 'morph deltas',
    extra: { morphTargets: new Float32Array([1, 0, 0, 0, 1, 0]), morphTargetCount: 1 },
  },
];

for (const { name, extra } of DISTINCT) {
  test(`two corners differing in ${name} are two vertices`, () => {
    const welded = weldMesh({ ...pair(), ...extra });
    expect(welded.positions, `${name} decides identity`).toHaveLength(6);
  });
}

test('an attribute that never leaves its default is not stored', () => {
  const dropped = dropDefaultAttributes({
    ...pair(),
    specular: new Float32Array([0, 0]),
    roughness: new Float32Array([0.4277, 0.4277]),
    grain: new Float32Array([0, 0]),
    relief: new Float32Array([0, 0]),
    emissiveColor: new Float32Array([-1, -1, -1, -1, -1, -1]),
  });

  expect(dropped.specular, 'specular').toBeUndefined();
  expect(dropped.roughness, 'roughness').toBeUndefined();
  expect(dropped.grain, 'grain').toBeUndefined();
  expect(dropped.relief, 'relief').toBeUndefined();
  expect(dropped.emissiveColor, 'emissiveColor').toBeUndefined();
});

test('an attribute that varies is kept, whatever its first value', () => {
  const kept = dropDefaultAttributes({ ...pair(), relief: new Float32Array([0, 0.5]) });
  expect(kept.relief).toEqual(new Float32Array([0, 0.5]));
});

/*
 * **The weld ran out of heap on a real model.** It built a string key per corner — twenty-odd
 * quantised numbers joined into one string, held in a `Map` — which is hundreds of bytes of heap a
 * corner. A photogrammetry-matched scene's five-million-triangle ivy needed 5.9 GB to bake and its
 * nineteen-million-triangle candle pack could not bake at all, while welding under one percent.
 */
test('A MILLION CORNERS WELD WITHOUT A HEAP THE SIZE OF THE MODEL', () => {
  const corners = 1_000_000;
  const positions = new Float32Array(corners * 3);
  /* Every corner distinct, which is the worst case for a key table: nothing merges. */
  for (let i = 0; i < corners; i++) {
    positions[i * 3] = i % 1000;
    positions[i * 3 + 1] = Math.floor(i / 1000);
  }
  const mesh: MeshData = {
    positions,
    normals: new Float32Array(corners * 3).fill(0.5),
    colors: new Float32Array(corners * 3).fill(1),
    emissive: new Float32Array(corners),
    uvs: new Float32Array(corners * 2).fill(0.25),
    indices: new Uint32Array(corners).map((_, i) => i),
  };
  /* Through `globalThis` rather than by naming `process`: the engine's config carries no Node types. */
  const heap = (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } })
    .process;
  const before = heap.memoryUsage().heapUsed;
  const welded = weldMesh(mesh);
  const grown = heap.memoryUsage().heapUsed - before;
  expect(welded).toBe(mesh);
  /*
   * 64 MB is a budget of 67 bytes a corner of heap. The string keys spent well over three hundred;
   * a table of typed arrays spends none, since a typed array's storage is not heap.
   */
  expect(grown).toBeLessThan(64 * 1024 * 1024);
});

test('corners at a large coordinate still merge, and still keep apart one quantum away', () => {
  /* 3000 units is past what a 32-bit integer holds at a quantum of a millionth. */
  const mesh: MeshData = {
    positions: new Float32Array([3000, 0, 0, 3000, 0, 0, 3000.5, 0, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array(9).fill(1),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  const welded = weldMesh(mesh);
  expect(welded.positions).toHaveLength(6);
  expect([...welded.indices]).toEqual([0, 0, 1]);
});

test('a negative zero is the same number as a zero, and NaN is the same as NaN', () => {
  /*
   * The string key read both pairs as equal, so a faster key must too or a bake changes.
   *
   * **Sixty-four pairs, not one**, because the table compares values once two corners share a
   * slot: a hash that told -0 from 0 still merged a single pair whenever the two happened to
   * collide, and one pair in an eight-slot table collided often enough to pass. Across sixty-four
   * pairs a hash that disagrees with the comparison splits some of them.
   */
  const pairs = 64;
  const positions = new Float32Array(pairs * 4 * 3);
  for (let k = 0; k < pairs; k++) {
    positions.set([k, 0, 0, k, -0, 0], k * 6);
    positions.set([k, NaN, 1, k, NaN, 1], pairs * 6 + k * 6);
  }
  const corners = pairs * 4;
  const mesh: MeshData = {
    positions,
    normals: new Float32Array(corners * 3),
    colors: new Float32Array(corners * 3).fill(1),
    emissive: new Float32Array(corners),
    indices: new Uint32Array(corners).map((_, i) => i),
  };
  expect(weldMesh(mesh).positions).toHaveLength(pairs * 2 * 3);
});

test('A TEXTURE-ARRAY LAYER DECIDES IDENTITY: corners on two layers stay two vertices', () => {
  const uvs = new Float32Array([0.25, 0.5, 0.25, 0.5]);
  const apart = weldMesh({ ...pair(), uvs, layers: new Float32Array([2, 7]) });
  expect(apart.positions, 'two faces wearing two images keep their own corners').toHaveLength(6);
  expect(apart.layers).toEqual(new Float32Array([2, 7]));
  const merged = weldMesh({ ...pair(), uvs, layers: new Float32Array([4, 4]) });
  expect(merged.positions, 'one image, one corner').toHaveLength(3);
  expect(merged.layers).toEqual(new Float32Array([4]));
});

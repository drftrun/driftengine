import { expect, test } from 'vitest';
import { readDrft } from './drftRead.ts';
import { FIXTURE_V1_0 } from './fixtures/v1-0.ts';
import { FIXTURE_V1_1 } from './fixtures/v1-1.ts';
import { FIXTURE_V1_2 } from './fixtures/v1-2.ts';
import { FIXTURE_V1_3 } from './fixtures/v1-3.ts';
import { FIXTURE_V1_4 } from './fixtures/v1-4.ts';
import { FIXTURE_V1_5 } from './fixtures/v1-5.ts';
import { FIXTURE_V1_6 } from './fixtures/v1-6.ts';
import { FIXTURE_V1_7 } from './fixtures/v1-7.ts';
import { FIXTURE_V1_9 } from './fixtures/v1-9.ts';
import { FIXTURE_V1_11 } from './fixtures/v1-11.ts';
import type { MeshData } from './meshData.ts';

/**
 * Files written by every released version still open in today's reader.
 *
 * This is the format's central promise and the only test that can actually check it. Every
 * other test here round-trips through the current writer, which proves that the writer and
 * the reader agree — and they always will, because they are changed together. What nobody
 * notices until a consumer's asset stops loading is the day the *reader* quietly stops
 * accepting bytes nothing in the repository produces any more.
 *
 * So the fixtures are checked in as base64 and **never regenerated**. When 1.1 ships, add
 * `v1-1.ts` beside this and a case for it; do not touch `v1-0.ts`. A regenerated fixture is
 * not a compatibility test, it is a round trip with extra steps.
 *
 * See docs/FORMAT.md §4.4, rule 1: old files open forever, with no expiry and no migration.
 */

function decode(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

test('a file written by version 1.0 still opens, with its contents intact', () => {
  const asset = readDrft(decode(FIXTURE_V1_0));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(0);
  expect(asset.head.name).toBe('fixture');
  expect(asset.head.generator).toContain('1.0');

  /* Two meshes: one carrying every optional attribute, one carrying none. */
  expect(asset.meshes).toHaveLength(2);
  const rich = asset.meshes[0] as MeshData;
  const plain = asset.meshes[1] as MeshData;

  expect(rich.roughness, 'the optional attributes of a 1.0 file').toBeDefined();
  expect(rich.emissiveColor).toBeDefined();
  expect(rich.specular).toBeDefined();
  expect(rich.roughness?.[0]).toBeCloseTo(0.3, 5);
  expect(rich.positions.length % 3).toBe(0);
  expect(rich.normals.length).toBe(rich.positions.length);

  expect(plain.roughness, 'and the absence of them, which is a separate path').toBeUndefined();
  expect(plain.emissiveColor).toBeUndefined();
  expect(plain.positions.length).toBeGreaterThan(0);
});

test('a file written by version 1.1 still opens, grain and all', () => {
  /*
   * 1.1 added ATTR_GRAIN, the first attribute bit appended since the order was frozen. It
   * lands at the *end* of the MESH payload rather than beside the roughness it belongs with
   * conceptually, and this file is what proves a reader still finds every earlier array
   * where it was — inserting it in the tidy place would have shifted all of them.
   */
  const asset = readDrft(decode(FIXTURE_V1_1));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(1);
  expect(asset.head.generator).toContain('1.1');
  expect(asset.meshes).toHaveLength(2);

  const rich = asset.meshes[0] as MeshData;
  const plain = asset.meshes[1] as MeshData;
  expect(rich.grain?.[0], 'the grain the surface declared').toBeCloseTo(0.7, 5);
  expect(rich.roughness?.[0], 'and the arrays that precede it, still in their places').toBeCloseTo(
    0.3,
    5,
  );
  expect(rich.specular?.[0]).toBeCloseTo(0.4, 5);
  expect(rich.emissiveColor?.[2]).toBeCloseTo(0.9, 5);
  expect(plain.grain, 'and absent still means not mineral').toBeUndefined();
});

test('a file written by version 1.2 still opens, and its coarse level is not a part', () => {
  /*
   * 1.2 added `LODM`. The assertion that matters is the *separation*: the file holds three mesh
   * payloads and exactly two of them are the model, so a reader that counted the coarse level
   * among the parts would pair materials with the wrong meshes and repaint the asset. That is
   * the whole argument for giving a level its own FourCC instead of a field inside `MESH`.
   */
  const asset = readDrft(decode(FIXTURE_V1_2));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(2);
  expect(asset.head.generator).toContain('1.2');
  expect(asset.meshes, 'the model, and only the model').toHaveLength(2);
  expect(asset.lods, 'the coarse level, kept apart from it').toHaveLength(1);

  const coarse = asset.lods[0] as MeshData;
  /* One box: 24 vertices and 12 triangles, hand-derived from what the fixture was written with. */
  expect(coarse.positions.length / 3).toBe(24);
  expect(coarse.indices.length).toBe(36);
  /* And the arrays that precede the new chunk are all still where a 1.1 reader left them. */
  expect((asset.meshes[0] as MeshData).grain?.[0]).toBeCloseTo(0.7, 5);
  expect((asset.meshes[0] as MeshData).roughness?.[0]).toBeCloseTo(0.3, 5);
});

test('an old file is still read in place, not copied', () => {
  // The zero-copy guarantee has to survive version drift too, or the format loses the one
  // property it was designed around.
  const buffer = decode(FIXTURE_V1_0);
  const mesh = readDrft(buffer).meshes[0] as MeshData;
  expect(mesh.positions.buffer).toBe(buffer);
  expect(mesh.positions.byteOffset % 4).toBe(0);
});

/**
 * 1.3 and 1.4, added together on 2026-08-21.
 *
 * **1.3 shipped without a fixture**, which is the practice failing quietly: the rule is that a
 * released version gets one beside this, and the release that added `ATTR_RELIEF` did not. It was
 * noticed while adding 1.4, and closed by checking out the 1.3 writer and running it — so those
 * are bytes that writer really produced. Fabricating them from today's writer with the version
 * patched would have looked like evidence and proved nothing.
 *
 * They are asserted together because what matters about both is the same: the six optional arrays
 * that predate tangents are still read from the six places they sit in, and a version stamp is
 * still the version that wrote it.
 */
test.each([
  ['1.3', FIXTURE_V1_3, 3],
  ['1.4', FIXTURE_V1_4, 4],
])(
  'a file written by version %s still opens, with its contents intact',
  (label, fixture, minor) => {
    const asset = readDrft(decode(fixture));

    expect(asset.versionMajor).toBe(1);
    expect(asset.versionMinor).toBe(minor);
    expect(asset.head.name).toBe('fixture');
    expect(asset.head.generator).toContain(label);

    expect(asset.meshes).toHaveLength(2);
    const rich = asset.meshes[0] as MeshData;
    const plain = asset.meshes[1] as MeshData;

    expect(rich.roughness, 'the optional attributes still land').toBeDefined();
    expect(rich.emissiveColor).toBeDefined();
    expect(rich.grain).toBeDefined();
    expect(rich.relief, 'including the one 1.3 added').toBeDefined();
    expect(rich.positions.length).toBeGreaterThan(0);

    expect(plain.roughness, 'and a mesh with none is given none').toBeUndefined();
    expect(plain.relief).toBeUndefined();
  },
);

test('a file written by version 1.5 still opens, capture and all', () => {
  /*
   * 1.5 added `SPLT`, the first chunk kind that is not geometry and the first that is written as
   * several chunks of one thing. What matters on the way back in is the *join*: four blocks laid
   * out coarse-first, reassembled in ordinal order, with every record's eight words intact. A
   * record naming its own splat index is what makes that checkable without the test having to
   * know the layout it is checking.
   */
  const asset = readDrft(decode(FIXTURE_V1_5));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(5);
  expect(asset.head.generator).toContain('1.5');

  expect(asset.meshes, 'the geometry beside it is untouched').toHaveLength(1);
  expect(asset.meshes[0]?.roughness?.[0]).toBeCloseTo(0.3, 5);

  const splats = asset.splats;
  expect(splats, 'the capture').not.toBeNull();
  if (splats === null) return;
  expect(splats.count).toBe(96);
  expect(splats.totalCount).toBe(96);
  expect(splats.wordsPerSplat).toBe(8);
  expect(splats.sphericalHarmonics, 'counted and not read').toBe(45);
  expect(Array.from(splats.boundsMax)).toEqual([3, 3, 5]);

  const seen = new Set<number>();
  for (let slot = 0; slot < splats.count; slot++) {
    const index = (splats.records[slot * 8] ?? 0) / 100;
    seen.add(index);
    for (let word = 0; word < 8; word++) {
      expect(splats.records[slot * 8 + word]).toBe(index * 100 + word);
    }
  }
  expect(seen.size, 'every splat exactly once, across all four blocks').toBe(96);
});

test('a file written by version 1.6 still opens, rig and all', () => {
  /*
   * 1.6 added three chunks at once, and one of them — `NODE` — had been specified in
   * docs/FORMAT.md §4.3 since v1 with nothing writing it, so this is the first file in the
   * format's history to carry one. What matters on the way back in is that a hierarchy, a skin
   * and a clip survive beside geometry that predates all three: every reader before this skipped
   * them in silence, and every reader after must not.
   */
  const asset = readDrft(decode(FIXTURE_V1_6));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(6);
  expect(asset.head.generator).toContain('1.6');

  expect(asset.meshes, 'the geometry beside it is untouched').toHaveLength(2);
  expect(asset.lods, 'and so is the coarse level 1.2 added').toHaveLength(1);

  expect(asset.nodes.map((node) => node.name)).toEqual(['root', 'hanger']);
  /* -1 is a node that draws nothing, which a hierarchy is mostly made of. */
  expect(asset.nodes[1]?.mesh).toBe(-1);
  expect(asset.nodes[1]?.translation[1]).toBeCloseTo(2, 5);

  expect(asset.skins[0]?.joints.map((joint) => joint.name)).toEqual(['root', 'elbow']);
  expect(asset.skins[0]?.joints[1]?.parent).toBe(0);

  expect(asset.clips[0]?.name).toBe('walk');
  expect(asset.clips[0]?.durationSec).toBeCloseTo(1.5, 5);
  expect(asset.clips[0]?.tracks.map((track) => track.path)).toEqual(['rotation', 'translation']);
});

test('a file written by version 1.7 still opens, morph targets and all', () => {
  /*
   * 1.7 added `MORP`. What matters on the way back in is the *pairing*: only the second mesh has
   * targets, so a reader taking the chunk's own ordinal — which is 0, being the only MORP in the
   * file — would deform the first. The mesh ordinal lives in the payload for exactly that reason.
   */
  const asset = readDrft(decode(FIXTURE_V1_7));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(7);
  expect(asset.head.generator).toContain('1.7');

  expect(asset.meshes, 'the geometry is untouched').toHaveLength(2);
  expect(asset.skins[0]?.joints.map((joint) => joint.name)).toEqual(['root', 'elbow']);
  expect(asset.clips[0]?.name).toBe('walk');

  expect(asset.meshes[0]?.morphTargets, 'the first mesh has none').toBeUndefined();
  expect(asset.meshes[1]?.morphTargetCount).toBe(2);
  /* Target 0 pushes +0.25 along x, target 1 pushes +0.5 along y. Hand-written in the generator. */
  expect(asset.meshes[1]?.morphTargets?.[0]).toBeCloseTo(0.25, 5);
  expect(asset.meshes[1]?.morphTargets?.[4]).toBeCloseTo(0.5, 5);
});

test('a file written by version 1.9 still opens, and defaults the field 1.10 added', () => {
  /*
   * **The practice lapsed for two versions and this is half of the repair.** §4.4 asks for one
   * fixture per released minor version; 1.8 and 1.9 shipped without one. 1.9's bytes were still
   * available — its writer was the working tree the day 1.10 was designed, and this file was
   * produced by it before any of 1.10's code existed. 1.8's are gone, and forging them from a
   * later writer would look like evidence and be none, so that gap is left standing.
   *
   * What the assertion is worth: this file predates `MATL`'s cutout, so it is the case rule 1
   * exists for. It carries no materials at all, which is why the stride forgeries in `drft.test.ts`
   * are the other half — a genuinely old file cannot be made to carry a chunk its writer never
   * wrote.
   */
  const asset = readDrft(decode(FIXTURE_V1_9));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(9);
  expect(asset.head.generator).toContain('1.9');

  expect(asset.meshes, 'the geometry every version before it carried').toHaveLength(2);
  expect(asset.lods, 'the coarse level of 1.2').toHaveLength(1);
  expect(
    asset.nodes.map((node) => node.name),
    'the hierarchy of 1.6',
  ).toEqual(['root', 'hanger']);
  expect(asset.skins[0]?.joints.map((joint) => joint.name)).toEqual(['root', 'elbow']);
  expect(asset.clips[0]?.name).toBe('walk');
  expect(asset.meshes[1]?.morphTargetCount, 'the morph targets of 1.7').toBe(2);
});

test('a file written by version 1.11 still opens, with a skin whole for the first time', () => {
  /*
   * **1.11 is the version at which a `.drft` could carry a whole skin.** `SKIN` — the joint
   * names, their parents, their inverse binds — has round-tripped since 1.6, and the per-vertex
   * half it points at was never written: `MeshData` declared `joints` and `weights` and
   * `validateMeshData` checked both, and `buildMesh` listed the optional arrays it had bits for
   * and never reached these two. So every file before this one carried a skeleton pointing at
   * vertices that recorded no influence on it, and the write succeeded in silence.
   *
   * What the assertion is worth *here*, rather than in the round trip beside it: the four arrays
   * that predate these two are still read from the four places they sit in. Appending is the only
   * thing that makes that true, and it is the whole reason the attribute order is frozen.
   */
  const asset = readDrft(decode(FIXTURE_V1_11));

  expect(asset.versionMajor).toBe(1);
  expect(asset.versionMinor).toBe(11);
  expect(asset.head.generator).toContain('1.11');

  const skinned = asset.meshes[0] as MeshData;
  const plain = asset.meshes[1] as MeshData;

  expect(skinned.joints, 'the half 1.11 added').toBeDefined();
  expect(skinned.weights).toBeDefined();
  expect(skinned.joints?.length, 'four influences a vertex').toBe(
    (skinned.positions.length / 3) * 4,
  );
  /* Hand-written in the generator: three quarters on one joint and a quarter on the other. */
  expect(skinned.weights?.[0]).toBeCloseTo(0.75, 5);
  expect(skinned.weights?.[1]).toBeCloseTo(0.25, 5);

  expect(
    skinned.roughness?.[0],
    'and the arrays that precede them, still in their places',
  ).toBeCloseTo(0.3, 5);
  expect(skinned.grain?.[0]).toBeCloseTo(0.7, 5);
  expect(skinned.relief?.[0]).toBeCloseTo(0.45, 5);
  expect(skinned.tangents?.[0], 'including the four-float one 1.4 added').toBeCloseTo(1, 5);

  expect(
    asset.skins[0]?.joints.map((joint) => joint.name),
    'the skeleton it points at',
  ).toEqual(['root', 'elbow']);

  expect(plain.joints, 'and a mesh with no influences is given none').toBeUndefined();
  expect(plain.weights).toBeUndefined();
});

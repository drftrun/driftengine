import { describe, expect, it } from 'vitest';

import type { AnimationClip, DrftSkin, MeshData } from './index.ts';
import type { DrftNode } from './drftSkin.ts';
import {
  CHUNK_ANIM,
  CHUNK_ENTRY_BYTES,
  CHUNK_MORP,
  CHUNK_NODE,
  CHUNK_REQUIRED,
  CHUNK_SKIN,
  DRFT_VERSION_MINOR,
  HEADER_BYTES,
} from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';

function triangle(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function identityMatrices(n: number): Float32Array {
  const out = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) {
    out[i * 16] = 1;
    out[i * 16 + 5] = 1;
    out[i * 16 + 10] = 1;
    out[i * 16 + 15] = 1;
  }
  return out;
}

const SKIN: DrftSkin = {
  joints: [
    { parent: -1, name: 'root' },
    { parent: 0, name: 'elbow' },
  ],
  inverseBind: identityMatrices(2),
};

const CLIP: AnimationClip = {
  name: 'walk',
  durationSec: 1.5,
  tracks: [
    {
      joint: 1,
      path: 'rotation',
      times: new Float32Array([0, 1.5]),
      values: new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]),
    },
    {
      joint: 0,
      path: 'translation',
      times: new Float32Array([0]),
      values: new Float32Array([2, 0, 0]),
    },
  ],
};

const NODES: DrftNode[] = [
  {
    parent: -1,
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mesh: 0,
    name: 'root',
  },
  {
    parent: 0,
    translation: [0, 2, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mesh: -1,
    name: 'hanger',
  },
];

/**
 * The same triangle with a skin's per-vertex half on it: four influences a vertex, hand-written.
 *
 * Deliberately ragged — three influences, then two, then one, with the unused slots at zero
 * weight — because a fixture where every vertex carries the same four numbers cannot tell an
 * array that survived from one the reader rebuilt.
 */
function skinnedTriangle(): MeshData {
  return {
    ...triangle(),
    joints: new Float32Array([0, 1, 0, 0, 1, 2, 0, 0, 2, 0, 0, 0]),
    weights: new Float32Array([0.75, 0.25, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0]),
  };
}

function assetWithSkin(mesh: MeshData = triangle()) {
  return { meshes: [mesh], nodes: NODES, skins: [SKIN], clips: [CLIP] };
}

/** The chunk table's flags word for the first chunk of a given kind. */
function flagsOfChunk(buffer: ArrayBuffer, code: number): number {
  const view = new DataView(buffer);
  const count = view.getUint32(12, true);
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * CHUNK_ENTRY_BYTES;
    if (view.getUint32(at, true) === code) return view.getUint16(at + 12, true);
  }
  throw new Error('chunk not written');
}

describe('the three chunks at 1.6', () => {
  it('writes at the current minor version, whatever it is', () => {
    /* The value moves with the format; what this pins is that the writer stamps it. */
    expect(readDrft(writeDrft(assetWithSkin())).versionMinor).toBe(DRFT_VERSION_MINOR);
  });

  it('writes a skin and reads it back', () => {
    const asset = readDrft(writeDrft(assetWithSkin()));
    expect(asset.skins).toHaveLength(1);
    expect(asset.skins[0]?.joints.map((j) => j.name)).toEqual(['root', 'elbow']);
    expect(asset.skins[0]?.joints[1]?.parent).toBe(0);
    expect(Array.from(asset.skins[0]?.inverseBind ?? [])).toEqual(Array.from(identityMatrices(2)));
  });

  /**
   * **A skin is two halves and the container carried one of them.**
   *
   * `SKIN` — the joint names, their parents, their inverse binds — has round-tripped correctly
   * since 1.6, and is asserted immediately above. The per-vertex half it points *at* was not
   * written at all: `MeshData` declared `joints` and `weights`, `validateMeshData` checked that
   * both are four floats a vertex and that neither appears without the other, and `buildMesh`
   * then listed the six optional arrays by ascending bit and never reached these two.
   *
   * **What made it worth a version rather than a warning is that the write succeeded.** A baker
   * handed `writeDrft` a correctly-validated skinned mesh, got no error and no warning, and
   * produced a file that nothing could skin — a skeleton, its bind pose and its clips all intact,
   * pointing at vertices that recorded no influence on any of it. A format that drops half a skin
   * in silence is worse than one that says it has no skins, because the second fails while
   * somebody can still act on it.
   *
   * Asserted here rather than only in the enumerating round trip beside `sampleMesh`, because
   * what is wrong when this goes red is a *capability* and not an attribute: `Mesh.isSkinned`
   * reads `data.joints`, so a file that lost them draws in bind pose for ever.
   */
  it('writes the per-vertex half of a skin, not only the skeleton it points at', () => {
    const asset = readDrft(writeDrft(assetWithSkin(skinnedTriangle())));
    const mesh = asset.meshes[0] as MeshData;

    expect(Array.from(mesh.joints ?? []), 'which joints move each vertex').toEqual([
      0, 1, 0, 0, 1, 2, 0, 0, 2, 0, 0, 0,
    ]);
    expect(Array.from(mesh.weights ?? []), 'and how much each of them moves it').toEqual([
      0.75, 0.25, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0,
    ]);
    expect(asset.skins, 'beside the skeleton, which never stopped surviving').toHaveLength(1);
  });

  /**
   * The absent case, which is a different path and the one every unskinned asset in existence
   * takes: a mesh with no influences must not come back carrying four zeroed floats a vertex,
   * which `Mesh` would read as skinned and collapse onto joint 0.
   */
  it('invents no influences for a mesh that declared none', () => {
    const mesh = readDrft(writeDrft(assetWithSkin())).meshes[0] as MeshData;
    expect(mesh.joints).toBeUndefined();
    expect(mesh.weights).toBeUndefined();
  });

  it('writes a clip and reads back its tracks, in order, with their keys', () => {
    const clip = readDrft(writeDrft(assetWithSkin())).clips[0];
    expect(clip?.name).toBe('walk');
    expect(clip?.durationSec).toBeCloseTo(1.5, 6);
    expect(clip?.tracks.map((t) => t.path)).toEqual(['rotation', 'translation']);
    expect(Array.from(clip?.tracks[0]?.values ?? [])).toEqual([0, 0, 0, 1, 0, 1, 0, 0]);
    /* Three floats a key for a translation track, four for a rotation one. */
    expect(clip?.tracks[1]?.values.length).toBe(3);
  });

  it('writes the hierarchy and reads it back, mesh index and all', () => {
    const asset = readDrft(writeDrft(assetWithSkin()));
    expect(asset.nodes.map((n) => n.name)).toEqual(['root', 'hanger']);
    expect(asset.nodes[1]?.parent).toBe(0);
    expect(asset.nodes[1]?.translation[1]).toBeCloseTo(2, 6);
    /* -1 is a node that draws nothing, which a hierarchy is mostly made of. */
    expect(asset.nodes[1]?.mesh).toBe(-1);
  });

  /*
   * All three are optional, and that is what makes 1.6 additive rather than a break. A *required*
   * chunk a reader does not know is a refusal by rule 3, so marking any of these required would
   * make every 1.6 file unopenable in every reader shipped before today — the one direction the
   * format promises never to fail in.
   */
  it('marks none of them required, so an older reader skips them in silence', () => {
    const buffer = writeDrft(assetWithSkin());
    for (const code of [CHUNK_NODE, CHUNK_SKIN, CHUNK_ANIM]) {
      expect(flagsOfChunk(buffer, code) & CHUNK_REQUIRED).toBe(0);
    }
  });

  it('reads a file carrying none of them as having none', () => {
    const asset = readDrft(writeDrft({ meshes: [triangle()] }));
    expect(asset.skins).toEqual([]);
    expect(asset.clips).toEqual([]);
    expect(asset.nodes).toEqual([]);
    expect(asset.meshes).toHaveLength(1);
  });

  /*
   * The ordering contract, checked where the bytes are read rather than trusted from the writer.
   * A palette is resolved in index order, so a joint whose parent is not already resolved makes a
   * rig wrong in one limb — a bad animation rather than a bad file, unless a reader says so.
   */
  it('refuses a skin whose child precedes its parent, naming the joint', () => {
    const wrong: DrftSkin = {
      joints: [
        { parent: 1, name: 'child' },
        { parent: -1, name: 'root' },
      ],
      inverseBind: identityMatrices(2),
    };
    expect(() => readDrft(writeDrft({ meshes: [triangle()], skins: [wrong] }))).toThrow(/parent/i);
  });

  it('refuses a skin whose inverse-bind array does not cover its joints', () => {
    const short: DrftSkin = { joints: SKIN.joints, inverseBind: identityMatrices(1) };
    expect(() => writeDrft({ meshes: [triangle()], skins: [short] })).toThrow(/inverse-bind/i);
  });

  /* Two clips are two chunks, found by the table rather than by position. */
  it('carries several clips', () => {
    const second: AnimationClip = { ...CLIP, name: 'run' };
    const asset = readDrft(writeDrft({ meshes: [triangle()], clips: [CLIP, second] }));
    expect(asset.clips.map((c) => c.name)).toEqual(['walk', 'run']);
  });
});

describe('MORP at 1.7', () => {
  /** Two meshes, only the second of which has targets. */
  function assetWithMorph() {
    const morphed = {
      ...triangle(),
      morphTargets: new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3, 1, 1, 1, 2, 2, 2, 3, 3, 3]),
      morphTargetCount: 2,
    };
    return { meshes: [triangle(), morphed] };
  }

  it('writes a mesh’s deltas and reads them back onto that mesh', () => {
    const asset = readDrft(writeDrft(assetWithMorph()));
    expect(asset.meshes[0]?.morphTargets).toBeUndefined();
    expect(asset.meshes[1]?.morphTargetCount).toBe(2);
    expect(Array.from(asset.meshes[1]?.morphTargets ?? [])).toEqual([
      1, 0, 0, 0, 2, 0, 0, 0, 3, 1, 1, 1, 2, 2, 2, 3, 3, 3,
    ]);
  });

  /*
   * **The mesh ordinal lives in the payload, not the chunk table's `index`.** That field is the
   * ordinal *within a FourCC* and the writer derives it, so for a file where only the second mesh
   * has targets the single MORP chunk carries index 0 — and a reader pairing by it would deform
   * mesh 0. This asserts the pairing survives exactly that shape.
   */
  it('pairs by the mesh it names rather than by its own ordinal', () => {
    const asset = readDrft(writeDrft(assetWithMorph()));
    expect(asset.meshes[0]?.morphTargetCount).toBeUndefined();
    expect(asset.meshes[1]?.morphTargetCount).toBe(2);
  });

  it('is optional, so an older reader skips it in silence', () => {
    const buffer = writeDrft(assetWithMorph());
    expect(flagsOfChunk(buffer, CHUNK_MORP) & CHUNK_REQUIRED).toBe(0);
  });

  it('arrived at the seventh minor version, and the container has moved past it', () => {
    /* `MORP` is 1.7's chunk and `SUBS` is 1.8's, so this asserts the floor rather than the current
       number — a test that pins the container version to the last chunk added has to be edited by
       every chunk after it, which is a test about bookkeeping rather than about the format. */
    expect(DRFT_VERSION_MINOR).toBeGreaterThanOrEqual(7);
  });
});

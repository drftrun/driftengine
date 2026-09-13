import { describe, expect, it } from 'vitest';

import type { GltfDocument } from './gltf.ts';
import { gltfToMeshes } from './gltf.ts';
import { readGltfSkins } from './gltfSkin.ts';

/** n identity 4x4s as a byte buffer, hand-built rather than produced by the code under test. */
function identityMatrices(n: number): Uint8Array {
  const out = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) {
    out[i * 16] = 1;
    out[i * 16 + 5] = 1;
    out[i * 16 + 10] = 1;
    out[i * 16 + 15] = 1;
  }
  return new Uint8Array(out.buffer);
}

/**
 * Two joints listed child-first, which is what an exporter is free to do and most do somewhere.
 * Node 1 is the root and names node 0 as its child.
 */
function skinnedDoc(): GltfDocument {
  return {
    asset: { version: '2.0' },
    nodes: [{ name: 'child' }, { name: 'root', children: [0] }],
    skins: [{ joints: [0, 1], inverseBindMatrices: 0 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'MAT4' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 128 }],
    buffers: [{ byteLength: 128 }],
  } as GltfDocument;
}

describe('reading a skin', () => {
  /*
   * The importer sorts and `Skeleton` refuses an unsorted hierarchy, so this is the seam where the
   * ordering contract is actually met. It is also the only layer that *can* sort: every index
   * naming a joint — a mesh's `JOINTS_0`, an animation channel's target — has to move with it.
   */
  it('sorts joints parents-first and reports the remap', () => {
    const { skins } = readGltfSkins(skinnedDoc(), [identityMatrices(2)]);
    const skin = skins[0];
    expect(skin?.joints.map((j) => j.name)).toEqual(['root', 'child']);
    expect(skin?.joints[0]?.parent).toBe(-1);
    expect(skin?.joints[1]?.parent).toBe(0);
    /* glTF joint 0 was the child, which is index 1 once sorted. */
    expect(Array.from(skin?.remap ?? [])).toEqual([1, 0]);
  });

  it('reads a document with no skins as having none', () => {
    const doc = { asset: { version: '2.0' }, nodes: [], meshes: [], scenes: [{ nodes: [] }] };
    expect(readGltfSkins(doc as GltfDocument, []).skins).toEqual([]);
    expect(readGltfSkins(doc as GltfDocument, []).clips).toEqual([]);
  });

  /*
   * The promise that makes this additive: a document with no `skins` is still flattened to world
   * space, which is what every existing import depends on and what `gltf.ts`'s header states.
   * Asserted on the positions rather than on "it did not throw", because not throwing is what an
   * importer that quietly stopped baking transforms would also do.
   *
   * Hand-derived: one triangle at the origin under a node translated five along x comes out at
   * five along x.
   */
  it('still bakes a node transform into the vertices when there is no skin', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const doc: GltfDocument = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'moved', mesh: 0, translation: [5, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
      buffers: [{ byteLength: positions.byteLength }],
    } as GltfDocument;

    const { meshes } = gltfToMeshes(doc, [new Uint8Array(positions.buffer)]);
    expect(meshes[0]?.positions[0]).toBeCloseTo(5, 5);
    expect(meshes[0]?.positions[3]).toBeCloseTo(6, 5);
    expect(readGltfSkins(doc, [new Uint8Array(positions.buffer)]).skins).toEqual([]);
  });

  it('refuses a skin naming a node that is not there, by index', () => {
    const doc = skinnedDoc();
    (doc as { skins?: { joints: number[] }[] }).skins = [{ joints: [0, 7] }];
    expect(() => readGltfSkins(doc, [identityMatrices(2)])).toThrow(/7/);
  });

  /*
   * A joint whose parent is outside the skin is a root *of this skin*. glTF allows it — a rig
   * hung under a scene node — and reading it as a cycle or a missing parent would refuse files
   * that are perfectly valid.
   */
  it('treats a joint whose parent is outside the skin as a root', () => {
    const doc: GltfDocument = {
      asset: { version: '2.0' },
      nodes: [{ name: 'scene', children: [1] }, { name: 'hips', children: [2] }, { name: 'spine' }],
      skins: [{ joints: [1, 2], inverseBindMatrices: 0 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'MAT4' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 128 }],
      buffers: [{ byteLength: 128 }],
    } as GltfDocument;
    const { skins } = readGltfSkins(doc, [identityMatrices(2)]);
    expect(skins[0]?.joints.map((j) => j.name)).toEqual(['hips', 'spine']);
    expect(skins[0]?.joints[0]?.parent).toBe(-1);
    expect(skins[0]?.joints[1]?.parent).toBe(0);
  });
});

describe('reading animations', () => {
  /** One channel rotating node 1 over one second, with the keys inline. */
  function animatedDoc(): { doc: GltfDocument; buffers: Uint8Array[] } {
    const times = new Float32Array([0, 1]);
    const values = new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]);
    const binds = identityMatrices(2);
    const blob = new Uint8Array(binds.length + times.byteLength + values.byteLength);
    blob.set(binds, 0);
    blob.set(new Uint8Array(times.buffer), binds.length);
    blob.set(new Uint8Array(values.buffer), binds.length + times.byteLength);

    return {
      buffers: [blob],
      doc: {
        asset: { version: '2.0' },
        nodes: [{ name: 'child' }, { name: 'root', children: [0] }],
        skins: [{ joints: [0, 1], inverseBindMatrices: 0 }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 2, type: 'MAT4' },
          { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR' },
          { bufferView: 2, componentType: 5126, count: 2, type: 'VEC4' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: binds.length },
          { buffer: 0, byteOffset: binds.length, byteLength: times.byteLength },
          { buffer: 0, byteOffset: binds.length + times.byteLength, byteLength: values.byteLength },
        ],
        buffers: [{ byteLength: blob.length }],
        animations: [
          {
            name: 'turn',
            samplers: [{ input: 1, output: 2 }],
            channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
          },
        ],
      } as GltfDocument,
    };
  }

  it('reads a clip, its duration and its keys', () => {
    const { doc, buffers } = animatedDoc();
    const { clips } = readGltfSkins(doc, buffers);
    expect(clips.map((c) => c.name)).toEqual(['turn']);
    expect(clips[0]?.durationSec).toBeCloseTo(1, 6);
    expect(clips[0]?.tracks[0]?.path).toBe('rotation');
    expect(Array.from(clips[0]?.tracks[0]?.times ?? [])).toEqual([0, 1]);
  });

  /*
   * The channel targets glTF node 1, which is the *root* and therefore joint 0 once sorted. A
   * track left pointing at the unsorted index animates the wrong limb — which looks like a bad
   * rig rather than a bad importer, and is why this is asserted rather than reviewed.
   */
  it('remaps a channel onto the sorted joint index', () => {
    const { doc, buffers } = animatedDoc();
    expect(readGltfSkins(doc, buffers).clips[0]?.tracks[0]?.joint).toBe(0);
  });

  it('skips a channel targeting a node no skin contains, rather than refusing the file', () => {
    const { doc, buffers } = animatedDoc();
    const animations = (doc as { animations?: { channels: { target: { node: number } }[] }[] })
      .animations;
    const channel = animations?.[0]?.channels[0];
    if (channel !== undefined) channel.target.node = 99;
    expect(readGltfSkins(doc, buffers).clips[0]?.tracks).toEqual([]);
  });
});

describe('a skinned primitive on the mesh path', () => {
  /** One triangle weighted entirely to glTF joint 0, under a node translated five along x. */
  function skinnedMeshDoc(): { doc: GltfDocument; buffers: Uint8Array[] } {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const binds = identityMatrices(2);

    const parts = [new Uint8Array(positions.buffer), joints, new Uint8Array(weights.buffer), binds];
    let at = 0;
    const offsets = parts.map((part) => {
      const start = at;
      at += part.length;
      return start;
    });
    const blob = new Uint8Array(at);
    parts.forEach((part, i) => blob.set(part, offsets[i] as number));

    return {
      buffers: [blob],
      doc: {
        asset: { version: '2.0' },
        scenes: [{ nodes: [1] }],
        nodes: [
          { name: 'child' },
          { name: 'root', mesh: 0, translation: [5, 0, 0], skin: 0, children: [0] },
        ],
        skins: [{ joints: [0, 1], inverseBindMatrices: 3 }],
        meshes: [
          {
            primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }],
          },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
          { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
          { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
          { bufferView: 3, componentType: 5126, count: 2, type: 'MAT4' },
        ],
        bufferViews: parts.map((part, i) => ({
          buffer: 0,
          byteOffset: offsets[i] as number,
          byteLength: part.length,
        })),
        buffers: [{ byteLength: blob.length }],
      } as GltfDocument,
    };
  }

  /*
   * **A skinned primitive is not baked**, and this is the behaviour change to be careful about.
   * A palette entry already places the vertex, so baking the node's world matrix in as well
   * applies the character's placement twice and throws the rig across the scene. Hand-derived:
   * the triangle's first vertex is at the origin in model space and must stay there, where an
   * unskinned one under the same node comes out at five.
   */
  it('leaves a skinned primitive in model space', () => {
    const { doc, buffers } = skinnedMeshDoc();
    const { meshes } = gltfToMeshes(doc, buffers);
    expect(meshes[0]?.positions[0]).toBeCloseTo(0, 5);
  });

  it('carries the two attributes, four per vertex, as floats', () => {
    const { doc, buffers } = skinnedMeshDoc();
    const mesh = gltfToMeshes(doc, buffers).meshes[0];
    expect(mesh?.joints).toBeInstanceOf(Float32Array);
    expect(mesh?.joints?.length).toBe(12);
    expect(mesh?.weights?.length).toBe(12);
  });

  /*
   * The indices move with the sort. glTF joint 0 is the child here, which is index 1 once sorted
   * parents-first — so a mesh left naming 0 would weight every vertex to the root and the limb
   * would not move. This is the failure that reads as a bad rig rather than as a bad importer.
   */
  it('remaps the joint indices onto the sorted order', () => {
    const { doc, buffers } = skinnedMeshDoc();
    const mesh = gltfToMeshes(doc, buffers).meshes[0];
    expect(mesh?.joints?.[0]).toBe(1);
  });

  it('normalises a weight set that does not sum to one, and says so', () => {
    const { doc, buffers } = skinnedMeshDoc();
    /*
     * Halve every weight: the sum becomes 0.5 and the surface would shrink toward the origin.
     *
     * The offset is derived rather than guessed — positions are 3 vec3 floats (36 bytes) and
     * joints 3 vec4 bytes (12), so weights start at 48. Written as 24 first, which landed inside
     * the joint array and made it name joint 63; the importer's own range check caught it, which
     * is the guard doing exactly what it is for.
     */
    const WEIGHTS_AT = 3 * 3 * 4 + 3 * 4;
    const weights = new Float32Array(buffers[0]?.buffer as ArrayBuffer, WEIGHTS_AT, 12);
    for (let i = 0; i < weights.length; i += 4) weights[i] = 0.5;
    const { meshes, warnings } = gltfToMeshes(doc, buffers);
    expect(meshes[0]?.weights?.[0]).toBeCloseTo(1, 5);
    expect(warnings.join(' ')).toMatch(/weight/i);
  });
});

describe('morph targets on the mesh path', () => {
  /** One triangle with two position targets, the second twice the first. */
  function morphedDoc(extraTargets = 0): { doc: GltfDocument; buffers: Uint8Array[] } {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const first = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    const second = new Float32Array([0, 2, 0, 0, 2, 0, 0, 2, 0]);
    const parts = [positions, first, second];
    for (let i = 0; i < extraTargets; i++) parts.push(second);

    let at = 0;
    const offsets = parts.map((part) => {
      const start = at;
      at += part.byteLength;
      return start;
    });
    const blob = new Uint8Array(at);
    parts.forEach((part, i) => blob.set(new Uint8Array(part.buffer), offsets[i] as number));

    return {
      buffers: [blob],
      doc: {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'shape', mesh: 0 }],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0 },
                targets: parts.slice(1).map((_, i) => ({ POSITION: i + 1 })),
              },
            ],
          },
        ],
        accessors: parts.map((_, i) => ({
          bufferView: i,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
        })),
        bufferViews: parts.map((part, i) => ({
          buffer: 0,
          byteOffset: offsets[i] as number,
          byteLength: part.byteLength,
        })),
        buffers: [{ byteLength: blob.length }],
      } as GltfDocument,
    };
  }

  /*
   * **Interleaved by vertex, which is a transpose of how glTF stores them.** glTF has one accessor
   * per target; the shader reads all of a vertex's targets together, so a layout that kept glTF's
   * would make it stride across the whole mesh per target. Hand-derived at two targets: vertex 0's
   * target 0 is at 0, its target 1 at 3, and vertex 1's target 0 at 6.
   */
  it('transposes the targets to be interleaved by vertex', () => {
    const { doc, buffers } = morphedDoc();
    const mesh = gltfToMeshes(doc, buffers).meshes[0];
    expect(mesh?.morphTargetCount).toBe(2);
    expect(mesh?.morphTargets?.length).toBe(3 * 2 * 3);
    /* vertex 0, target 0 => (1,0,0); vertex 0, target 1 => (0,2,0) */
    expect(Array.from(mesh?.morphTargets?.subarray(0, 3) ?? [])).toEqual([1, 0, 0]);
    expect(Array.from(mesh?.morphTargets?.subarray(3, 6) ?? [])).toEqual([0, 2, 0]);
    /* vertex 1, target 0 */
    expect(Array.from(mesh?.morphTargets?.subarray(6, 9) ?? [])).toEqual([1, 0, 0]);
  });

  /*
   * A facial rig routinely carries dozens of targets. Refusing the file serves nobody and taking
   * the first few silently ships a face that cannot make most of its expressions with nothing to
   * point at, so it warns.
   */
  it('keeps what it can carry and says what it dropped', () => {
    const { doc, buffers } = morphedDoc(9);
    const { meshes, warnings } = gltfToMeshes(doc, buffers);
    expect(meshes[0]?.morphTargetCount).toBe(8);
    expect(warnings.join(' ')).toMatch(/11 morph targets/);
  });

  it('leaves a mesh with no targets carrying none', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const doc: GltfDocument = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'plain', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
      buffers: [{ byteLength: positions.byteLength }],
    } as GltfDocument;
    const mesh = gltfToMeshes(doc, [new Uint8Array(positions.buffer)]).meshes[0];
    expect(mesh?.morphTargets).toBeUndefined();
    expect(mesh?.morphTargetCount).toBeUndefined();
  });
});

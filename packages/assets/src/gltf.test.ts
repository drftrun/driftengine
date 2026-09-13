import { expect, test } from 'vitest';
import { gltfToMeshes, readGlb } from './gltf.ts';
import type { GltfDocument } from './gltf.ts';
import { validateMeshData } from '@driftengine/drft';
import { writeDrft } from '@driftengine/drft';
import { readDrft } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';

/**
 * glTF import: the geometry, the transforms, and the refusals.
 *
 * Documents are built by hand rather than loaded from fixture files. A glTF that exercises
 * one behaviour is a dozen lines of JSON and a handful of floats, and writing it out means
 * the test states exactly what it is about — where a binary fixture states nothing at all
 * and has to be trusted.
 *
 * The conformance corpus belongs in the baker's own checks, not here; what is asserted
 * here is the reading, which is the part with opinions in it.
 */

/** One triangle, positions only, packed the way a minimal exporter would. */
function triangleDoc(extra: Partial<GltfDocument> = {}): {
  doc: GltfDocument;
  buffers: Uint8Array[];
} {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);

  const bytes = new Uint8Array(positions.byteLength + normals.byteLength + 8);
  bytes.set(new Uint8Array(positions.buffer), 0);
  bytes.set(new Uint8Array(normals.buffer), positions.byteLength);
  bytes.set(new Uint8Array(indices.buffer), positions.byteLength + normals.byteLength);

  const doc: GltfDocument = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: 6 },
    ],
    buffers: [{ byteLength: bytes.length }],
    ...extra,
  };
  return { doc, buffers: [bytes] };
}

test('a minimal triangle imports as a valid mesh', () => {
  const { doc, buffers } = triangleDoc();
  const { meshes } = gltfToMeshes(doc, buffers);

  expect(meshes).toHaveLength(1);
  const mesh = meshes[0] as MeshData;
  expect(mesh.positions.length).toBe(9);
  expect(mesh.indices).toEqual(new Uint32Array([0, 1, 2]));
  // The engine's own gate, so an import can never produce what the renderer will not draw.
  expect(() => validateMeshData(mesh)).not.toThrow();
});

test('indices are widened to u32 whatever the file stored them as', () => {
  // A u16 index buffer is what almost every exporter writes, and `Mesh` draws u32 only.
  const { doc, buffers } = triangleDoc();
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.indices).toBeInstanceOf(Uint32Array);
});

test('a node transform is baked into the vertices', () => {
  /*
   * `MeshData` has no matrix — geometry is world space, which is what makes a draw one
   * call with no per-object state. So the graph has to be flattened on the way in.
   */
  const { doc, buffers } = triangleDoc({
    nodes: [{ mesh: 0, translation: [10, 0, 0], scale: [2, 2, 2] }],
  });
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.positions[0]).toBeCloseTo(10, 5);
  expect(mesh.positions[3], 'the second vertex is scaled as well as moved').toBeCloseTo(12, 5);
});

test('a child node inherits its parent transform', () => {
  const { doc, buffers } = triangleDoc({
    scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [10, 0, 0], children: [1] },
      { mesh: 0, translation: [5, 0, 0] },
    ],
  });
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.positions[0]).toBeCloseTo(15, 5);
});

test('normals use the inverse transpose, not the position matrix', () => {
  /*
   * The difference only shows under uneven scale, and then it shows badly: a surface
   * stretched on one axis has normals that lean the *other* way. Using the position
   * matrix tilts every one of them, which reads as light sliding across a flat face and
   * gets blamed on the renderer.
   *
   * A 45° face under a 4× x-scale: the position matrix would leave the normal leaning
   * toward x, and the correct one leans away from it.
   */
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const diagonal = Math.SQRT1_2;
  const normals = new Float32Array([
    diagonal,
    diagonal,
    0,
    diagonal,
    diagonal,
    0,
    diagonal,
    diagonal,
    0,
  ]);
  const bytes = new Uint8Array(positions.byteLength + normals.byteLength);
  bytes.set(new Uint8Array(positions.buffer), 0);
  bytes.set(new Uint8Array(normals.buffer), positions.byteLength);

  const doc: GltfDocument = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, scale: [4, 1, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
    ],
    buffers: [{ byteLength: bytes.length }],
  };

  const mesh = gltfToMeshes(doc, [bytes]).meshes[0] as MeshData;
  const nx = mesh.normals[0] as number;
  const ny = mesh.normals[1] as number;
  expect(
    ny,
    'y must now dominate — the x component is divided by the scale, not multiplied',
  ).toBeGreaterThan(nx);
  expect(Math.hypot(nx, ny), 'and it stays a unit vector').toBeCloseTo(1, 5);
});

test('material factors become the vertex attributes this engine shades with', () => {
  const { doc, buffers } = triangleDoc({
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.25, 0.125, 1],
          metallicFactor: 0.8,
          roughnessFactor: 0.2,
        },
        emissiveFactor: [1, 0.5, 0],
      },
    ],
  });
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;

  expect(mesh.colors[0]).toBeCloseTo(0.5, 5);
  expect(mesh.colors[1]).toBeCloseTo(0.25, 5);
  expect(mesh.roughness?.[0]).toBeCloseTo(0.2, 5);
  expect(
    mesh.specular?.[0],
    'metalness maps to highlight strength — an approximation, stated as one',
  ).toBeCloseTo(0.8, 5);
  expect(mesh.emissive?.[0]).toBeCloseTo(1, 5);
  expect(mesh.emissiveColor?.[0]).toBeCloseTo(1, 5);
  expect(mesh.emissiveColor?.[2]).toBeCloseTo(0, 5);
});

test('a material with no emission inherits the albedo rather than naming black', () => {
  // -1 is the engine's own sentinel for "inherit"; naming 0,0,0 would darken the glow of
  // anything that later gained one.
  const { doc, buffers } = triangleDoc();
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.emissiveColor?.[0]).toBe(-1);
});

test('a non-triangle primitive is skipped with a warning, not silently dropped', () => {
  /*
   * Points and lines are legitimate glTF and legitimately not geometry this engine draws.
   * Refusing the file would reject a model for carrying a debug line set; dropping it in
   * silence is how somebody ends up wondering where half their model went.
   */
  const { doc, buffers } = triangleDoc({
    meshes: [
      {
        name: 'guides',
        primitives: [
          { attributes: { POSITION: 0 }, mode: 1 },
          { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 },
        ],
      },
    ],
  });
  const { meshes, warnings } = gltfToMeshes(doc, buffers);
  expect(meshes).toHaveLength(1);
  expect(warnings.join(' ')).toMatch(/guides.*mode 1/);
});

test('a version this reader does not implement is refused by name', () => {
  const { doc, buffers } = triangleDoc({ asset: { version: '1.0' } });
  expect(() => gltfToMeshes(doc, buffers)).toThrow(/version "1.0"/);
});

test('a sparse accessor is refused with an instruction, not a wrong mesh', () => {
  const { doc, buffers } = triangleDoc();
  (doc.accessors as { sparse?: unknown }[])[0]!.sparse = { count: 1 };
  expect(() => gltfToMeshes(doc, buffers)).toThrow(/sparse/);
});

test('a cyclic node graph is refused rather than recursing until the stack gives out', () => {
  const { doc, buffers } = triangleDoc({
    scenes: [{ nodes: [0] }],
    nodes: [{ children: [1] }, { mesh: 0, children: [0] }],
  });
  expect(() => gltfToMeshes(doc, buffers)).toThrow(/cycle/);
});

test('an accessor reading past its buffer is refused', () => {
  const { doc, buffers } = triangleDoc();
  (doc.accessors as { count: number }[])[0]!.count = 4096;
  expect(() => gltfToMeshes(doc, buffers)).toThrow(/past the end/);
});

test('a glb splits into its json and its binary chunk', () => {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }));
  const jsonPadded = new Uint8Array(json.length + ((4 - (json.length % 4)) % 4)).fill(0x20);
  jsonPadded.set(json);
  const binary = new Uint8Array([1, 2, 3, 4]);

  const total = 12 + 8 + jsonPadded.length + 8 + binary.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonPadded, 20);
  view.setUint32(20 + jsonPadded.length, binary.length, true);
  view.setUint32(24 + jsonPadded.length, 0x004e4942, true);
  bytes.set(binary, 28 + jsonPadded.length);

  const result = readGlb(buffer);
  expect(result.json.asset?.version).toBe('2.0');
  expect(result.binary).toEqual(binary);
});

test('something that is not a glb is refused immediately', () => {
  const notGlb = new ArrayBuffer(32);
  expect(() => readGlb(notGlb)).toThrow(/bad magic/);
});

test('an imported mesh survives the bake into .drft and back', () => {
  // The whole pipeline in one assertion: glTF in, .drft out, engine geometry back.
  const { doc, buffers } = triangleDoc();
  const { meshes } = gltfToMeshes(doc, buffers);
  const asset = readDrft(writeDrft({ meshes, head: { name: 'triangle', generator: 'test' } }));

  expect(asset.meshes).toHaveLength(1);
  expect((asset.meshes[0] as MeshData).positions).toEqual((meshes[0] as MeshData).positions);
});

/**
 * A triangle with texture coordinates, and optionally a tangent frame the exporter baked.
 *
 * Built separately from `triangleDoc` rather than bolted onto it: that fixture is what a minimal
 * exporter writes, and half a dozen tests read its accessor indices.
 */
function texturedDoc(
  withTangents: boolean,
  normalMapped = false,
): { doc: GltfDocument; buffers: Uint8Array[] } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  /* Deliberately along -x, which no derivation from these UVs would ever produce. */
  const tangents = new Float32Array([-1, 0, 0, 1, -1, 0, 0, 1, -1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);

  const parts = withTangents ? [positions, normals, uvs, tangents] : [positions, normals, uvs];
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const bytes = new Uint8Array(size + 8);
  let at = 0;
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  for (const part of parts) {
    bytes.set(new Uint8Array(part.buffer), at);
    views.push({ buffer: 0, byteOffset: at, byteLength: part.byteLength });
    at += part.byteLength;
  }
  bytes.set(new Uint8Array(indices.buffer), at);
  views.push({ buffer: 0, byteOffset: at, byteLength: 6 });

  const attributes: Record<string, number> = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 };
  if (withTangents) attributes['TANGENT'] = 3;

  const doc: GltfDocument = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes, indices: withTangents ? 4 : 3, ...(normalMapped ? { material: 0 } : {}) },
        ],
      },
    ],
    ...(normalMapped ? { materials: [{ normalTexture: { index: 0 } }] } : {}),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      ...(withTangents
        ? [{ bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' as const }]
        : []),
      { bufferView: withTangents ? 4 : 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bytes.length }],
  };
  return { doc, buffers: [bytes] };
}

/**
 * A frame the exporter baked is used rather than replaced.
 *
 * A tangent baked by the tool that authored a normal map agrees with that map exactly; one
 * derived here agrees only where the derivation matches the tool's, and the two differ at UV
 * seams and mirrored shells. The fixture's tangent points along -x, which no derivation from
 * its UVs would ever produce, so a test that passes proves the supplied one survived.
 *
 * **This fixture declares no material**, so it says the second half too: authored data is
 * believed whatever the material does or does not sample. Only *inventing* a frame is gated.
 */
test('a primitive that supplies TANGENT keeps it', () => {
  const { doc, buffers } = texturedDoc(true);
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.tangents, 'four floats a vertex').toHaveLength(12);
  expect(mesh.tangents?.[0]).toBeCloseTo(-1, 5);
  expect(mesh.tangents?.[3], 'and its handedness').toBeCloseTo(1, 5);
});

test('a primitive with texture coordinates and no TANGENT gets one derived', () => {
  const { doc, buffers } = texturedDoc(false, true);
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.tangents).toHaveLength(12);
  expect(mesh.tangents?.[0], 'u runs along +x in this fixture').toBeCloseTo(1, 5);
});

/**
 * And a caller that welds first can decline the derivation.
 *
 * The frame is accumulated per index, so deriving it on a mesh the file stores as one vertex per
 * triangle corner gives every corner its own frame and leaves the weld nothing to merge —
 * measured in `tangentOrder.test.ts` at 9,600 corners welding to 9,482 instead of 1,681. The
 * baker declines here and calls `deriveTangentsFor` after `weldMesh`, which is both a smaller
 * mesh and a better frame. **The default is unchanged**, because a consumer reading a model at
 * run time never welds and would otherwise silently lose its normal mapping.
 */
test('a caller that will weld first can decline the derived frame', () => {
  const { doc, buffers } = texturedDoc(false, true);
  const mesh = gltfToMeshes(doc, buffers, { deriveTangents: false }).meshes[0] as MeshData;
  expect(mesh.tangents).toBeUndefined();
});

test('declining the derivation still keeps a frame the file supplied', () => {
  const { doc, buffers } = texturedDoc(true);
  const mesh = gltfToMeshes(doc, buffers, { deriveTangents: false }).meshes[0] as MeshData;
  expect(mesh.tangents, 'authored data is the file s to state').toHaveLength(12);
  expect(mesh.tangents?.[0]).toBeCloseTo(-1, 5);
});

/**
 * And derived for a *map*, not for a UV.
 *
 * One place in this engine reads a tangent frame — `tangentFrame`, inside the flat shader's
 * `if (uNormalStrength > 0.0)` — so a frame derived for a material that declares no normal map is
 * four floats a vertex nothing can fetch. Measured on a CAD export whose eight materials declare
 * none: 8.3 MB of a 51.5 MB model, and a shard on the wire with it.
 */
test('a primitive whose material declares no normal map gets no derived frame', () => {
  const { doc, buffers } = texturedDoc(false);
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.tangents, 'nothing would ever sample it').toBeUndefined();
});

/** With no UVs there is no direction along a texture, and an arbitrary frame is not a measurement. */
test('a primitive with no texture coordinates gets no tangents at all', () => {
  const { doc, buffers } = triangleDoc();
  const mesh = gltfToMeshes(doc, buffers).meshes[0] as MeshData;
  expect(mesh.tangents).toBeUndefined();
});

/**
 * The node graph, reported beside the flattened geometry.
 *
 * **The second test is the load-bearing one.** Checking that a graph comes back proves the new
 * field is filled; only checking that the geometry is still world-space proves the old contract
 * survived, and that is the one §4.4 rule 4 actually forbids breaking.
 */
const GRAPH_TRIANGLE = {
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
    { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 6 },
  ],
  buffers: [{ byteLength: 42 }],
  asset: { version: '2.0' },
};

function graphBytes(): Uint8Array {
  const bytes = new Uint8Array(42);
  const view = new DataView(bytes.buffer);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  positions.forEach((value, at) => view.setFloat32(at * 4, value, true));
  [0, 1, 2].forEach((value, at) => view.setUint16(36 + at * 2, value, true));
  return bytes;
}

test('reports the node graph beside world-space meshes', () => {
  const doc = {
    ...GRAPH_TRIANGLE,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'root', children: [1], translation: [0, 1, 0] },
      { name: 'WHEEL_LF', mesh: 0, translation: [2, 0, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  };
  const result = gltfToMeshes(doc as never, [graphBytes()]);

  expect(result.nodes.map((node) => node.name)).toEqual(['root', 'WHEEL_LF']);
  expect(result.nodes[1]!.parent).toBe(0);
  expect(result.nodes[1]!.translation).toEqual([2, 0, 0]);
  expect(result.nodes[1]!.mesh).toBe(0);
  expect(result.nodes[0]!.mesh).toBe(-1);
});

test('geometry stays world-space, so nothing that read these files changes', () => {
  const doc = {
    ...GRAPH_TRIANGLE,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'moved', mesh: 0, translation: [5, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  };
  const result = gltfToMeshes(doc as never, [graphBytes()]);
  /* The first vertex sits at the origin locally, so world space puts it at the translation. */
  expect(result.meshes[0]!.positions[0]).toBe(5);
});

test('a node with several primitives names each of them', () => {
  const doc = {
    ...GRAPH_TRIANGLE,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'two', mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, indices: 1 },
          { attributes: { POSITION: 0 }, indices: 1 },
        ],
      },
    ],
  };
  const result = gltfToMeshes(doc as never, [graphBytes()]);
  /* One entry per primitive, so every mesh is reachable from the graph. */
  expect(result.nodes.filter((node) => node.mesh >= 0).map((node) => node.mesh)).toEqual([0, 1]);
});

test('a MASK material becomes a cutout, at the cutoff the specification defaults to', () => {
  /*
   * **`MASK` was dropped entirely**, so a masked surface — foliage, a grille, a fence, anything
   * whose shape is in its alpha channel — arrived as the solid rectangle its geometry is. The
   * specification is exact here: `alphaCutoff` applies only in `MASK` mode and defaults to **0.5**,
   * and the surface is fully opaque everywhere it is not discarded, which is why the opacity stays
   * 1 rather than following the base colour's alpha the way `BLEND` does.
   */
  const read = (material: Record<string, unknown>) => {
    const { doc, buffers } = triangleDoc({
      meshes: [
        { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] },
      ],
      materials: [material],
    });
    return gltfToMeshes(doc, buffers);
  };

  const stated = read({
    alphaMode: 'MASK',
    alphaCutoff: 0.25,
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.3] },
  });
  expect(stated.materials[0]!.cutout).toBeCloseTo(0.25, 6);
  expect(stated.materials[0]!.opacity, 'a mask is not a blend').toBe(1);

  const defaulted = read({ alphaMode: 'MASK' });
  expect(defaulted.materials[0]!.cutout).toBeCloseTo(0.5, 6);

  const blended = read({
    alphaMode: 'BLEND',
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.3] },
  });
  expect(blended.materials[0]!.opacity).toBeCloseTo(0.3, 6);
  expect(blended.materials[0]!.cutout, 'a blend discards nothing').toBe(0);

  const opaque = read({ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.3] } });
  expect(opaque.materials[0]!.opacity, 'OPAQUE means the alpha is to be ignored').toBe(1);
  expect(opaque.materials[0]!.cutout).toBe(0);
});

/**
 * `KHR_materials_pbrSpecularGlossiness`: Khronos' archived material model, and the one an asset
 * store still serves.
 *
 * **A file stating it carries no `pbrMetallicRoughness` at all**, so a reader that knows only the
 * core model finds no `baseColorTexture` and returns `albedo: -1` for every surface — with the
 * images read, decoded and written into the bake to be sampled by nothing. Measured on a 1995 Fiat
 * Punto GT before this landed: 20 textures loaded, 0 bound, 144 of 144 meshes reported as carrying
 * no albedo map, and the whole car painted in one flat fallback colour.
 */
function materialDoc(material: Record<string, unknown>): {
  doc: GltfDocument;
  buffers: Uint8Array[];
} {
  return triangleDoc({
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [material],
    images: [{ uri: 'body-diffuse.png' }, { uri: 'body-specgloss.png' }],
    textures: [{ source: 0 }, { source: 1 }],
  });
}

/** That document, read. Texture 0 is the diffuse map and texture 1 the specular-glossiness one. */
function readMaterial(material: Record<string, unknown>): ReturnType<typeof gltfToMeshes> {
  const { doc, buffers } = materialDoc(material);
  return gltfToMeshes(doc, buffers);
}

/** The extension, spelled once so a test states only the fields it is about. */
function specGloss(sg: Record<string, unknown>): Record<string, unknown> {
  return { extensions: { KHR_materials_pbrSpecularGlossiness: sg } };
}

test('a specular-glossiness material binds its diffuse map and solves the pair for a metalness', () => {
  /*
   * Three surfaces, all hand-derived from Appendix B of the extension.
   *
   * A **dielectric** — specular at the 4% every non-metal has — must solve to metallic 0 and keep
   * its diffuse as the base colour unchanged, or every painted surface in a file arrives metal.
   * **Chrome** is the opposite end and the one the base-colour derivation exists for: its diffuse
   * is black and all of its colour is in its specular, so moving the diffuse alone would import a
   * mirror as a black hole. The **middle** case is the quadratic actually being solved rather than
   * hitting an end stop.
   */
  const dielectric = readMaterial(
    specGloss({
      diffuseTexture: { index: 0 },
      diffuseFactor: [0.5, 0.25, 0.125, 1],
      specularFactor: [0.04, 0.04, 0.04],
      glossinessFactor: 0.75,
    }),
  );
  expect(dielectric.materials[0]?.albedo, 'the diffuse map is the base colour map').toBe(0);
  expect(dielectric.materials[0]?.specular).toBeCloseTo(0, 6);
  expect(dielectric.materials[0]?.reflectivity).toBeCloseTo(0, 6);
  /* Glossiness is roughness counted from the other end: 1 − 0.75. */
  expect(dielectric.materials[0]?.roughness).toBeCloseTo(0.25, 6);
  expect(dielectric.materials[0]?.color[0]).toBeCloseTo(0.5, 6);
  expect(dielectric.materials[0]?.color[2]).toBeCloseTo(0.125, 6);
  expect(
    (dielectric.meshes[0] as MeshData).colors[1],
    'and the vertices agree with MATL',
  ).toBeCloseTo(0.25, 5);

  const chrome = readMaterial(
    specGloss({ diffuseFactor: [0, 0, 0, 1], specularFactor: [1, 1, 1], glossinessFactor: 0.9 }),
  );
  expect(chrome.materials[0]?.specular).toBeCloseTo(1, 6);
  expect(chrome.materials[0]?.reflectivity).toBeCloseTo(1, 6);
  expect(chrome.materials[0]?.roughness).toBeCloseTo(0.1, 6);
  expect(
    chrome.materials[0]?.color[0],
    'the specular colour becomes the base colour of a metal',
  ).toBeCloseTo(1, 6);
  expect(chrome.materials[0]?.albedo, 'and it names no map, so it binds none').toBe(-1);

  /*
   * Diffuse 0.5 grey, specular 0.25 grey. b = 0.5·0.75/0.96 + 0.25 − 0.08 = 0.560625,
   * c = −0.21, √(b² + 0.16·0.21) = 0.5898308, so the metalness is 0.0292058/0.08 = 0.3650727.
   * The base colour reads 0.6152279 from *either* end of the blend, which is the conversion being
   * self-consistent rather than two numbers that happen to be close.
   */
  const middle = readMaterial(
    specGloss({
      diffuseFactor: [0.5, 0.5, 0.5, 1],
      specularFactor: [0.25, 0.25, 0.25],
      glossinessFactor: 0.8,
    }),
  );
  expect(middle.materials[0]?.specular).toBeCloseTo(0.3650727, 6);
  expect(middle.materials[0]?.color[0]).toBeCloseTo(0.6152279, 6);
  expect(middle.materials[0]?.roughness).toBeCloseTo(0.2, 6);
});

test("a specular-glossiness material's opacity travels in the diffuse factor's fourth component", () => {
  const read = readMaterial({
    alphaMode: 'BLEND',
    ...specGloss({ diffuseFactor: [1, 1, 1, 0.4], specularFactor: [0.04, 0.04, 0.04] }),
  });
  expect(read.materials[0]?.opacity).toBeCloseTo(0.4, 6);
});

test('a specular-glossiness map is left unbound rather than read through the wrong channels', () => {
  /*
   * The map packs the specular colour in RGB and the glossiness in A. glTF's ORM packing wants
   * roughness in G and metallic in B, so binding it would have the renderer read a specular
   * colour's green as a roughness — worse than binding nothing. Repacking means decoding and
   * re-encoding every image, which is a baker's job and not a reader's.
   *
   * So the pair is absent, and absent is a state this reader already has a rule for: it is what a
   * metallic-roughness material with an ORM map gets, whose per-texel values a scalar cannot
   * express either. **Asserted against that material rather than against the constant**, because
   * the contract is that the two agree and the number itself is a tuning decision.
   */
  const read = readMaterial({
    name: 'body',
    ...specGloss({
      diffuseTexture: { index: 0 },
      specularGlossinessTexture: { index: 1 },
      specularFactor: [0.9, 0.9, 0.9],
      glossinessFactor: 0.9,
    }),
  });

  expect(read.materials[0]?.albedo, 'the diffuse map still binds; that is the whole repair').toBe(
    0,
  );
  expect(read.materials[0]?.ormMap, 'and the specular-glossiness map does not').toBe(-1);

  const reference = readMaterial({
    pbrMetallicRoughness: {
      metallicRoughnessTexture: { index: 1 },
      metallicFactor: 0.9,
      roughnessFactor: 0.9,
    },
  });
  expect(read.materials[0]?.roughness).toBe(reference.materials[0]?.roughness);
  expect(read.materials[0]?.specular).toBe(reference.materials[0]?.specular);
  expect(read.materials[0]?.reflectivity).toBe(reference.materials[0]?.reflectivity);

  expect(read.warnings.join(' ')).toMatch(/material 0 "body".*ORM/);
  expect(read.warnings.filter((w) => w.includes('material 0'))).toHaveLength(1);
});

test('a file that states both models is read as the metallic-roughness one it already converted', () => {
  /*
   * The extension says a renderer that supports it should prefer it, and that is written for one
   * that supports it completely. An exporter writing both did the conversion with the texels in
   * hand and put a real `metallicRoughnessTexture` in the core block — an answer better than the
   * one above can compute, so it wins.
   */
  const read = readMaterial({
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0 },
      metallicFactor: 0.3,
      roughnessFactor: 0.6,
    },
    ...specGloss({
      diffuseTexture: { index: 1 },
      diffuseFactor: [0, 0, 0, 1],
      specularFactor: [1, 1, 1],
    }),
  });
  expect(read.materials[0]?.albedo).toBe(0);
  expect(read.materials[0]?.specular).toBeCloseTo(0.3, 6);
  expect(read.materials[0]?.roughness).toBeCloseTo(0.6, 6);
});

test('a glb carrying the extension imports it, because the model is chosen on the parsed document', () => {
  /*
   * The workaround this replaces rewrote the `.gltf` JSON on disk before the reader saw it, and a
   * `.glb` got nothing from it: the JSON is a length-prefixed chunk inside the file. Here the
   * choice is made on `GltfDocument`, which is what both spellings become — so there is no second
   * path to keep in step.
   */
  const { doc, buffers } = materialDoc(
    specGloss({
      diffuseTexture: { index: 0 },
      specularFactor: [0.04, 0.04, 0.04],
      glossinessFactor: 0.5,
    }),
  );
  const binary = buffers[0] as Uint8Array;
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPadded = new Uint8Array(json.length + ((4 - (json.length % 4)) % 4)).fill(0x20);
  jsonPadded.set(json);
  const binPadded = new Uint8Array(binary.length + ((4 - (binary.length % 4)) % 4));
  binPadded.set(binary);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonPadded, 20);
  view.setUint32(20 + jsonPadded.length, binPadded.length, true);
  view.setUint32(24 + jsonPadded.length, 0x004e4942, true);
  bytes.set(binPadded, 28 + jsonPadded.length);

  const split = readGlb(buffer);
  const read = gltfToMeshes(split.json, [split.binary as Uint8Array]);
  expect(read.materials[0]?.albedo).toBe(0);
  expect(read.materials[0]?.roughness).toBeCloseTo(0.5, 6);
});

import { expect, test } from 'vitest';
import { gltfToMeshes } from './gltf.ts';
import type { GltfDocument } from './gltf.ts';

/**
 * glTF's textures and its alpha, which are the two things that kept it behind FBX.
 *
 * A document is built by hand rather than loaded, because these cases are a few lines of
 * JSON and a fixture file would hide what is being tested. The images are real PNG and JPEG
 * headers, since the baker identifies an image from its own bytes and not from `mimeType`.
 */

/** The first bytes of a valid PNG: signature, then an IHDR giving 2 x 3. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);

const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

/** A one-triangle document whose single material is `material`. */
function documentWith(
  material: Record<string, unknown>,
  extra: Partial<GltfDocument> = {},
): {
  doc: GltfDocument;
  buffers: Uint8Array[];
} {
  const positions = new Uint8Array(POSITIONS.buffer.slice(0));
  const doc: GltfDocument = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    buffers: [{ byteLength: positions.length }],
    materials: [material as never],
    ...extra,
  };
  return { doc, buffers: [positions] };
}

test('an image inside the binary chunk arrives with its bytes, needing no lookup', () => {
  const positions = new Uint8Array(POSITIONS.buffer.slice(0));
  const packed = new Uint8Array(positions.length + PNG.length);
  packed.set(positions, 0);
  packed.set(PNG, positions.length);

  const doc: GltfDocument = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: PNG.length },
    ],
    buffers: [{ byteLength: packed.length }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, name: 'painted' }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 1, mimeType: 'image/png', name: 'wall' }],
  };

  const { materials, textures } = gltfToMeshes(doc, [packed]);
  expect(textures).toHaveLength(1);
  expect(textures[0]?.name).toBe('wall');
  /* The bytes must be the image and only the image, not the whole binary chunk. */
  expect([...(textures[0]?.bytes ?? [])]).toEqual([...PNG]);
  expect(materials[0]?.albedo).toBe(0);
  expect(materials[0]?.name).toBe('painted');
});

test('an image beside the document arrives as a path for the caller to resolve', () => {
  const { doc, buffers } = documentWith(
    { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
    { textures: [{ source: 0 }], images: [{ uri: 'maps/brick%20wall.png' }] },
  );
  const { textures } = gltfToMeshes(doc, buffers);
  /* Percent-decoded, because a URI is not a filename until it is decoded. */
  expect(textures[0]?.name).toBe('maps/brick wall.png');
  expect(textures[0]?.bytes).toBeUndefined();
});

test('alpha counts only when the material says it blends', () => {
  /*
   * The trap. glTF defaults `alphaMode` to OPAQUE, and states that a base colour's fourth
   * component is then to be *ignored*. Reading it unconditionally turns every opaque
   * material that happens to carry an alpha into a see-through one, and exporters write
   * such alphas constantly.
   */
  const opaque = gltfToMeshes(
    ...(Object.values(
      documentWith({
        pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.25] },
      }),
    ) as [GltfDocument, Uint8Array[]]),
  );
  expect(opaque.materials[0]?.opacity).toBe(1);

  const blended = gltfToMeshes(
    ...(Object.values(
      documentWith({
        alphaMode: 'BLEND',
        pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.25] },
      }),
    ) as [GltfDocument, Uint8Array[]]),
  );
  expect(blended.materials[0]?.opacity).toBeCloseTo(0.25, 6);
});

test('a material naming no texture reports no texture, not texture zero', () => {
  const { doc, buffers } = documentWith({
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
  });
  const { materials } = gltfToMeshes(doc, buffers);
  /* -1 and not 0: an absent map must not resolve to whichever texture happens to be first. */
  expect(materials[0]?.albedo).toBe(-1);
});

/** Three images, so a material may name any of them. */
const THREE_IMAGES = {
  textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
  images: [{ uri: 'colour.png' }, { uri: 'normal.png' }, { uri: 'orm.png' }],
};

/*
 * **glTF leaves `metallicRoughnessTexture`'s R channel undefined.** The specification assigns G to
 * roughness and B to metallic and says nothing at all about R. Occlusion lives there only when
 * `occlusionTexture` names the *same image*, which is exactly what the ORM convention is — so
 * reading R in any other case is reading whatever the exporter happened to leave, and the failure
 * presents as a model arriving mysteriously blotchy with nothing in the file to blame.
 */
test('occlusion strength is zero when no occlusionTexture names the ORM image', () => {
  const { doc, buffers } = documentWith(
    { pbrMetallicRoughness: { metallicRoughnessTexture: { index: 2 } } },
    THREE_IMAGES,
  );
  const material = gltfToMeshes(doc, buffers).materials[0];
  expect(material?.ormMap).toBe(2);
  expect(material?.occlusionStrength, 'R is undefined without a matching occlusionTexture').toBe(0);
});

test('occlusion strength is taken when occlusionTexture names the same image', () => {
  const { doc, buffers } = documentWith(
    {
      pbrMetallicRoughness: { metallicRoughnessTexture: { index: 2 } },
      occlusionTexture: { index: 2, strength: 0.6 },
    },
    THREE_IMAGES,
  );
  const material = gltfToMeshes(doc, buffers).materials[0];
  expect(material?.occlusionStrength).toBeCloseTo(0.6, 5);
});

test('a separate occlusion image is dropped rather than given a second sampler', () => {
  const { doc, buffers } = documentWith(
    {
      pbrMetallicRoughness: { metallicRoughnessTexture: { index: 2 } },
      occlusionTexture: { index: 1, strength: 1 },
    },
    THREE_IMAGES,
  );
  const material = gltfToMeshes(doc, buffers).materials[0];
  expect(material?.ormMap, 'the ORM map is still the metallicRoughness one').toBe(2);
  expect(
    material?.occlusionStrength,
    'one map, one unit — the budget says the next is emissive',
  ).toBe(0);
});

/*
 * **The workaround this feature exists to delete.** With a metallicRoughnessTexture present the
 * reader used to zero the factors, because taking them at face value asserted "maximally metallic,
 * maximally rough" over every surface that meant "whatever the map says" — a test character whose
 * base colour averages RGB 26, 27, 27 arrived blown to white. There is somewhere to put them now.
 */
test('the factors become scales where a metallicRoughness map supplies the values', () => {
  const { doc, buffers } = documentWith(
    {
      pbrMetallicRoughness: {
        metallicRoughnessTexture: { index: 2 },
        metallicFactor: 0.8,
        roughnessFactor: 0.3,
      },
    },
    THREE_IMAGES,
  );
  const material = gltfToMeshes(doc, buffers).materials[0];
  expect(material?.metallicScale).toBeCloseTo(0.8, 5);
  expect(material?.roughnessScale).toBeCloseTo(0.3, 5);
  expect(material?.specular, 'the scalar readings mean nothing where a map supplies them').toBe(0);
});

test('the scales are one where no map supplies the values', () => {
  const { doc, buffers } = documentWith({
    pbrMetallicRoughness: { metallicFactor: 0.8, roughnessFactor: 0.3 },
  });
  const material = gltfToMeshes(doc, buffers).materials[0];
  expect(material?.metallicScale, 'nothing to scale, so the scalars stay scalars').toBe(1);
  expect(material?.roughnessScale).toBe(1);
  expect(material?.specular, 'and they still reach the vertex attributes').toBeCloseTo(0.8, 5);
});

test('a normal and an emissive map are carried even though nothing binds them yet', () => {
  const { doc, buffers } = documentWith(
    { normalTexture: { index: 1 }, emissiveTexture: { index: 0 } },
    THREE_IMAGES,
  );
  const material = gltfToMeshes(doc, buffers).materials[0];
  expect(material?.normalMap).toBe(1);
  expect(material?.emissiveMap).toBe(0);
  expect(material?.ormMap, 'and a material with no metallicRoughness map names none').toBe(-1);
});

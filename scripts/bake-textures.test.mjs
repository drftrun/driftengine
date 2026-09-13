/**
 * What the baker puts in `TEXS`, driven end to end through the real baker.
 *
 * **The baker had no test at all before this one**, which is how the case below stayed wrong: a
 * block-compressed texture is decoded so a bought model's maps survive, and the decoded surface
 * was then embedded uncompressed, because nothing on the Node side could write an image back.
 * Measured on a shipped car's level of detail B: 21 textures, 3.6 MB of source, 11.6 MB in the
 * container.
 *
 * **The container is parsed here from `FORMAT.md` §4.2 and §4.5 rather than with this
 * repository's own reader.** A reader and a writer that share a mistake agree with each other,
 * and the claim under test is about the bytes.
 *
 * The fixture is a `.gltf` whose image is a `data:` URI, because that path reaches
 * `describeEmbedded` exactly as a `.glb`'s binary chunk does and is JSON a person can read.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const CODEC_PNG = 1;
const CODEC_RAW = 4;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A single-mip BC1 DDS of one flat colour, `width` by `height`. */
function flatBc1Dds(width, height) {
  const header = Buffer.alloc(128);
  header.write('DDS ', 0, 'ascii');
  header.writeUInt32LE(124, 4);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(1, 28);
  header.writeUInt32LE(32, 76);
  header.writeUInt32LE(0x4, 80);
  header.write('DXT1', 84, 'ascii');

  /*
   * Both endpoints the same colour, so every one of the block's sixteen texels is that colour and
   * the decode is a value this test does not have to work out. c0 > c1 keeps it a four-colour
   * block, which is the branch a flat block would otherwise leave untested.
   */
  const blocks = Buffer.alloc((width / 4) * (height / 4) * 8);
  for (let at = 0; at < blocks.length; at += 8) {
    blocks.writeUInt16LE(0xf801, at);
    blocks.writeUInt16LE(0xf800, at + 2);
  }
  return Buffer.concat([header, blocks]);
}

/** A one-triangle glTF whose only material wears `dds` as its base colour. */
function gltfWithEmbeddedTexture(dds) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
      },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ name: 'body', uri: `data:image/vnd-ms-dds;base64,${dds.toString('base64')}` }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: 6 },
    ],
    buffers: [
      {
        byteLength: bin.length,
        uri: `data:application/octet-stream;base64,${bin.toString('base64')}`,
      },
    ],
  };
}

/** Every `TEXS` chunk, read by the layout `FORMAT.md` states. */
function readTextures(container) {
  assert.equal(container.toString('ascii', 0, 4), 'DRFT', 'magic');
  const chunkCount = container.readUInt32LE(12);
  const out = [];
  for (let i = 0; i < chunkCount; i++) {
    const entry = 32 + i * 16;
    if (container.toString('ascii', entry, entry + 4) !== 'TEXS') continue;
    const at = container.readUInt32LE(entry + 4);
    const length = container.readUInt32LE(at + 12);
    out.push({
      codec: container.readUInt32LE(at),
      width: container.readUInt32LE(at + 4),
      height: container.readUInt32LE(at + 8),
      bytes: container.subarray(at + 16, at + 16 + length),
    });
  }
  return out;
}

/** Every `MATL` entry's four texture ordinals, by the offsets `FORMAT.md` §4.5 states. */
function readMaterialIndices(container) {
  assert.equal(container.toString('ascii', 0, 4), 'DRFT', 'magic');
  const chunkCount = container.readUInt32LE(12);
  for (let i = 0; i < chunkCount; i++) {
    const entry = 32 + i * 16;
    if (container.toString('ascii', entry, entry + 4) !== 'MATL') continue;
    const at = container.readUInt32LE(entry + 4);
    const count = container.readUInt32LE(at);
    const stride = container.readUInt32LE(at + 4);
    const out = [];
    for (let m = 0; m < count; m++) {
      const base = at + 8 + m * stride;
      out.push({
        albedo: container.readInt32LE(base + 40),
        normalMap: container.readInt32LE(base + 48),
        ormMap: container.readInt32LE(base + 52),
        emissiveMap: container.readInt32LE(base + 56),
      });
    }
    return out;
  }
  assert.fail('no MATL chunk');
}

function bakeDocument(doc) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drft-bake-'));
  try {
    const model = path.join(dir, 'model.gltf');
    const out = path.join(dir, 'model.drft');
    writeFileSync(model, JSON.stringify(doc));
    execFileSync('npx', ['tsx', '--conditions=drift-source', 'scripts/bake.ts', model, '-o', out], {
      stdio: 'pipe',
    });
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bake(dds) {
  return bakeDocument(gltfWithEmbeddedTexture(dds));
}

test('a block-compressed texture is decoded and re-encoded, not embedded raw', () => {
  const width = 64;
  const height = 64;
  const container = bake(flatBc1Dds(width, height));
  const textures = readTextures(container);

  assert.equal(textures.length, 1, 'one TEXS chunk');
  const [texture] = textures;
  assert.equal(texture.width, width);
  assert.equal(texture.height, height);
  assert.notEqual(texture.codec, CODEC_RAW, 'a decoded surface must not be embedded uncompressed');
  assert.equal(texture.codec, CODEC_PNG);
  assert.deepEqual([...texture.bytes.subarray(0, 8)], PNG_SIGNATURE, 'the payload is a PNG');
});

test('the re-encoded texture is far smaller than the RGBA it was decoded to', () => {
  const width = 64;
  const height = 64;
  const [texture] = readTextures(bake(flatBc1Dds(width, height)));
  const rgba = width * height * 4;
  assert.ok(
    texture.bytes.length < rgba / 10,
    `a flat surface should compress by more than 10x, ${rgba} to ${texture.bytes.length}`,
  );
});

/**
 * A one-triangle glTF carrying three images, of which the material samples the last two.
 *
 * The unsampled one is **first**, so its removal renumbers both of the others. A test whose spare
 * image sat at the end would pass on a baker that compacted the list and never rewrote an ordinal,
 * which is the half of this that repaints a model when it is missing.
 *
 * The images are DDS at three different sizes, which is what makes each one identifiable in `TEXS`
 * without decoding anything: the chunk states its own width and height.
 */
function gltfWithAnUnsampledTexture(spare, colour, normal) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0]);
  const bin = Buffer.concat([
    Buffer.from(positions.buffer),
    Buffer.from(uvs.buffer),
    Buffer.from(indices.buffer),
  ]);
  const image = (name, dds) => ({
    name,
    uri: `data:image/vnd-ms-dds;base64,${dds.toString('base64')}`,
  });
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] },
    ],
    materials: [
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
        normalTexture: { index: 2 },
      },
    ],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
    images: [image('spare', spare), image('colour', colour), image('normal', normal)],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + uvs.byteLength, byteLength: 6 },
    ],
    buffers: [
      {
        byteLength: bin.length,
        uri: `data:application/octet-stream;base64,${bin.toString('base64')}`,
      },
    ],
  };
}

/**
 * **An image no material samples is not embedded, and the ordinals that survive are renumbered.**
 *
 * A reader keeps every image the file declared so a material's index means what the file said it
 * meant, and the baker used to carry all of them through. Measured on a car written in glTF's
 * archived specular-glossiness model: 20 textures embedded, none of them reachable, the largest a
 * 10 MB body map a browser downloaded and never decoded. `HANDBOOK` §3 had promised the opposite
 * — *only images a material actually reaches are embedded* — for longer than it was true.
 *
 * Compacting without renumbering is the failure this is really guarding: it repaints the model,
 * silently, and it is why neither `readModel` nor `embedTextures` may drop an entry on its own.
 */
test('an image no material samples is left out, and the ordinals that stay are renumbered', () => {
  const container = bakeDocument(
    gltfWithAnUnsampledTexture(flatBc1Dds(8, 8), flatBc1Dds(16, 16), flatBc1Dds(32, 32)),
  );
  const textures = readTextures(container);

  assert.equal(textures.length, 2, 'the spare image is not in the file');
  assert.deepEqual(
    textures.map((texture) => texture.width),
    [16, 32],
    'the two that are reached, in the order they were declared',
  );

  const [material] = readMaterialIndices(container);
  assert.equal(material.albedo, 0, 'the colour map was texture 1 and is now texture 0');
  assert.equal(material.normalMap, 1, 'and the normal map moved down with it');
  assert.equal(
    material.ormMap,
    -1,
    'a map the material never named stays -1 rather than renumbering',
  );
  assert.equal(material.emissiveMap, -1);
});

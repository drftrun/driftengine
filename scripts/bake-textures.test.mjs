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
import { createRequire } from 'node:module';
import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import encodeJpeg, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';
import { decodePng, encodePng, rgbaOf } from '../packages/core/scripts/png.mjs';

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

/*
 * **`--max-texture`: a bought model's maps, shrunk to what a web page can carry.**
 *
 * The fixtures are generated here with the same encoders the baker uses, which is allowed because
 * they are inputs: every expected value below is a literal written by hand.
 */

const CODEC_JPEG = 2;

/** A one-triangle glTF whose base colour is the image `bytes`, carried as a data URI. */
function gltfWithImage(bytes, mime) {
  const doc = gltfWithEmbeddedTexture(Buffer.alloc(0));
  doc.images = [
    { name: 'body', uri: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` },
  ];
  return doc;
}

/** The baker over `doc`, with extra arguments; the container and what the baker printed. */
function bakeWith(doc, extra) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drft-bake-'));
  try {
    const model = path.join(dir, 'model.gltf');
    const out = path.join(dir, 'model.drft');
    writeFileSync(model, JSON.stringify(doc));
    const log = execFileSync(
      'npx',
      ['tsx', '--conditions=drift-source', 'scripts/bake.ts', model, '-o', out, ...extra],
      { stdio: 'pipe' },
    ).toString();
    return { container: readFileSync(out), log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A PNG of one colour, `width` by `height`. */
function flatPng(width, height, rgba) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) pixels.set(rgba, at);
  return encodePng(width, height, pixels);
}

let jpegReady = null;
function readyJpeg() {
  if (jpegReady === null) {
    const require = createRequire(import.meta.url);
    const compile = (file) =>
      WebAssembly.compile(readFileSync(require.resolve(`@jsquash/jpeg/codec/${file}`)));
    jpegReady = Promise.all([
      compile('dec/mozjpeg_dec.wasm').then((m) => initJpegDecode(m)),
      compile('enc/mozjpeg_enc.wasm').then((m) => initJpegEncode(m)),
    ]);
  }
  return jpegReady;
}

test('A TEXTURE OVER --max-texture IS SHRUNK TO FIT, and keeps its codec and its colour', () => {
  const png = flatPng(64, 32, [10, 120, 250, 255]);
  const { container } = bakeWith(gltfWithImage(png, 'image/png'), ['--max-texture', '16']);
  const [texture] = readTextures(container);
  assert.equal(texture.width, 16);
  assert.equal(texture.height, 8);
  assert.equal(texture.codec, CODEC_PNG);
  assert.deepEqual([...texture.bytes.subarray(0, 8)], PNG_SIGNATURE);
  const { rgba } = rgbaOf(decodePng(Buffer.from(texture.bytes)));
  assert.deepEqual([...rgba.subarray(0, 4)], [10, 120, 250, 255]);
});

test('a capped JPEG stays a JPEG, within a lossy round trip of its colour', async () => {
  await readyJpeg();
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4).fill(128);
  const jpeg = new Uint8Array(await encodeJpeg({ data, width, height }, { quality: 90 }));
  const { container } = bakeWith(gltfWithImage(jpeg, 'image/jpeg'), ['--max-texture', '16']);
  const [texture] = readTextures(container);
  assert.equal(texture.codec, CODEC_JPEG);
  assert.equal(texture.width, 16);
  assert.equal(texture.height, 16);
  assert.deepEqual([...texture.bytes.subarray(0, 2)], [0xff, 0xd8]);
  /* Copied: `texture.bytes` views the whole container, and `Buffer#slice` would still view it. */
  const decoded = await decodeJpeg(new Uint8Array(texture.bytes).buffer);
  assert.equal(decoded.width, 16);
  for (let c = 0; c < 3; c++) {
    assert.ok(
      Math.abs(decoded.data[c] - 128) <= 3,
      `channel ${c} is ${decoded.data[c]}, not 128±3`,
    );
  }
});

test('a texture already inside the cap is carried byte for byte', () => {
  const png = flatPng(16, 16, [1, 2, 3, 255]);
  const { container } = bakeWith(gltfWithImage(png, 'image/png'), ['--max-texture', '16']);
  const [texture] = readTextures(container);
  assert.deepEqual([...texture.bytes], [...png]);
});

test('with no --max-texture nothing is resampled', () => {
  const png = flatPng(64, 64, [1, 2, 3, 255]);
  const [texture] = readTextures(bakeWith(gltfWithImage(png, 'image/png'), []).container);
  assert.equal(texture.width, 64);
  assert.deepEqual([...texture.bytes], [...png]);
});

/*
 * **`--texture-codec jpeg`: an opaque colour or data map becomes a JPEG; a map with alpha stays PNG;
 * a normal map stays PNG unless `jpeg-all`**, because JPEG's chroma subsampling bends the
 * directions a normal map writes into its colour.
 */
function gltfWithRoles(png) {
  const doc = gltfWithImage(png, 'image/png');
  /* Image 0 is the base colour; the same bytes again as image 1, the normal map. */
  doc.images.push({ name: 'normal', uri: doc.images[0].uri });
  doc.textures.push({ source: 1 });
  doc.materials[0].normalTexture = { index: 1 };
  return doc;
}

test('AN OPAQUE PNG BECOMES A JPEG UNDER --texture-codec jpeg, AND A NORMAL MAP DOES NOT', () => {
  const png = flatPng(32, 32, [120, 90, 60, 255]);
  const textures = readTextures(
    bakeWith(gltfWithRoles(png), ['--texture-codec', 'jpeg']).container,
  );
  assert.equal(textures.length, 2);
  const codecs = textures.map((t) => t.codec).sort();
  assert.deepEqual(
    codecs,
    [CODEC_PNG, CODEC_JPEG].sort(),
    'one JPEG colour map, one PNG normal map',
  );
  const all = readTextures(bakeWith(gltfWithRoles(png), ['--texture-codec', 'jpeg-all']).container);
  assert.deepEqual(
    all.map((t) => t.codec),
    [CODEC_JPEG, CODEC_JPEG],
  );
});

/**
 * Each component's sampling factors, from a JPEG's frame header: `0x22` is a luma sampled twice
 * each way beside colour sampled once, which is 4:2:0; every component `0x11` is 4:4:4.
 */
function samplingFactors(jpeg) {
  for (let at = 2; at + 4 < jpeg.length;) {
    if (jpeg[at] !== 0xff) break;
    const marker = jpeg[at + 1];
    const length = jpeg.readUInt16BE(at + 2);
    /* SOF0 to SOF2: baseline, extended, progressive. The component table follows the size. */
    if (marker >= 0xc0 && marker <= 0xc2) {
      const count = jpeg[at + 9];
      const out = [];
      for (let c = 0; c < count; c++) out.push(jpeg[at + 10 + c * 3 + 1]);
      return out;
    }
    at += 2 + length;
  }
  return [];
}

test('A NORMAL MAP UNDER jpeg-all KEEPS ALL ITS COLOUR SAMPLES', () => {
  /*
   * A normal map's red and green are a direction's two tilts, so averaging colour across two by
   * two pixels, which 4:2:0 does, bends the surface. MozJPEG keeps every sample by itself at the
   * quality the baker writes, so this holds today either way: it pins the explicit setting, which
   * is what keeps it true if the quality is ever lowered. The colour map is left to the encoder.
   */
  const rgba = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    rgba.set([128 + ((i * 37) % 90), 128 + ((i * 53) % 90), 250, 255], i * 4);
  }
  const png = encodePng(32, 32, rgba);
  const [colour, normal] = readTextures(
    bakeWith(gltfWithRoles(png), ['--texture-codec', 'jpeg-all']).container,
  );
  assert.equal(samplingFactors(colour.bytes).length, 3, 'the colour map is a three-channel JPEG');
  assert.deepEqual(samplingFactors(normal.bytes), [0x11, 0x11, 0x11], 'normal: 4:4:4');
});

test('A NORMAL MAP IS TURNED OVER UNDER --normals-directx, and every other image left alone', () => {
  /*
   * A DirectX normal map points green down where glTF points it up, so every groove is lit from the
   * wrong side. A courtyard's maps were measured that way: at forty horizontal joints across three
   * of its stone maps, the rows above each joint read green over the middle and the rows below
   * under it, the opposite of the convention. 200 turned over is 255 - 200 = 55; red, blue and
   * alpha keep their values, and the colour map, the same bytes, keeps its green.
   */
  const png = flatPng(8, 8, [100, 200, 250, 255]);
  const [colour, normal] = readTextures(
    bakeWith(gltfWithRoles(png), ['--normals-directx']).container,
  );
  const pixelOf = (texture) =>
    Array.from(rgbaOf(decodePng(Buffer.from(texture.bytes))).rgba.slice(0, 4));
  assert.deepEqual(pixelOf(normal), [100, 55, 250, 255], 'the normal map, turned over');
  assert.deepEqual(pixelOf(colour), [100, 200, 250, 255], 'the colour map, as it came');
});

test('a PNG with alpha stays a PNG, whatever the codec asked', () => {
  const png = flatPng(32, 32, [120, 90, 60, 128]);
  const [texture] = readTextures(
    bakeWith(gltfWithImage(png, 'image/png'), ['--texture-codec', 'jpeg']).container,
  );
  assert.equal(texture.codec, CODEC_PNG);
});

/*
 * **`--blend-as-cutout`: a blended material bakes as a cutout instead.** Foliage is authored `BLEND`
 * as often as `MASK`, and a leaf drawn blended is sorted, soft-edged and writes no depth. The flag is
 * the author of the bake saying which they meant, because nothing in the file says it.
 */
function blendedMaterial(container) {
  const count = container.readUInt32LE(12);
  for (let i = 0; i < count; i++) {
    const entry = 32 + i * 16;
    if (container.toString('ascii', entry, entry + 4) !== 'MATL') continue;
    const at = container.readUInt32LE(entry + 4);
    const base = at + 8;
    return {
      cutout: container.readFloatLE(base + 72),
      blend: container.readUInt32LE(base + 76) & 1,
    };
  }
  assert.fail('no MATL chunk');
}

test('A BLEND MATERIAL BAKES AS A BLEND, AND AS A CUTOUT AT 0.5 UNDER --blend-as-cutout', () => {
  const doc = gltfWithImage(flatPng(8, 8, [60, 120, 40, 255]), 'image/png');
  doc.materials[0].alphaMode = 'BLEND';
  assert.deepEqual(blendedMaterial(bakeWith(doc, []).container), { cutout: 0, blend: 1 });
  assert.deepEqual(blendedMaterial(bakeWith(doc, ['--blend-as-cutout']).container), {
    cutout: 0.5,
    blend: 0,
  });
});

/** The `SDFV` chunk's entries, by the layout `sdfv.ts` states: a count, then 40-byte entries. */
function readFieldOrdinals(container) {
  const chunkCount = container.readUInt32LE(12);
  for (let i = 0; i < chunkCount; i++) {
    const entry = 32 + i * 16;
    if (container.toString('ascii', entry, entry + 4) !== 'SDFV') continue;
    const at = container.readUInt32LE(entry + 4);
    const count = container.readUInt32LE(at);
    const out = [];
    for (let e = 0; e < count; e++) out.push(container.readUInt32LE(at + 4 + e * 40));
    return out;
  }
  return null;
}

/*
 * **`--sdf` bakes one field over the file's static geometry, and without it the file is what it
 * was.** The field is what indirect light is traced against; a scene gets one only where somebody
 * asked, because it is megabytes of a web payload.
 */
test('THE --sdf FLAG WRITES ONE FIELD OVER THE WHOLE FILE, and without it there is none', () => {
  const doc = gltfWithImage(flatPng(4, 4, [200, 200, 200, 255]), 'image/png');
  const withField = bakeWith(doc, ['--sdf', '0.25']);
  assert.deepEqual(readFieldOrdinals(withField.container), [0xffffffff]);
  assert.match(withField.log, /field: \d+x\d+x\d+ at 0\.25 m/);
  assert.equal(readFieldOrdinals(bakeWith(doc, []).container), null);
});

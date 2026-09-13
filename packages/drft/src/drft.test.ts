import { expect, test } from 'vitest';
import { MeshBuilder } from '@driftengine/core';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import {
  CHUNK_ENTRY_BYTES,
  CODEC_RAW,
  CHUNK_REQUIRED,
  DRFT_MAGIC,
  DrftError,
  HEADER_BYTES,
  MATERIAL_ENTRY_BYTES,
  fourCC,
} from './drftFormat.ts';
import type { MeshData } from './meshData.ts';

/**
 * The `.drft` container: round trips, and the compatibility rules that are the point of it.
 *
 * The format exists to be lived with for years, so most of what is asserted here is not
 * "does it work" but "does it still refuse, and still forgive, in exactly the documented
 * places". A format whose compatibility behaviour is untested has no compatibility
 * behaviour — it has whatever the current reader happens to do.
 *
 * See docs/FORMAT.md §4.4 for the four rules these mirror.
 */

function sampleMesh(): MeshData {
  /* Every optional attribute, because the enumerating round trip below is only worth as much as
     the fixture it walks. Adding one to `MeshData` means adding it here. */
  const builder = new MeshBuilder()
    .setRoughness(0.3)
    .setGrain(0.6)
    .setRelief(0.45)
    .setEmissiveColor([0.2, 0.4, 0.9]);
  builder.addBox([0, 0, 0], [1, 2, 3], [0.5, 0.6, 0.7], 0.25, 0.4);
  builder.addSphere([4, 0, 0], 1, [0.9, 0.1, 0.2], 0.1, 10, 5);
  const mesh = builder.build();
  /*
   * A tangent frame, four floats a vertex. Handed over rather than derived here, because what
   * this fixture is for is carrying every optional array through the writer — where it comes
   * from is `generateTangents`' business and is tested there.
   */
  const tangents = new Float32Array((mesh.positions.length / 3) * 4);
  for (let v = 0; v * 4 < tangents.length; v += 1) {
    tangents[v * 4] = 1;
    tangents[v * 4 + 3] = v % 2 === 0 ? 1 : -1;
  }
  /*
   * A skin's per-vertex half, four influences a vertex, on the same terms as the tangents above:
   * where the numbers come from is a baker's business, and what this fixture is for is carrying
   * every optional array through the writer.
   *
   * **It was the two arrays this fixture did not carry that the enumerating test below could not
   * see.** `joints` and `weights` were on `MeshData` with validation behind them for as long as
   * `relief` was, and the container wrote neither — so a correctly-validated skinned mesh went
   * through `writeDrft` without an error and came back unskinnable. The method below only walks
   * what the fixture holds, which is why the comment above it says adding an attribute to
   * `MeshData` means adding it here, and why leaving these two out cost a whole capability.
   */
  const vertices = mesh.positions.length / 3;
  const joints = new Float32Array(vertices * 4);
  const weights = new Float32Array(vertices * 4);
  for (let v = 0; v < vertices; v += 1) {
    joints[v * 4] = v % 3;
    joints[v * 4 + 1] = (v + 1) % 3;
    weights[v * 4] = 0.75;
    weights[v * 4 + 1] = 0.25;
  }
  return { ...mesh, tangents, joints, weights };
}

test('a mesh survives a round trip exactly, attribute for attribute', () => {
  const original = sampleMesh();
  const asset = readDrft(writeDrft({ meshes: [original], head: { name: 'sample' } }));

  expect(asset.meshes).toHaveLength(1);
  const copy = asset.meshes[0] as MeshData;
  expect(copy.positions).toEqual(original.positions);
  expect(copy.normals).toEqual(original.normals);
  expect(copy.colors).toEqual(original.colors);
  expect(copy.emissive).toEqual(original.emissive);
  expect(copy.indices).toEqual(original.indices);
  expect(copy.specular).toEqual(original.specular);
  expect(copy.emissiveColor).toEqual(original.emissiveColor);
  expect(copy.roughness).toEqual(original.roughness);
  expect(copy.grain).toEqual(original.grain);
  expect(asset.head.name).toBe('sample');
});

/**
 * Every optional attribute, enumerated rather than listed, reporting all losses at once.
 *
 * **The test above names each attribute, which is exactly how one went missing.** `relief`
 * shipped on `MeshData` and `MeshBuilder` in 0.23.0 and the container was never taught its bit,
 * so a mesh went through `writeDrft` and came back without it. No existing assertion failed,
 * because adding an attribute adds no line to a list of names. A round trip gave the right shape
 * with its surface texture gone, which reads as a lighting problem rather than as a format
 * dropping an array, and it was found from outside.
 *
 * This walks the keys of the mesh it built, so the next attribute added to `MeshData` is covered
 * on the day it exists rather than on the day somebody remembers. Reporting *all* the losses is
 * the other half of the method: the first missing name tells you nothing about the second.
 */
test('no optional attribute is lost in a round trip, whichever ones exist', () => {
  const original = sampleMesh();
  const optional = Object.keys(original).filter(
    (key) => !['positions', 'normals', 'colors', 'emissive', 'indices'].includes(key),
  );
  /* The fixture has to carry every one of them, or this proves nothing about the ones it skips. */
  expect(optional.length, 'the sample mesh must exercise every optional attribute').toBeGreaterThan(
    4,
  );

  const asset = readDrft(writeDrft({ meshes: [original], head: { name: 'sample' } }));
  const copy = asset.meshes[0] as unknown as Record<string, Float32Array | undefined>;
  const source = original as unknown as Record<string, Float32Array | undefined>;

  const lost = optional.filter((key) => copy[key] === undefined);
  const changed = optional.filter(
    (key) => copy[key] !== undefined && String(copy[key]) !== String(source[key]),
  );
  expect({ lost, changed }).toEqual({ lost: [], changed: [] });
});

test('a mesh with no optional attributes round trips without inventing any', () => {
  /*
   * The absent case is not the same code path as the present one, and getting it wrong
   * costs more: a mesh handed a roughness array it never asked for is a mesh whose
   * shading silently changed.
   */
  const builder = new MeshBuilder();
  builder.addBox([0, 0, 0], [1, 1, 1], [1, 1, 1], 0, 0);
  const original = builder.build();
  const copy = readDrft(writeDrft({ meshes: [original] })).meshes[0] as MeshData;

  expect(copy.roughness).toBeUndefined();
  expect(copy.grain, 'and grain, whose absence means the surface is not mineral').toBeUndefined();
  expect(copy.emissiveColor).toBeUndefined();
  expect(copy.positions).toEqual(original.positions);
});

test('vertex data is viewed in place rather than copied', () => {
  /*
   * The reason this format exists instead of glTF. If a future change introduces a copy,
   * the round-trip tests above would all still pass and the whole point would be gone.
   */
  const buffer = writeDrft({ meshes: [sampleMesh()] });
  const mesh = readDrft(buffer).meshes[0] as MeshData;
  expect(mesh.positions.buffer, 'positions must be a view over the file itself').toBe(buffer);
  expect(mesh.indices.buffer).toBe(buffer);
  expect(mesh.positions.byteOffset % 4, 'and it must be aligned, or the view could not exist').toBe(
    0,
  );
});

test('several meshes keep their order and their identities', () => {
  const first = sampleMesh();
  const second = new MeshBuilder();
  second.addBox([9, 9, 9], [0.5, 0.5, 0.5], [0.1, 0.2, 0.3], 0, 0);
  const asset = readDrft(writeDrft({ meshes: [first, second.build()] }));
  expect(asset.meshes).toHaveLength(2);
  expect((asset.meshes[0] as MeshData).positions.length).toBe(first.positions.length);
  // Somewhere on the second box, wherever its first corner happens to fall.
  expect(Math.abs((asset.meshes[1] as MeshData).positions[0] - 9)).toBeCloseTo(0.5, 5);
});

test('bounds are computed from the geometry rather than taken on trust', () => {
  // A caller's wrong bounds would cull an asset out of frame, which reads as a rendering
  // bug and is not one. The writer is holding every vertex, so it works them out.
  const asset = readDrft(writeDrft({ meshes: [sampleMesh()] }));
  expect(asset.head.bounds[0]).toBeCloseTo(-1, 5);
  expect(asset.head.bounds[4]).toBeCloseTo(2, 5);
});

/* --- Compatibility, which is the part that has to hold for years --- */

test('an unknown OPTIONAL chunk is skipped, so a newer minor version still opens', () => {
  /*
   * Rule 2. This is what makes adding a chunk in a minor version free, and it is
   * simulated rather than waited for: a future writer's file is forged by appending an
   * entry this reader has never heard of.
   */
  const original = writeDrft({ meshes: [sampleMesh()] });
  const forged = appendChunk(original, fourCC('XTRA'), 0, new Uint8Array([1, 2, 3, 4]));

  const asset = readDrft(forged);
  expect(asset.meshes).toHaveLength(1);
  expect(asset.skipped, 'and it says what it passed over').toContain('XTRA');
});

test('a coarse level round trips beside the model, and pairs with nothing', () => {
  /*
   * Added in 1.2. It is a whole model at a coarser resolution rather than a part of one, so it
   * is deliberately not in `meshes`: `MATL` pairs with `MESH` by ordinal and both sides refuse a
   * count mismatch, so a level counted as a mesh would either fail to open or shift every
   * material by one. Two levels here, written coarsest first, to pin the ordering.
   */
  const coarse = new MeshBuilder();
  coarse.addBox([0, 0, 0], [2, 2, 2], [0.3, 0.3, 0.3], 0, 0);
  const finer = new MeshBuilder();
  finer.addSphere([0, 0, 0], 2, [0.3, 0.3, 0.3], 0, 8, 4);

  const asset = readDrft(
    writeDrft({
      meshes: [sampleMesh()],
      lods: [coarse.build(), finer.build()],
      materials: [
        {
          name: 'only',
          color: [1, 1, 1],
          specular: 0,
          roughness: 0.4,
          emissive: 0,
          emissiveColor: [-1, -1, -1],
          opacity: 1,
          albedo: -1,
          reflectivity: 0,
          normalMap: -1,
          ormMap: -1,
          emissiveMap: -1,
          roughnessScale: 1,
          metallicScale: 1,
          occlusionStrength: 0,
          cutout: 0,
        },
      ],
    }),
  );

  expect(asset.meshes, 'the model is still one mesh').toHaveLength(1);
  expect(asset.materials).toHaveLength(1);
  expect(asset.lods).toHaveLength(2);
  expect(
    (asset.lods[0] as MeshData).indices.length,
    'coarsest first, by the ordinal the file gave',
  ).toBe(36);
  expect((asset.lods[1] as MeshData).indices.length).toBeGreaterThan(36);
});

test('a coarse level is written as an OPTIONAL chunk, so a 1.1 reader still opens the file', () => {
  /*
   * The whole of the compatibility argument for putting a level under its own FourCC, and the
   * one assertion that catches it being undone: marked required, this chunk would make every
   * reader that predates 1.2 refuse the file outright, per rule 3. Optional, it is skipped in
   * silence and the model draws without its outline, which is what a reader that has never
   * heard of one should produce.
   */
  const coarse = new MeshBuilder();
  coarse.addBox([0, 0, 0], [1, 1, 1], [1, 1, 1], 0, 0);
  const buffer = writeDrft({ meshes: [sampleMesh()], lods: [coarse.build()] });
  const view = new DataView(buffer);
  const chunkCount = view.getUint32(12, true);

  let found = 0;
  let firstMesh = Infinity;
  let levelAt = Infinity;
  for (let i = 0; i < chunkCount; i++) {
    const at = HEADER_BYTES + i * CHUNK_ENTRY_BYTES;
    const code = view.getUint32(at, true);
    if (code === fourCC('MESH')) firstMesh = Math.min(firstMesh, view.getUint32(at + 4, true));
    if (code !== fourCC('LODM')) continue;
    found++;
    levelAt = view.getUint32(at + 4, true);
    expect(view.getUint16(at + 12, true) & CHUNK_REQUIRED, 'LODM must never be required').toBe(0);
    expect(view.getUint16(at + 14, true), 'and its index is its level, coarsest first').toBe(0);
  }
  expect(found).toBe(1);
  /* And it is laid out ahead of the geometry it stands in for, or it would arrive too late
     to be an outline. Payload order is a bake-time choice; this is the choice. */
  expect(levelAt).toBeLessThan(firstMesh);
});

test('an unknown REQUIRED chunk is refused, naming what was not understood', () => {
  // Rule 3. A writer marking a chunk required says the asset is wrong without it, so
  // producing something else would be worse than failing.
  const original = writeDrft({ meshes: [sampleMesh()] });
  const forged = appendChunk(
    original,
    fourCC('MUST'),
    CHUNK_REQUIRED,
    new Uint8Array([0, 0, 0, 0]),
  );

  expect(() => readDrft(forged)).toThrow(/requires chunk "MUST"/);
});

test('a file needing a newer major reader is refused, and says which versions', () => {
  // Rule 5, and the only direction compatibility is allowed to fail.
  const buffer = writeDrft({ meshes: [sampleMesh()] });
  new DataView(buffer).setUint16(8, 99, true);
  expect(() => readDrft(buffer)).toThrow(/needs a reader of version 99/);
});

test('bytes in the reserved range are ignored, so they can become fields later', () => {
  // Rule 6. Without this a future minor version could not add a header field at all.
  const buffer = writeDrft({ meshes: [sampleMesh()] });
  const view = new DataView(buffer);
  view.setUint32(20, 0xdeadbeef, true);
  view.setUint32(24, 0x12345678, true);
  expect(() => readDrft(buffer)).not.toThrow();
});

/* --- Refusing malformed input, rather than misreading it --- */

test('a truncated file is refused rather than read as far as it goes', () => {
  const full = writeDrft({ meshes: [sampleMesh()] });
  const cut = full.slice(0, full.byteLength - 64);
  expect(() => readDrft(cut)).toThrow(DrftError);
});

test('a chunk pointing past the end of the file is refused', () => {
  const buffer = writeDrft({ meshes: [sampleMesh()] });
  // Push the first chunk's offset out beyond the buffer.
  new DataView(buffer).setUint32(HEADER_BYTES + 4, 0xfffff0, true);
  expect(() => readDrft(buffer)).toThrow(/past the end/);
});

test('something that is not a drft file at all is refused immediately', () => {
  const notDrft = new ArrayBuffer(64);
  new DataView(notDrft).setUint32(0, 0x21215a5a, true);
  expect(() => readDrft(notDrft)).toThrow(/not a drft file/);
});

test('an empty asset is refused at write time, not discovered at load', () => {
  expect(() => writeDrft({ meshes: [] })).toThrow(/at least one mesh/);
});

test('a mesh with a short attribute array never reaches a file', () => {
  /*
   * The defect this format was specified after: a short attribute buffer is drawn by some
   * drivers and causes others to drop the draw, with no GL error either way. Caught by the
   * writer, where the message can name the array.
   */
  const broken = { ...sampleMesh(), roughness: new Float32Array(3) };
  expect(() => writeDrft({ meshes: [broken] })).toThrow(/roughness/);
});

test('the magic is the documented one, so other tools can recognise the format', () => {
  const buffer = writeDrft({ meshes: [sampleMesh()] });
  expect(new DataView(buffer).getUint32(0, true)).toBe(DRFT_MAGIC);
  expect(String.fromCharCode(...new Uint8Array(buffer, 0, 4))).toBe('DRFT');
});

/**
 * Forge a file from a later version: one more chunk in the table than this reader knows.
 *
 * Written by hand rather than by a second writer, because the case being tested is a file
 * this codebase cannot produce — that is precisely what forward compatibility means.
 */
function appendChunk(
  original: ArrayBuffer,
  code: number,
  flags: number,
  payload: Uint8Array,
): ArrayBuffer {
  const view = new DataView(original);
  const chunkCount = view.getUint32(12, true);
  const oldTableEnd = HEADER_BYTES + chunkCount * CHUNK_ENTRY_BYTES;
  const shift = CHUNK_ENTRY_BYTES;

  const total = original.byteLength + shift + payload.length;
  const out = new ArrayBuffer(total);
  const outBytes = new Uint8Array(out);
  const outView = new DataView(out);

  /* Header, then the old table, then one new entry, then the payloads moved along. */
  outBytes.set(new Uint8Array(original, 0, oldTableEnd), 0);
  outBytes.set(new Uint8Array(original, oldTableEnd), oldTableEnd + shift);

  outView.setUint32(12, chunkCount + 1, true);
  outView.setUint32(16, total, true);
  for (let i = 0; i < chunkCount; i++) {
    const at = HEADER_BYTES + i * CHUNK_ENTRY_BYTES;
    outView.setUint32(at + 4, view.getUint32(at + 4, true) + shift, true);
  }

  const entry = HEADER_BYTES + chunkCount * CHUNK_ENTRY_BYTES;
  const payloadAt = original.byteLength + shift;
  outView.setUint32(entry, code, true);
  outView.setUint32(entry + 4, payloadAt, true);
  outView.setUint32(entry + 8, payload.length, true);
  outView.setUint16(entry + 12, flags, true);
  outView.setUint16(entry + 14, chunkCount, true);
  outBytes.set(payload, payloadAt);
  return out;
}

/**
 * The chunk table's `index` is the ordinal *within a FourCC*, which is what §4.3 promises a
 * second implementation.
 *
 * It was written as the chunk's position in the table, which is right for whichever kind
 * comes first and wrong for every kind after it: six textures in a 195 chunk file were
 * numbered 188 to 193. Nothing caught it, because this reader takes chunks in the order it
 * meets them rather than by the number they carry, so the field was write-only until
 * somebody built a reader from the document.
 */
test('a chunk index counts within its own FourCC, not across the file', () => {
  const mesh = (): MeshData => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  });
  const pixel = new Uint8Array([255, 0, 0, 255]);
  const buffer = writeDrft({
    meshes: [mesh(), mesh(), mesh()],
    textures: [
      { name: 'first.png', codec: CODEC_RAW, width: 1, height: 1, bytes: pixel },
      { name: 'second.png', codec: CODEC_RAW, width: 1, height: 1, bytes: pixel },
    ],
  });

  const view = new DataView(buffer);
  const chunkCount = view.getUint32(12, true);
  const seen = new Map<string, number[]>();
  for (let i = 0; i < chunkCount; i++) {
    const entry = 32 + i * 16;
    const code = view.getUint32(entry, true);
    const name = String.fromCharCode(
      code & 0xff,
      (code >> 8) & 0xff,
      (code >> 16) & 0xff,
      (code >> 24) & 0xff,
    );
    const list = seen.get(name) ?? [];
    list.push(view.getUint16(entry + 14, true));
    seen.set(name, list);
  }

  /* Hand-derived: three meshes are 0,1,2 and two textures are 0,1, whatever sits between. */
  expect(seen.get('MESH')).toEqual([0, 1, 2]);
  expect(seen.get('TEXS')).toEqual([0, 1]);
  expect(seen.get('HEAD')).toEqual([0]);
});

/**
 * A texture's declared name survives the round trip, and its absence is not a failure.
 *
 * The name is what lets a consumer say which texture it means. Without it the only handle is
 * an ordinal, which is a position in whatever order a reader met its records — so a caller
 * holding one is depending on an accident of parsing.
 */
test('a texture carries the name its source gave it', () => {
  const mesh: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  /* Two bytes so the payload does not land on a boundary, which is where a name written
     after it would be misplaced if the padding were wrong. */
  const asset = readDrft(
    writeDrft({
      meshes: [mesh],
      textures: [
        {
          name: 'textures/Tire_05_DM.jpg',
          codec: CODEC_RAW,
          width: 1,
          height: 1,
          bytes: new Uint8Array([1, 2]),
        },
        { name: '', codec: CODEC_RAW, width: 1, height: 1, bytes: new Uint8Array([3, 4, 5, 6, 7]) },
      ],
    }),
  );

  expect(asset.textures[0]?.name).toBe('textures/Tire_05_DM.jpg');
  expect(asset.textures[1]?.name).toBe('');
  /* The payload must still be intact and at its stated place, name or no name. */
  expect([...(asset.textures[0]?.bytes ?? [])]).toEqual([1, 2]);
  expect([...(asset.textures[1]?.bytes ?? [])]).toEqual([3, 4, 5, 6, 7]);
});

/**
 * MATL's stride must work in both directions, and it only worked in one.
 *
 * Stepping by the stride the *file* declares handles a newer writer, which is the case that
 * was designed for. The other direction is the one the compatibility promise actually rests
 * on: a file written by an older writer has a shorter entry, and refusing it breaks §4.4
 * rule 1, that a file written today opens in every future reader. The first implementation
 * threw on exactly that.
 */
/**
 * Every stride this format has declared, forged and reopened.
 *
 * **44** predates `reflectivity`; **48** predates the three map indices; **72** predates `cutout`.
 * All three must still open, and all three must default the fields they cannot reach rather than
 * reading past themselves into the name block. Anything else breaks §4.4 rule 1, that a file
 * written today opens in every future reader.
 *
 * The current stride is taken from `MATERIAL_ENTRY_BYTES` rather than written down. It was written
 * down, as a bare 48, and the next change to the entry would have made this test forge a file no
 * writer ever produced while still passing.
 */
for (const [stride, absent] of [
  [44, ['reflectivity', 'normalMap', 'ormMap', 'emissiveMap', 'cutout']],
  [48, ['normalMap', 'ormMap', 'emissiveMap', 'cutout']],
  [72, ['cutout']],
] as const) {
  test(`a ${stride} byte material entry still opens, defaulting what it cannot reach`, () => {
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colors: new Float32Array(9).fill(0.5),
      emissive: new Float32Array(3),
      indices: new Uint32Array([0, 1, 2]),
    };
    const buffer = writeDrft({
      meshes: [mesh],
      materials: [
        {
          name: 'paint',
          color: [1, 0, 0],
          specular: 0.5,
          roughness: 0.25,
          emissive: 0,
          emissiveColor: [-1, -1, -1],
          opacity: 0.5,
          albedo: -1,
          reflectivity: 0.9,
          normalMap: 3,
          ormMap: 4,
          emissiveMap: 5,
          roughnessScale: 1,
          metallicScale: 1,
          occlusionStrength: 0,
          cutout: 0.5,
        },
      ],
      /*
       * Six images, because at a 72 byte stride the map indices are inside the entry and the
       * reader checks them against the file. The shorter forgeries default those to -1 and never
       * reach the check, which is why this only became necessary when the entry grew past them.
       */
      textures: Array.from({ length: 6 }, (_, i) => ({
        name: `map${i}.raw`,
        codec: CODEC_RAW,
        width: 1,
        height: 1,
        bytes: new Uint8Array([0, 0, 0, 255]),
      })),
    });

    /*
     * Rewritten as if an older writer had produced it: the entry stops where that version stopped.
     * Only the declared stride changes, which is the whole point — the bytes after it are simply
     * not read. The name block moves with the entries, because its position is derived from the
     * stride, so a forged file has to move it too or it is not the file that writer would have
     * produced.
     */
    const view = new DataView(buffer);
    const chunkCount = view.getUint32(12, true);
    for (let i = 0; i < chunkCount; i++) {
      const entry = 32 + i * 16;
      if (view.getUint32(entry, true) !== fourCC('MATL')) continue;
      const at = view.getUint32(entry + 4, true);
      const bytes = new Uint8Array(buffer);
      bytes.copyWithin(
        at + 8 + stride,
        at + 8 + MATERIAL_ENTRY_BYTES,
        at + view.getUint32(entry + 8, true),
      );
      view.setUint32(at + 4, stride, true);
    }

    const asset = readDrft(buffer);
    const material = asset.materials[0];
    /* The fields that were present are untouched, including the name block the forge moved. */
    expect(material?.opacity).toBeCloseTo(0.5, 6);
    expect(material?.albedo).toBe(-1);
    expect(material?.specular).toBeCloseTo(0.5, 6);
    expect(material?.name).toBe('paint');

    /* And each absent field reads as the engine's default rather than as garbage. */
    const defaults: Record<string, number> = {
      /* Discard nothing, which is what a file written before the field meant. */
      cutout: 0,
      reflectivity: 0,
      normalMap: -1,
      ormMap: -1,
      emissiveMap: -1,
      roughnessScale: 1,
      metallicScale: 1,
      occlusionStrength: 0,
    };
    for (const field of absent) {
      expect(material?.[field], `${field} is past a ${stride} byte entry`).toBe(defaults[field]);
    }
    if (!(absent as readonly string[]).includes('reflectivity')) {
      expect(material?.reflectivity).toBeCloseTo(0.9, 6);
    }
  });
}

/** The three indices and the cutout survive a round trip at the current stride. */
test('a material carries a normal, ORM and emissive texture index, and a cutout', () => {
  const mesh: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  const buffer = writeDrft({
    meshes: [mesh],
    /* Three, so indices 1 and 2 are in range: the reader refuses a material naming a texture the
       file does not carry, and it now refuses that for all four map fields rather than the albedo
       alone. */
    textures: [
      { codec: CODEC_RAW, width: 1, height: 1, bytes: new Uint8Array([1, 2, 3, 4]), name: 'a' },
      { codec: CODEC_RAW, width: 1, height: 1, bytes: new Uint8Array([1, 2, 3, 4]), name: 'b' },
      { codec: CODEC_RAW, width: 1, height: 1, bytes: new Uint8Array([1, 2, 3, 4]), name: 'c' },
    ],
    materials: [
      {
        name: 'painted',
        color: [1, 1, 1],
        specular: 0,
        roughness: 0.4277,
        emissive: 0,
        emissiveColor: [-1, -1, -1],
        opacity: 1,
        albedo: -1,
        reflectivity: 0,
        normalMap: 1,
        ormMap: 2,
        emissiveMap: -1,
        roughnessScale: 1,
        metallicScale: 1,
        occlusionStrength: 0,
        cutout: 0.35,
      },
    ],
  });

  const material = readDrft(buffer).materials[0];
  expect(material?.normalMap).toBe(1);
  expect(material?.ormMap).toBe(2);
  expect(material?.emissiveMap, 'minus one is a material that names no map').toBe(-1);
  expect(material?.cutout, 'the alpha test the source stated, not an opacity').toBeCloseTo(0.35, 6);
});

/** And a map index past the end is refused, the way an albedo index past the end always was. */
test('a material naming a texture the file does not carry is refused', () => {
  const mesh: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  const buffer = writeDrft({
    meshes: [mesh],
    materials: [
      {
        name: 'painted',
        color: [1, 1, 1],
        specular: 0,
        roughness: 0.4277,
        emissive: 0,
        emissiveColor: [-1, -1, -1],
        opacity: 1,
        albedo: -1,
        reflectivity: 0,
        normalMap: -1,
        ormMap: 7,
        emissiveMap: -1,
        roughnessScale: 1,
        metallicScale: 1,
        occlusionStrength: 0,
        cutout: 0,
      },
    ],
  });
  expect(() => readDrft(buffer)).toThrow(/names ORM texture 7/);
});

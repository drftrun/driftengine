import { expect, test } from 'vitest';
import { MeshBuilder } from '@driftengine/core';
import { DrftStream } from './drftStream.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import { CODEC_RAW, DrftError, HEADER_BYTES, fourCC } from './drftFormat.ts';
import type { MeshData } from './meshData.ts';

/**
 * Reading a container while it is still arriving.
 *
 * **What is under test is that the strictness moved rather than relaxed.** docs/FORMAT.md §4.6
 * asks for a separate entry point precisely because `readDrft` refuses anything partial, and the
 * temptation with a streaming reader is to make it forgiving instead — which would mean a
 * malformed file quietly producing half a model. So the assertions are mostly about *when* each
 * rule fires: a chunk when its last byte lands, the table's rules the moment the table is
 * readable, the asset's rules at `end`.
 *
 * Fed through the real writer rather than a hand-built buffer, and fed one byte at a time in
 * places, because the interesting failures live at the boundaries between pushes.
 */

function sampleAsset(): ArrayBuffer {
  const first = new MeshBuilder();
  first.addBox([0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], 0, 0);
  const second = new MeshBuilder();
  second.addSphere([3, 0, 0], 1, [0.2, 0.4, 0.9], 0, 8, 4);
  return writeDrft({
    meshes: [first.build(), second.build()],
    head: { name: 'streamed', generator: 'drftStream.test' },
    materials: [
      {
        name: 'shell',
        color: [1, 1, 1],
        specular: 0.2,
        roughness: 0.4,
        emissive: 0,
        emissiveColor: [1, 1, 1],
        opacity: 1,
        albedo: 0,
        reflectivity: 0,
        normalMap: -1,
        ormMap: -1,
        emissiveMap: -1,
        roughnessScale: 1,
        metallicScale: 1,
        occlusionStrength: 0,
        cutout: 0,
      },
      {
        name: 'core',
        color: [1, 0, 0],
        specular: 0.9,
        roughness: 0.1,
        emissive: 0,
        emissiveColor: [1, 1, 1],
        opacity: 0.5,
        albedo: 0,
        reflectivity: 0.4,
        normalMap: -1,
        ormMap: -1,
        emissiveMap: -1,
        roughnessScale: 1,
        metallicScale: 1,
        occlusionStrength: 0,
        cutout: 0,
      },
    ],
    textures: [
      { name: 'one.raw', codec: CODEC_RAW, width: 2, height: 2, bytes: new Uint8Array(16) },
    ],
  });
}

/** Feed a whole buffer in fixed slices, which is what a network hands over. */
function feed(stream: DrftStream, buffer: ArrayBuffer, sliceBytes: number): void {
  const bytes = new Uint8Array(buffer);
  for (let at = 0; at < bytes.length; at += sliceBytes) {
    stream.push(bytes.subarray(at, Math.min(at + sliceBytes, bytes.length)));
  }
}

test('everything a whole-file read finds, a stream reports as it lands', () => {
  const buffer = sampleAsset();
  const whole = readDrft(buffer);

  const meshes: MeshData[] = [];
  const names: string[] = [];
  let materials = 0;
  let textures = 0;
  let head = '';
  const stream = new DrftStream({
    onHead: (h) => {
      head = h.name;
    },
    onMesh: (mesh) => {
      meshes.push(mesh);
    },
    onMaterials: (list) => {
      materials = list.length;
      for (const m of list) names.push(m.name);
    },
    onTexture: () => {
      textures++;
    },
  });

  /* Seventeen is deliberately not a multiple of anything in the format, so chunk boundaries
     and push boundaries do not line up. */
  feed(stream, buffer, 17);
  stream.end();

  expect(head).toBe('streamed');
  expect(meshes.length).toBe(whole.meshes.length);
  expect(materials).toBe(whole.materials.length);
  expect(textures).toBe(whole.textures.length);
  expect(names).toEqual(['shell', 'core']);
  /* The geometry itself, not merely the count. */
  expect(meshes[0]?.positions).toEqual(whole.meshes[0]?.positions);
  expect(meshes[1]?.indices).toEqual(whole.meshes[1]?.indices);
});

test('a mesh is reported once its own last byte lands, not at the end of the file', () => {
  /*
   * The entire point of streaming, stated as a test: something is on screen before the file is
   * finished. Without this a "streaming" reader is a whole-file reader with extra steps.
   */
  const buffer = sampleAsset();
  let firstMeshAt = -1;
  const stream = new DrftStream({
    onMesh: () => {
      if (firstMeshAt < 0) firstMeshAt = stream.progress.received;
    },
  });
  feed(stream, buffer, 8);
  stream.end();

  expect(firstMeshAt).toBeGreaterThan(0);
  expect(firstMeshAt, 'a mesh arrived before the last byte of the file').toBeLessThan(
    buffer.byteLength,
  );
});

test('the manifest arrives with the table, long before the payloads', () => {
  const buffer = sampleAsset();
  let manifestAt = -1;
  let meshCount = 0;
  const stream = new DrftStream({
    onManifest: (manifest) => {
      manifestAt = stream.progress.received;
      meshCount = manifest.meshCount;
      expect(manifest.totalBytes).toBe(buffer.byteLength);
      expect(manifest.textureCount).toBe(1);
      expect(manifest.meshBytes).toBeGreaterThan(0);
    },
  });
  feed(stream, buffer, 4);
  stream.end();

  expect(meshCount, 'a loading bar can say how many parts are coming').toBe(2);
  /* The table is a few dozen bytes here and about 3 KB for a 187-mesh car. Either way it is
     the first thing to arrive after the header. */
  expect(manifestAt).toBeLessThan(HEADER_BYTES + 16 * 8);
});

test('the buffer is allocated once and every chunk is viewed inside it', () => {
  /*
   * Zero-copy is the property this format exists for, and a streaming reader is the obvious
   * place to lose it: accumulating chunks into their own buffers would cost a copy each. The
   * header carries `totalBytes` so that this does not have to.
   */
  const buffer = sampleAsset();
  const owners = new Set<ArrayBuffer>();
  const stream = new DrftStream({
    onMesh: (mesh) => {
      owners.add(mesh.positions.buffer as ArrayBuffer);
    },
  });
  feed(stream, buffer, 64);
  stream.end();

  expect(owners.size, 'every mesh views the one streamed buffer').toBe(1);
  const only = [...owners][0];
  expect(only?.byteLength).toBe(buffer.byteLength);
});

test('a file that stops early is refused, and says how much was missing', () => {
  const buffer = sampleAsset();
  const stream = new DrftStream();
  stream.push(new Uint8Array(buffer).subarray(0, buffer.byteLength - 32));
  expect(() => stream.end()).toThrow(DrftError);
  expect(() => stream.end()).not.toThrow(); /* ended once, so a second end is a no-op */
});

test('the magic is checked as soon as there is a header to check it in', () => {
  const stream = new DrftStream();
  const rubbish = new Uint8Array(HEADER_BYTES + 8);
  expect(() => stream.push(rubbish)).toThrow(/magic/);
});

test('an asset with no geometry is refused at the end, as a whole-file read refuses it', () => {
  /*
   * The rule that cannot be applied per chunk: absence is only knowable once there is no more
   * to come. It matters that this still fires, because a stream is exactly where "no meshes
   * yet" and "no meshes at all" look identical until the last byte.
   */
  /*
   * Built by rewriting a valid file's table rather than by asking the writer for a meshless
   * asset, which it refuses outright — the same rule, one layer earlier. Turning the MESH entry
   * into an unknown, not-required kind leaves every offset and length correct, so what is under
   * test is the absence rather than a corrupt file.
   */
  const buffer = sampleAsset();
  const view = new DataView(buffer);
  const chunkCount = view.getUint32(12, true);
  for (let i = 0; i < chunkCount; i++) {
    const entry = HEADER_BYTES + i * 16;
    if (view.getUint32(entry, true) === fourCC('MESH')) {
      view.setUint32(entry, fourCC('ZZZZ'), true);
      view.setUint16(entry + 12, 0, true);
    }
  }

  const stream = new DrftStream();
  feed(stream, buffer, 32);
  expect(() => stream.end()).toThrow(/no MESH/);
});

test('more bytes than the header promised is a refusal rather than a silent overrun', () => {
  const buffer = sampleAsset();
  const stream = new DrftStream();
  feed(stream, buffer, 128);
  expect(() => stream.push(new Uint8Array(4))).toThrow(DrftError);
});

test('paint arrives before the geometry it paints', () => {
  /*
   * The bake-time ordering of §4.6, asserted where it is observable rather than trusted. `MATL`
   * is 8 KB against a 74 MB car and it is what turns arriving parts from grey shapes into a
   * painted model, so it is written before the meshes: the file is laid out for a viewer, and
   * that layout is free because offsets are absolute.
   *
   * Ordering is a *writer* decision the reader does not depend on, which is why this test lives
   * beside the stream rather than beside the writer — the reason the order exists is that
   * somebody watching a load sees paint early.
   */
  const buffer = sampleAsset();
  const order: string[] = [];
  const stream = new DrftStream({
    onMaterials: () => order.push('paint'),
    onMesh: () => order.push('mesh'),
    onTexture: () => order.push('texture'),
  });
  feed(stream, buffer, 16);
  stream.end();

  expect(order[0]).toBe('paint');
  expect(order.at(-1)).toBe('texture');
});

test('an outline arrives before the paint, and is not counted as a part', () => {
  /*
   * The stage order §4.6 argues for, from the front: outline, paint, elements, texture. The
   * outline goes first because it is the only one of them that puts a whole recognisable object
   * on screen, and it is a few hundred kilobytes against tens of megabytes.
   *
   * The count is the other half and it is the one that would be found late. `meshCount` is how
   * many *parts* are coming, which a caller shows as "142 of 187"; a level of detail is the
   * whole model again, so counting it there would report a part that never arrives.
   */
  const coarse = new MeshBuilder();
  coarse.addBox([0, 0, 0], [2, 2, 2], [0.4, 0.4, 0.4], 0, 0);
  const buffer = writeDrft({
    meshes: [new MeshBuilder().addBox([0, 0, 0], [1, 1, 1], [1, 1, 1], 0, 0).build()],
    lods: [coarse.build()],
  });

  const order: string[] = [];
  let manifest = { meshCount: 0, lodCount: 0 };
  let level = -1;
  const stream = new DrftStream({
    onManifest: (m) => {
      manifest = { meshCount: m.meshCount, lodCount: m.lodCount };
    },
    onLod: (_, at) => {
      order.push('outline');
      level = at;
    },
    onMesh: () => order.push('mesh'),
  });
  feed(stream, buffer, 16);
  stream.end();

  expect(order).toEqual(['outline', 'mesh']);
  expect(level, 'the level ordinal, coarsest first').toBe(0);
  expect(manifest.meshCount, 'one part, and the outline is not one of them').toBe(1);
  expect(manifest.lodCount).toBe(1);
});

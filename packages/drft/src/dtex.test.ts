import { describe, expect, test } from 'vitest';
import { ADDRESS_MODE_COUNT, MAX_REGISTERS } from '@driftengine/texture';

import {
  DTEX_ADDRESS_MODES,
  DTEX_MAX_TILES,
  DTEX_REGISTERS,
  buildDtex,
  readDtex,
  type DtexMaterial,
} from './dtex.ts';
import { CHUNK_DTEX, DrftError, KNOWN_CHUNKS, fourCCName } from './drftFormat.ts';
import type { DrftMaterial } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/** The pair a chunk carries, for the cases that are about the texture and not the pairing. */
function entry(texture: DtexMaterial): { material: number; texture: DtexMaterial } {
  return { material: 0, texture };
}

/** A material with two channels, a two-node program, and an 8 by 8 latent cut into four tiles. */
function material(overrides: Partial<DtexMaterial> = {}): DtexMaterial {
  const latent = new Uint8Array(8 * 8 * 2);
  for (let at = 0; at < latent.length; at += 1) latent[at] = (at * 37) & 0xff;
  return {
    latentWidth: 8,
    latentHeight: 8,
    latentComponents: 2,
    channels: Uint32Array.from([(1 << 4) | 0, (4 << 4) | 1]),
    /* SAMPLE_LATENT 0 -> r0, EVAL_NETWORK r0 net0 -> r1. */
    nodes: Uint32Array.from([0, 0, 0, 0, 1, 0, 0, 1]),
    resultRegister: 1,
    addressMode: 0,
    networkInputs: 2,
    networkOutputs: 2,
    hidden: new Uint32Array(0),
    weights: Float32Array.from([0.5, -0.25, 0.75, 0.125, 0.1, 0.2]),
    /* Four tiles of 4 by 4 texels, two components each: the grid an 8 by 8 latent cuts into. */
    tileOffset: Uint32Array.from([0, 32, 64, 96]),
    tileLength: Uint32Array.from([32, 32, 32, 32]),
    tileHash: Uint32Array.from([
      0xdeadbeef, 0x01020304, 0xfeedface, 0x05060708, 0x0a0b0c0d, 0x090a0b0c, 0x11223344,
      0x55667788,
    ]),
    tileSize: 4,
    latent,
    ...overrides,
  };
}

/** Through the chunk and back, as the texture alone — which is what most of these ask about. */
function roundTrip(source: DtexMaterial, material = 0): DtexMaterial {
  return roundTripEntry({ material, texture: source }).texture;
}

function roundTripEntry(source: { material: number; texture: DtexMaterial }) {
  const bytes = buildDtex(source);
  /* Copied into a fresh buffer at a non-zero offset, because a chunk is read where it lands. */
  const padded = new Uint8Array(bytes.length + 8);
  padded.set(bytes, 8);
  return readDtex(padded.buffer as ArrayBuffer, 8, bytes.length);
}

test('A DTEX CHUNK SAYS WHICH MATERIAL IT DECODES', () => {
  /*
   * **In the chunk rather than in the order the chunks appear**, because a file may carry a decode
   * program for some of its materials and not others — a scene where one surface came from a
   * capture and the rest were authored. A reader pairing by position would hand the wrong material
   * the wrong texture and nothing would fail.
   */
  expect(roundTripEntry({ material: 3, texture: material() }).material).toBe(3);
  expect(roundTripEntry({ material: 0, texture: material() }).material).toBe(0);
  expect(() => buildDtex({ material: -1, texture: material() })).toThrow(/not an index/);
  expect(() => buildDtex({ material: 1.5, texture: material() })).toThrow(/not an index/);
});

describe('a DTEX chunk round-trips', () => {
  test('carries every field back exactly', () => {
    const source = material();
    const back = roundTrip(source);
    expect(back.latentWidth).toBe(source.latentWidth);
    expect(back.latentHeight).toBe(source.latentHeight);
    expect(back.latentComponents).toBe(source.latentComponents);
    expect(back.resultRegister).toBe(source.resultRegister);
    expect(back.addressMode).toBe(source.addressMode);
    expect(back.networkInputs).toBe(source.networkInputs);
    expect(back.networkOutputs).toBe(source.networkOutputs);
    expect([...back.channels]).toEqual([...source.channels]);
    expect([...back.nodes]).toEqual([...source.nodes]);
    expect([...back.weights]).toEqual([...source.weights]);
    expect([...back.tileOffset]).toEqual([...source.tileOffset]);
    expect([...back.tileLength]).toEqual([...source.tileLength]);
    expect([...back.tileHash]).toEqual([...source.tileHash]);
    expect([...back.latent.subarray(0, source.latent.length)]).toEqual([...source.latent]);
  });

  test('carries a hidden layer, so a network is not assumed to be linear', () => {
    const source = material({ hidden: Uint32Array.from([8, 4]), weights: new Float32Array(40) });
    const back = roundTrip(source);
    expect([...back.hidden]).toEqual([8, 4]);
  });

  test('is a view over the buffer rather than a copy of it', () => {
    const source = material();
    const bytes = buildDtex(entry(source));
    const back = readDtex(bytes.buffer as ArrayBuffer, 0, bytes.length);
    expect(back.texture.latent.buffer).toBe(bytes.buffer);
    expect(back.texture.nodes.buffer).toBe(bytes.buffer);
  });
});

describe('a DTEX chunk refuses what it cannot read back', () => {
  test('a truncated chunk', () => {
    const bytes = buildDtex(entry(material()));
    expect(() => readDtex(bytes.buffer as ArrayBuffer, 0, 8)).toThrow(DrftError);
    /* Long enough for the header and short of the tables, which is the interesting truncation. */
    expect(() => readDtex(bytes.buffer as ArrayBuffer, 0, 60)).toThrow(/tables/);
  });

  test('a tile whose bytes run past the payload', () => {
    /*
     * The failure this check exists for: a tile table read back without it hands a consumer a
     * subarray of whatever follows the chunk, which is arbitrary memory shaped like a texture.
     */
    expect(() =>
      buildDtex(entry(material({ tileOffset: Uint32Array.from([0, 32, 64, 120]) }))),
    ).toThrow(/runs past/);
  });

  test('a result register no node writes', () => {
    /* Naming a register nothing writes hands a reader whatever that register happened to hold. */
    expect(() => buildDtex(entry(material({ resultRegister: 7 })))).toThrow(/no node writes it/);
  });

  test('a node writing past the registers there are', () => {
    const nodes = Uint32Array.from([0, 0, 0, 0, 1, 0, 0, DTEX_REGISTERS]);
    expect(() => buildDtex(entry(material({ nodes, resultRegister: DTEX_REGISTERS })))).toThrow(
      /past the/,
    );
  });

  test('a program with no nodes at all', () => {
    expect(() => buildDtex(entry(material({ nodes: new Uint32Array(0) })))).toThrow(/whole nodes/);
  });

  test('a latent payload smaller than the grid it declares', () => {
    /*
     * **Asked of an untiled material**, because with tiles the payload is tile-major and is
     * *meant* to be smaller than the grid — that is what two identical tiles sharing one run
     * means. There the rule that holds is per-tile containment, which the case below asserts.
     */
    const untiled = {
      tileOffset: new Uint32Array(0),
      tileLength: new Uint32Array(0),
      tileHash: new Uint32Array(0),
      tileSize: 0,
    };
    expect(() => buildDtex(entry(material({ ...untiled, latent: new Uint8Array(16) })))).toThrow(
      /smaller than the grid/,
    );
  });

  test('a tile table that is not the grid the header declares', () => {
    /*
     * **The table is addressed by where a tile is**, so its length is the grid's and nothing else.
     * A table of another length is one a reader cannot index by coordinate, which is the whole of
     * what streaming a material tile by tile needs.
     */
    expect(() => buildDtex(entry(material({ tileSize: 8 })))).toThrow(/is 1/);
    expect(() => buildDtex(entry(material({ tileSize: 0 })))).toThrow(/tile edge of 0/);
  });

  test('a latent with no components, or more than a texel has', () => {
    expect(() => buildDtex(entry(material({ latentComponents: 0 })))).toThrow(/one to four/);
    expect(() => buildDtex(entry(material({ latentComponents: 5 })))).toThrow(/one to four/);
  });

  test('a tile table whose columns disagree', () => {
    expect(() =>
      buildDtex(entry(material({ tileLength: Uint32Array.from([32, 32, 32]) }))),
    ).toThrow(/different lengths/);
  });

  test('more tiles than the cap', () => {
    expect(DTEX_MAX_TILES).toBe(1 << 16);
  });
});

describe('the freeze holds because the chunk is additive', () => {
  test('this reader knows the code', () => {
    expect(KNOWN_CHUNKS.has(CHUNK_DTEX)).toBe(true);
    expect(fourCCName(CHUNK_DTEX)).toBe('DTEX');
  });

  test('a reader that does not know it skips it, which is the whole guarantee', () => {
    /*
     * **Rule 2 of `FORMAT.md` §4.4, asserted rather than trusted.** An older reader's known set is
     * this one without `DTEX`; an optional chunk it does not recognise is skipped by its length.
     * The check is on the set rather than on a rebuilt reader because the rule *is* the set: a
     * required chunk missing from it is a refusal, and an optional one is silence.
     */
    const older = new Set([...KNOWN_CHUNKS].filter((code) => code !== CHUNK_DTEX));
    expect(older.has(CHUNK_DTEX)).toBe(false);
    expect(older.size).toBe(KNOWN_CHUNKS.size - 1);
  });
});

describe('the register count is the vocabulary that runs the program', () => {
  test('matches the interpreter, which lives in another package', () => {
    /*
     * **A rule in two packages, guarded rather than trusted.** `@driftengine/drft` has no
     * dependencies and cannot import `MAX_REGISTERS`, so the number is written here too — which is
     * exactly the arrangement `heightfieldShape` has with `Terrain` and `glDepthFunc` with
     * `DEPTH_COMPARE`. A boundary that forbids sharing the code does not forbid sharing a test, and
     * this is the test. It imports the interpreter's own constant through a **devDependency**, so
     * the shipped package still declares nothing and a consumer installing `@driftengine/drft`
     * still installs one package.
     */
    expect(MAX_REGISTERS).toBe(DTEX_REGISTERS);
  });
});

describe('a chunk that was not written by this writer', () => {
  /**
   * The offset of the tile table, from the layout the header documents.
   *
   * **Mirrored in the test on purpose.** `buildDtex` refuses a tile table that runs past the
   * payload, so no chunk this writer produces can reach the reader's own check — and a guard that
   * only a corrupt file can reach is a guard only a corrupt file can test. A third-party writer
   * implements against the documented layout, so the test walks it the same way.
   */
  function tileTableAt(bytes: Uint8Array): number {
    const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    /* Word 0 is the material, so every field below it is one word further on than a reader
       of the first version of this layout would look. */
    const channelCount = view.getUint32(16, true);
    const nodeCount = view.getUint32(20, true);
    const hiddenCount = view.getUint32(40, true);
    return 56 + hiddenCount * 4 + channelCount * 4 + nodeCount * 16;
  }

  test('a tile running past the payload is refused on the way in', () => {
    const bytes = buildDtex(entry(material()));
    const view = new DataView(bytes.buffer as ArrayBuffer);
    const table = tileTableAt(bytes);
    /* The third tile's offset, pushed past the end of the latent payload. */
    view.setUint32(table + 8, 100000, true);
    expect(() => readDtex(bytes.buffer as ArrayBuffer, 0, bytes.length)).toThrow(/runs past/);
  });

  test('a result register no node writes is refused on the way in', () => {
    const bytes = buildDtex(entry(material()));
    new DataView(bytes.buffer as ArrayBuffer).setUint32(24, 9, true);
    expect(() => readDtex(bytes.buffer as ArrayBuffer, 0, bytes.length)).toThrow(
      /no node writes it/,
    );
  });

  test('a latent payload smaller than the grid is refused on the way in', () => {
    /*
     * A grid far larger than the payload behind it: the width, at word 1. **With no tiles**, since
     * with them the payload is tile-major and deliberately smaller than the grid — a deduplicated
     * material is one whose tiles repeat, and refusing that would refuse the point of the table.
     */
    const bare = buildDtex(
      entry(
        material({
          tileOffset: new Uint32Array(0),
          tileLength: new Uint32Array(0),
          tileHash: new Uint32Array(0),
          tileSize: 0,
        }),
      ),
    );
    new DataView(bare.buffer as ArrayBuffer).setUint32(4, 4096, true);
    expect(() => readDtex(bare.buffer as ArrayBuffer, 0, bare.length)).toThrow(
      /smaller than the grid/,
    );
  });

  test('a node writing past the registers there are is refused on the way in', () => {
    const bytes = buildDtex(entry(material()));
    const view = new DataView(bytes.buffer as ArrayBuffer);
    const table = tileTableAt(bytes);
    /* The second node's `out` word, four words into the node table. */
    const nodes = table - view.getUint32(20, true) * 16;
    view.setUint32(nodes + 7 * 4, 64, true);
    expect(() => readDtex(bytes.buffer as ArrayBuffer, 0, bytes.length)).toThrow(/past the/);
  });
});

test('the reader knows every address mode the interpreter does, and refuses the next one', () => {
  for (let mode = 0; mode < ADDRESS_MODE_COUNT; mode += 1) {
    expect(roundTrip(material({ addressMode: mode })).addressMode).toBe(mode);
  }
  const bytes = buildDtex(entry(material({ addressMode: ADDRESS_MODE_COUNT })));
  expect(() => readDtex(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length)).toThrow(
    /address mode 4/,
  );
});

test('the reader knows exactly as many address modes as the interpreter', () => {
  expect(DTEX_ADDRESS_MODES).toBe(ADDRESS_MODE_COUNT);
});

/**
 * **The chunk in a file, rather than on its own.** Everything above tests the payload; these test
 * that it travels — written beside a material, read back paired to it, refused where it names a
 * material the file does not carry, and skipped by a reader that has never heard of it.
 */
describe('a DTEX chunk in a container', () => {
  const MESH: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  const MATERIALS: DrftMaterial[] = ['floor', 'wall'].map((name) => ({
    name,
    color: [1, 1, 1],
    specular: 0.5,
    roughness: 1,
    emissive: 0,
    emissiveColor: [0, 0, 0],
    opacity: 1,
    albedo: -1,
    normalMap: -1,
    ormMap: -1,
    emissiveMap: -1,
    roughnessScale: 1,
    metallicScale: 0,
    occlusionStrength: 1,
    reflectivity: 0.5,
    cutout: 0,
  }));

  test('A MATERIAL’S DECODE PROGRAM SURVIVES THE FILE, TEXEL FOR TEXEL', () => {
    const texture = material();
    const asset = readDrft(
      writeDrft({
        meshes: [MESH, MESH],
        materials: MATERIALS,
        dtex: [{ material: 1, texture }],
      }),
    );
    expect(asset.dtex.length).toBe(1);
    const back = asset.dtex[0] as { material: number; texture: DtexMaterial };
    /* Paired to the material it was written against, and not to the first one. */
    expect(back.material).toBe(1);
    expect(Array.from(back.texture.latent)).toEqual(Array.from(texture.latent));
    expect(Array.from(back.texture.nodes)).toEqual(Array.from(texture.nodes));
    expect(Array.from(back.texture.channels)).toEqual(Array.from(texture.channels));
    expect(Array.from(back.texture.weights)).toEqual(Array.from(texture.weights));
    expect(back.texture.latentWidth).toBe(texture.latentWidth);
    expect(back.texture.addressMode).toBe(texture.addressMode);
    expect(back.texture.resultRegister).toBe(texture.resultRegister);
  });

  test('two materials each keep their own program', () => {
    const first = material();
    const second = material({ addressMode: 2, resultRegister: 1 });
    const asset = readDrft(
      writeDrft({
        meshes: [MESH, MESH],
        materials: MATERIALS,
        dtex: [
          { material: 1, texture: second },
          { material: 0, texture: first },
        ],
      }),
    );
    expect(asset.dtex.length).toBe(2);
    const byMaterial = new Map(asset.dtex.map((entry) => [entry.material, entry.texture]));
    expect(byMaterial.get(0)?.addressMode).toBe(first.addressMode);
    expect(byMaterial.get(1)?.addressMode).toBe(2);
    expect(byMaterial.get(1)?.resultRegister).toBe(1);
  });

  test('a DTEX naming a material the file lacks is refused where the author can still be told', () => {
    expect(() =>
      writeDrft({
        meshes: [MESH, MESH],
        materials: MATERIALS,
        dtex: [{ material: 2, texture: material() }],
      }),
    ).toThrow(/names material 2/);
    /* And a file with no materials at all takes none. */
    expect(() =>
      writeDrft({ meshes: [MESH], dtex: [{ material: 0, texture: material() }] }),
    ).toThrow(/carries 0/);
  });

  test('a reader that has never heard of the chunk skips it and loses only the material', () => {
    /*
     * `DTEX` is optional, so the rule in `FORMAT.md` §4.4 applies: an unknown *optional* chunk is
     * skipped in silence. What stands in for an older reader is the file's own accounting — the
     * mesh and materials arrive whole beside it, which is what such a reader would still get.
     */
    const buffer = writeDrft({
      meshes: [MESH, MESH],
      materials: MATERIALS,
      dtex: [{ material: 0, texture: material() }],
    });
    const asset = readDrft(buffer);
    expect(asset.meshes.length).toBe(2);
    expect(asset.materials.length).toBe(2);
    expect(asset.skipped.length).toBe(0);
    /* The chunk is in the known set, which is what makes skipping it a reader's choice. */
    expect(KNOWN_CHUNKS.has(CHUNK_DTEX)).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';

import { CHUNK_NNET, KNOWN_CHUNKS, fourCCName } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import {
  NNET_ENTRY_BYTES,
  NNET_MAX_HIDDEN,
  NNET_MAX_WIDTH,
  buildNnet,
  nnetWeightCount,
  readNnet,
} from './nnet.ts';

import type { MeshData } from './meshData.ts';
import type { DrftNetwork } from './nnet.ts';

/** A network of the given shape, its weights values no round trip could produce by accident. */
function network(
  role: string,
  inputs: number,
  hidden: readonly number[],
  outputs: number,
  precision: 16 | 32,
): DrftNetwork {
  const count = nnetWeightCount(inputs, hidden, outputs);
  const weights = precision === 32 ? new Float32Array(count) : new Uint16Array(count);
  for (let at = 0; at < count; at++) {
    weights[at] = precision === 32 ? (at % 13) * 0.375 - 2 : (at * 2654435761) % 0x10000;
  }
  return { role, inputs, hidden, outputs, weights };
}

function chunk(...networks: DrftNetwork[]): Uint8Array {
  return buildNnet({ networks });
}

function read(bytes: Uint8Array, byteLength = bytes.byteLength) {
  return readNnet(bytes.buffer as ArrayBuffer, 0, byteLength);
}

function bytesOf(array: Float32Array | Uint16Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

describe('a network survives the container exactly', () => {
  test('every shape and every weight comes back, in either precision', () => {
    /*
     * **Byte for byte, because a weight is not a value a reader may approximate.** A transposed or
     * rounded weight matrix is a network that trained well and infers badly, which is the defect
     * `wave3a`'s plan names as the one the export test exists to catch.
     */
    const sources = [
      network('RCN1', 4, [16, 16], 3, 16),
      network('DCAP', 3, [], 1, 32),
      network('RCN2', 2, [5], 4, 32),
    ];
    const back = read(chunk(...sources)).networks;
    expect(back).toHaveLength(3);
    for (const [at, source] of sources.entries()) {
      const got = back[at] as DrftNetwork;
      expect(got.role).toBe(source.role);
      expect(got.inputs).toBe(source.inputs);
      expect([...got.hidden]).toEqual([...source.hidden]);
      expect(got.outputs).toBe(source.outputs);
      expect(got.weights.constructor).toBe(source.weights.constructor);
      expect(bytesOf(got.weights)).toEqual(bytesOf(source.weights));
    }
  });

  test('a half-precision block of odd length leaves the next block on a four-byte boundary', () => {
    /*
     * An odd number of sixteen-bit weights ends two bytes short of a boundary. Unpadded, the
     * single-precision block after it cannot be viewed at all — a `Float32Array` refuses an offset
     * that is not a multiple of four — and a reader would have to copy every network after it.
     */
    const odd = network('ODD1', 2, [], 1, 16);
    expect(odd.weights.length % 2).toBe(1);
    const after = network('AFT1', 2, [3], 1, 32);
    const bytes = chunk(odd, after);
    const back = read(bytes).networks[1] as DrftNetwork;
    expect(back.weights.byteOffset % 4).toBe(0);
    expect(bytesOf(back.weights)).toEqual(bytesOf(after.weights));
  });

  test('weights are views over the chunk, not copies', () => {
    const bytes = chunk(network('VIEW', 3, [4], 2, 32));
    const back = read(bytes).networks[0] as DrftNetwork;
    expect(back.weights.buffer).toBe(bytes.buffer);
  });

  test('a chunk carrying no network is a chunk carrying no network', () => {
    expect(read(chunk()).networks).toEqual([]);
  });

  test('the deepest network the layout holds comes back whole', () => {
    const deep = network(
      'DEEP',
      1,
      Array.from({ length: NNET_MAX_HIDDEN }, () => 2),
      1,
      16,
    );
    expect([...(read(chunk(deep)).networks[0] as DrftNetwork).hidden]).toHaveLength(
      NNET_MAX_HIDDEN,
    );
  });
});

describe('the weight count is the shape’s', () => {
  test('a layer is its weights row by row and then its biases', () => {
    /* 2 inputs to 3 hidden is 6 + 3; 3 to 1 output is 3 + 1. */
    expect(nnetWeightCount(2, [3], 1)).toBe(13);
    expect(nnetWeightCount(4, [], 2)).toBe(10);
    expect(nnetWeightCount(1, [2, 2], 1)).toBe(2 + 2 + 4 + 2 + 2 + 1);
  });
});

describe('a chunk that was not written by this writer', () => {
  /*
   * **`buildNnet` refuses everything below on the way out**, so these walk the documented layout
   * the way a third-party writer would — the argument `sdfv.test.ts` and `dtex.test.ts` make.
   */
  const at = (entry: number, field: number) => 4 + entry * NNET_ENTRY_BYTES + field;
  const INPUTS = 4;
  const HIDDEN_COUNT = 12;
  const HIDDEN = 16;
  const PRECISION = 48;
  const WEIGHT_COUNT = 52;

  test('A WEIGHT COUNT THAT DISAGREES WITH THE SHAPE IS REFUSED, which is the read that looks fine', () => {
    /*
     * The one corruption that reads as a working file: a network whose weights are all there and
     * whose shape says they are laid out differently. Every weight lands in some layer, the
     * evaluator runs, and the picture is wrong everywhere with nothing in the container saying why.
     */
    const bytes = chunk(network('BADC', 2, [3], 1, 32));
    new DataView(bytes.buffer).setUint32(at(0, HIDDEN), 4, true);
    expect(() => read(bytes)).toThrow(/NNET network 0 .*13 weights.*shape.*17/);
  });

  test('A TRUNCATED CHUNK IS REFUSED RATHER THAN READ SHORT', () => {
    const bytes = chunk(network('TRNC', 2, [3], 1, 32));
    expect(() => read(bytes, bytes.byteLength - 4)).toThrow(/NNET/);
    expect(() => read(bytes, 8)).toThrow(/NNET/);
    expect(() => read(bytes, 2)).toThrow(/NNET/);
  });

  test('a count larger than the chunk could hold is refused before it is trusted', () => {
    const bytes = chunk(network('CNT1', 2, [3], 1, 32));
    new DataView(bytes.buffer).setUint32(0, 0xffffff, true);
    expect(() => read(bytes)).toThrow(/NNET declares 16777215 networks/);
  });

  test('a precision other than sixteen or thirty-two bits is refused', () => {
    const bytes = chunk(network('PREC', 2, [3], 1, 32));
    new DataView(bytes.buffer).setUint32(at(0, PRECISION), 8, true);
    expect(() => read(bytes)).toThrow(/8-bit/);
  });

  test('more hidden layers than the table has room for are refused', () => {
    const bytes = chunk(network('HIDN', 2, [3], 1, 32));
    new DataView(bytes.buffer).setUint32(at(0, HIDDEN_COUNT), NNET_MAX_HIDDEN + 1, true);
    expect(() => read(bytes)).toThrow(/hidden layers/);
  });

  test('a layer with no width is refused, and so is one wider than the cap', () => {
    const empty = chunk(network('ZERO', 2, [3], 1, 32));
    new DataView(empty.buffer).setUint32(at(0, INPUTS), 0, true);
    expect(() => read(empty)).toThrow(/width/);
    const wide = chunk(network('WIDE', 2, [3], 1, 32));
    new DataView(wide.buffer).setUint32(at(0, HIDDEN), NNET_MAX_WIDTH + 1, true);
    expect(() => read(wide)).toThrow(/width/);
  });

  test('a weight block running past the chunk is refused, and says how far', () => {
    const bytes = chunk(network('LONG', 2, [3], 1, 32));
    new DataView(bytes.buffer).setUint32(at(0, WEIGHT_COUNT), 1000, true);
    /* The count now disagrees with the shape too; the shape is checked first, then the length. */
    new DataView(bytes.buffer).setUint32(at(0, HIDDEN_COUNT), 0, true);
    new DataView(bytes.buffer).setUint32(at(0, INPUTS), 499, true);
    new DataView(bytes.buffer).setUint32(at(0, INPUTS + 4), 2, true);
    expect(() => read(bytes)).toThrow(/NNET network 0 .*4000 bytes.*left/);
  });

  test('two networks with one role are refused, because a consumer finds a network by its role', () => {
    const bytes = chunk(network('SAME', 2, [3], 1, 32), network('OTHR', 2, [3], 1, 32));
    bytes.set(bytes.subarray(4, 8), 4 + NNET_ENTRY_BYTES);
    expect(() => read(bytes)).toThrow(/SAME/);
  });
});

describe('what the writer will not write', () => {
  test('weights whose count is not the shape’s', () => {
    const bad = { ...network('BADW', 2, [3], 1, 32), weights: new Float32Array(12) };
    expect(() => chunk(bad)).toThrow(/13/);
  });

  test('a role that is not four printable characters', () => {
    expect(() => chunk(network('TOOLONG', 1, [], 1, 32))).toThrow(/role/);
    expect(() => chunk(network('a bc', 1, [], 1, 32))).toThrow(/role/);
  });

  test('two networks with one role', () => {
    expect(() => chunk(network('TWIN', 1, [], 1, 32), network('TWIN', 2, [], 1, 16))).toThrow(
      /TWIN/,
    );
  });

  test('more hidden layers than the layout holds, or a layer of no width', () => {
    const deep = network(
      'DEEP',
      1,
      Array.from({ length: NNET_MAX_HIDDEN + 1 }, () => 1),
      1,
      32,
    );
    expect(() => chunk(deep)).toThrow(/hidden layers/);
    expect(() => chunk(network('NARR', 1, [0], 1, 32))).toThrow(/width/);
  });
});

describe('the chunk has a route into a file and back out of it', () => {
  const mesh: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };

  test('a whole file carries networks through the writer and the reader', () => {
    const source = network('RCN1', 4, [8], 3, 16);
    const asset = readDrft(writeDrft({ meshes: [mesh], networks: [source] }));
    expect(asset.versionMinor).toBeGreaterThanOrEqual(14);
    expect(asset.networks).toHaveLength(1);
    const back = asset.networks[0] as DrftNetwork;
    expect(back.role).toBe('RCN1');
    expect(bytesOf(back.weights)).toEqual(bytesOf(source.weights));
  });

  test('a file that carries no network says so with an empty list rather than an empty chunk', () => {
    expect(readDrft(writeDrft({ meshes: [mesh] })).networks).toEqual([]);
  });
});

describe('the freeze holds because the chunk is additive', () => {
  test('this reader knows the code', () => {
    expect(KNOWN_CHUNKS.has(CHUNK_NNET)).toBe(true);
    expect(fourCCName(CHUNK_NNET)).toBe('NNET');
  });

  test('the entry table is a fixed stride, so a reader can walk it without parsing a network', () => {
    /* Role, inputs, outputs, hidden count, eight widths, precision, weight count. */
    expect(NNET_ENTRY_BYTES).toBe(56);
    const bytes = chunk(network('ONE1', 2, [3], 1, 32), network('TWO2', 2, [], 1, 16));
    /* 13 weights at four bytes; 3 at two, padded to eight. */
    expect(bytes.byteLength).toBe(4 + 2 * NNET_ENTRY_BYTES + 13 * 4 + 8);
  });
});

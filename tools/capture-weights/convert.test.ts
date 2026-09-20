import { createHash } from 'node:crypto';

import { expect, test } from 'vitest';

import { buildNgrf, readNgrf } from '../../packages/drft/src/index.ts';
import { graphFromStored, roundHalf, type Architecture } from '../../packages/texture/src/index.ts';
import { tensorFloats } from './checkpoint.ts';
import { convert, storedGraph } from './convert.ts';
import { readSafetensors } from './safetensors.ts';

/**
 * A checkpoint becomes a graph the runtime runs, and nothing about it is taken on trust: its hash
 * is checked before a byte is read, and each tensor's bytes are checked against its shape. What a
 * definition may read — every weight it names, at its shape, and nothing left over — is
 * `@driftengine/texture`'s rule, tested there, and applied here through the same function.
 *
 * No test here downloads anything: each file is built in the test, byte by byte, in the format's
 * own layout.
 */

interface Entry {
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly bytes: Uint8Array;
}

/** A safetensors file: an eight-byte header length, the JSON header, then each tensor's bytes. */
function safetensors(tensors: Readonly<Record<string, Entry>>, padding = 0): Uint8Array {
  const header: Record<string, unknown> = { __metadata__: { format: 'pt' } };
  let offset = 0;
  for (const [name, entry] of Object.entries(tensors)) {
    header[name] = {
      dtype: entry.dtype,
      shape: entry.shape,
      data_offsets: [offset, offset + entry.bytes.length],
    };
    offset += entry.bytes.length;
  }
  const json = new TextEncoder().encode(JSON.stringify(header) + ' '.repeat(padding));
  const file = new Uint8Array(8 + json.length + offset);
  new DataView(file.buffer).setBigUint64(0, BigInt(json.length), true);
  file.set(json, 8);
  let at = 8 + json.length;
  for (const entry of Object.values(tensors)) {
    file.set(entry.bytes, at);
    at += entry.bytes.length;
  }
  return file;
}

const f32 = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const u16 = (...bits: number[]): Uint8Array => new Uint8Array(Uint16Array.from(bits).buffer);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/* A multiply, `y = x·wᵀ + b`, over a checkpoint holding `w` and `b`. */
const layer: Architecture = (weights, graph) => {
  graph.node('linear', ['x', weights.read('w', [2, 2]), weights.read('b', [2])], {}, 'y');
  return { inputs: [{ name: 'x', shape: [1, 2] }], outputs: ['y'] };
};

const checkpoint = safetensors({
  w: { dtype: 'F32', shape: [2, 2], bytes: f32(1, 2, 3, 4) },
  b: { dtype: 'F16', shape: [2], bytes: u16(0x3c00, 0xc000) },
});

test('A CHECKPOINT READS AS THE TENSORS IT HOLDS, by name, shape and element type', () => {
  /*
   * One space of padding puts the data at an odd offset, as a header of any length may: nothing
   * assumes the bytes are aligned. BF16 0x3fc0 is the top half of the single 0x3fc00000, 1.5;
   * F16 0x3c00 is 1 and 0xc000 is −2.
   */
  const file = safetensors(
    {
      w: { dtype: 'F32', shape: [2, 2], bytes: f32(1, 2, 3, 4) },
      b: { dtype: 'F16', shape: [2], bytes: u16(0x3c00, 0xc000) },
      g: { dtype: 'BF16', shape: [1], bytes: u16(0x3fc0) },
      steps: { dtype: 'I64', shape: [1], bytes: new Uint8Array(8) },
    },
    1,
  );
  const tensors = readSafetensors(file);
  expect([...tensors.keys()].sort()).toEqual(['b', 'g', 'steps', 'w']);
  expect(tensors.get('w')).toMatchObject({ dtype: 'F32', shape: [2, 2] });
  expect(tensors.get('b')).toMatchObject({ dtype: 'F16', shape: [2] });
  expect(Array.from(tensorFloats('w', tensors.get('w') as never))).toEqual([1, 2, 3, 4]);
  expect(Array.from(tensorFloats('b', tensors.get('b') as never))).toEqual([1, -2]);
  expect(Array.from(tensorFloats('g', tensors.get('g') as never))).toEqual([1.5]);
  expect(() => tensorFloats('steps', tensors.get('steps') as never)).toThrow(/steps.*I64/);
});

test('a tensor whose bytes disagree with its shape is refused by name', () => {
  const file = safetensors({ w: { dtype: 'F32', shape: [2, 3], bytes: f32(1, 2, 3, 4) } });
  expect(() => readSafetensors(file)).toThrow(/"w".*16 bytes.*24/);
});

test('A FILE WHOSE HASH IS NOT THE MANIFEST’S IS REFUSED before any of it is read', () => {
  let read = false;
  const spy: Architecture = (weights, graph) => {
    read = true;
    return layer(weights, graph);
  };
  expect(() => convert(checkpoint, spy, { sha256: '0'.repeat(64), format: 'safetensors' })).toThrow(
    /SHA-256/,
  );
  expect(read).toBe(false);
});

test('a converted graph is the architecture over the checkpoint, and stored at half it reads back rounded', () => {
  const graph = convert(checkpoint, layer, { sha256: sha256(checkpoint), format: 'safetensors' });
  expect(Array.from(graph.tensors.get('w')?.data ?? [])).toEqual([1, 2, 3, 4]);
  expect(Array.from(graph.tensors.get('b')?.data ?? [])).toEqual([1, -2]);
  /* 1/3 is not a half; the reader must hand back the nearest one, not the single it came from. */
  const third = safetensors({
    w: { dtype: 'F32', shape: [2, 2], bytes: f32(1 / 3, 2, 3, 4) },
    b: { dtype: 'F32', shape: [2], bytes: f32(0, 0) },
  });
  const stored = storedGraph(
    convert(third, layer, { sha256: sha256(third), format: 'safetensors' }),
    'TEST',
    'half',
  );
  const bytes = buildNgrf([stored]);
  const [back] = readNgrf(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const graphBack = graphFromStored(back as never);
  expect(graphBack.tensors.get('w')?.data[0]).toBe(roundHalf(Math.fround(1 / 3)));
  expect(graphBack.tensors.get('w')?.data[0]).not.toBe(Math.fround(1 / 3));
});

test('A TENSOR BESIDE THE CHECKPOINT IS READ AS ONE OF ITS OWN, and whole numbers half cannot hold are stored single', () => {
  /*
   * A tokenizer's ids ride beside the weights: 49,406 is not a half, and 2,048 and 3 are. A weight
   * past 2,048 is still a weight, rounded like any other.
   */
  const beside = new Map([
    ['tokenizer.merges', { shape: [2], data: Float32Array.of(49406, 3) }],
    ['small', { shape: [2], data: Float32Array.of(2048, 3) }],
    ['large', { shape: [2], data: Float32Array.of(3000.5, 3) }],
  ]);
  const reading: Architecture = (weights, graph) => {
    weights.read('tokenizer.merges', [2]);
    weights.read('small', [2]);
    weights.read('large', [2]);
    return layer(weights, graph);
  };
  const graph = convert(
    checkpoint,
    reading,
    { sha256: sha256(checkpoint), format: 'safetensors' },
    beside,
  );
  const stored = storedGraph(graph, 'TEST', 'half');
  const held = new Map(stored.tensors.map((tensor) => [tensor.name, tensor.data]));
  expect(held.get('tokenizer.merges')).toBeInstanceOf(Float32Array);
  expect(Array.from(held.get('tokenizer.merges') ?? [])).toEqual([49406, 3]);
  expect(held.get('small')).toBeInstanceOf(Uint16Array);
  expect(held.get('large')).toBeInstanceOf(Uint16Array);
  expect(held.get('w')).toBeInstanceOf(Uint16Array);
  /* A name the checkpoint holds too is refused rather than silently chosen between. */
  expect(() =>
    convert(
      checkpoint,
      layer,
      { sha256: sha256(checkpoint), format: 'safetensors' },
      new Map([['w', { shape: [2, 2], data: new Float32Array(4) }]]),
    ),
  ).toThrow(/"w" is in the checkpoint and beside it/);
});

import { expect, test } from 'vitest';

import { tensorFloats } from './checkpoint.ts';
import { readPytorch } from './pytorch.ts';

/**
 * **A PyTorch checkpoint is a program, and this reads it as data.** `torch.save` writes a zip whose
 * `data.pkl` is a pickle — a stack machine that may call any function it names — and each tensor's
 * bytes as an entry beside it. The reader interprets only the opcodes a state dictionary uses and
 * only the constructors that rebuild a tensor; a pickle naming anything else is refused by that
 * name, and nothing it names is ever run. That is the property worth a test: a weights file from a
 * mirror, or a revision nobody re-read, is exactly where a pickle that runs a command would be.
 *
 * Each file is assembled here, opcode by opcode and entry by entry, in the layouts the two formats
 * define; nothing is downloaded.
 */

/* ---- A pickle, protocol 2, written one opcode at a time. ---- */

const bytes = (...parts: (number | Uint8Array)[]): number[] =>
  parts.flatMap((part) => (typeof part === 'number' ? [part] : [...part]));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const u32 = (value: number): Uint8Array => new Uint8Array(new Uint32Array([value]).buffer);

const PROTO = 0x80;
const MARK = 0x28;
const STOP = 0x2e;
const TUPLE = 0x74;
const EMPTY_TUPLE = 0x29;
const REDUCE = 0x52;
const SETITEMS = 0x75;
const BINPERSID = 0x51;
const NEWFALSE = 0x89;
const BININT1 = 0x4b;

const unicode = (value: string): number[] => bytes(0x58, u32(text(value).length), text(value));
const global = (module: string, name: string): number[] =>
  bytes(0x63, text(`${module}\n${name}\n`));
const int = (value: number): number[] => [BININT1, value];
const tuple = (...items: number[][]): number[] => [MARK, ...items.flat(), TUPLE];
const orderedDict = (): number[] => [...global('collections', 'OrderedDict'), EMPTY_TUPLE, REDUCE];

/** `_rebuild_tensor_v2(storage, offset, size, stride, False, OrderedDict())`. */
function tensor(
  key: string,
  storage: string,
  count: number,
  offset: number,
  size: readonly number[],
  stride: readonly number[],
): number[] {
  const persistent = tuple(
    unicode('storage'),
    global('torch', storage),
    unicode(key),
    unicode('cpu'),
    int(count),
  );
  return [
    ...global('torch._utils', '_rebuild_tensor_v2'),
    ...tuple(
      [...persistent, BINPERSID],
      int(offset),
      tuple(...size.map(int)),
      tuple(...stride.map(int)),
      [NEWFALSE],
      orderedDict(),
    ),
    REDUCE,
  ];
}

/** A state dictionary: `OrderedDict()` filled by one SETITEMS. */
function stateDict(entries: readonly (readonly [string, number[]])[]): Uint8Array {
  return Uint8Array.from([
    PROTO,
    2,
    ...orderedDict(),
    MARK,
    ...entries.flatMap(([name, value]) => [...unicode(name), ...value]),
    SETITEMS,
    STOP,
  ]);
}

/* ---- A zip of stored entries: local headers, the data, a central directory, its end. ---- */

function zip(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const u16le = (value: number): number[] => [value & 0xff, value >> 8];
  const u32le = (value: number): number[] => [...u32(value)];
  for (const [name, data] of entries) {
    const offset = parts.length;
    const encoded = [...text(name)];
    const sizes = [...u32le(0), ...u32le(data.length), ...u32le(data.length)];
    parts.push(...u32le(0x04034b50), ...u16le(20), ...u16le(0), ...u16le(0), ...u16le(0));
    parts.push(...u16le(0), ...sizes, ...u16le(encoded.length), ...u16le(0), ...encoded, ...data);
    central.push(...u32le(0x02014b50), ...u16le(20), ...u16le(20), ...u16le(0), ...u16le(0));
    central.push(...u16le(0), ...u16le(0), ...sizes, ...u16le(encoded.length), ...u16le(0));
    central.push(...u16le(0), ...u16le(0), ...u16le(0), ...u32le(0), ...u32le(offset), ...encoded);
  }
  const start = parts.length;
  parts.push(...central);
  parts.push(...u32le(0x06054b50), ...u16le(0), ...u16le(0), ...u16le(entries.length));
  parts.push(...u16le(entries.length), ...u32le(central.length), ...u32le(start), ...u16le(0));
  return Uint8Array.from(parts);
}

const floats = (...values: number[]): Uint8Array =>
  new Uint8Array(Float32Array.from(values).buffer);
const halves = (...bits: number[]): Uint8Array => new Uint8Array(Uint16Array.from(bits).buffer);

test('A STATE DICTIONARY READS AS ITS TENSORS, views and all', () => {
  /*
   * `w` is 2×2 over storage 0 as stored. `wt` is the same storage read with its strides swapped —
   * the transpose, [[1, 3], [2, 4]] — which a reader that ignored strides would get wrong. `b` is
   * two halves starting one element into storage 1, [1, −2] out of [7, 1, −2].
   */
  const pickle = stateDict([
    ['w', tensor('0', 'FloatStorage', 4, 0, [2, 2], [2, 1])],
    ['wt', tensor('0', 'FloatStorage', 4, 0, [2, 2], [1, 2])],
    ['b', tensor('1', 'HalfStorage', 3, 1, [2], [1])],
  ]);
  const file = zip([
    ['archive/data.pkl', pickle],
    ['archive/data/0', floats(1, 2, 3, 4)],
    ['archive/data/1', halves(0x4700, 0x3c00, 0xc000)],
    ['archive/version', text('3\n')],
  ]);
  const tensors = readPytorch(file);
  expect([...tensors.keys()]).toEqual(['w', 'wt', 'b']);
  expect(tensors.get('w')).toMatchObject({ dtype: 'F32', shape: [2, 2] });
  expect(Array.from(tensorFloats('w', tensors.get('w') as never))).toEqual([1, 2, 3, 4]);
  expect(Array.from(tensorFloats('wt', tensors.get('wt') as never))).toEqual([1, 3, 2, 4]);
  expect(tensors.get('b')).toMatchObject({ dtype: 'F16', shape: [2] });
  expect(Array.from(tensorFloats('b', tensors.get('b') as never))).toEqual([1, -2]);
});

test('A PICKLE NAMING ANYTHING BUT A TENSOR’S CONSTRUCTORS IS REFUSED BY THAT NAME, and runs nothing', () => {
  /* `os.system('echo owned')`, the shape of every malicious checkpoint. */
  const pickle = Uint8Array.from([
    PROTO,
    2,
    ...global('os', 'system'),
    ...tuple(unicode('echo owned')),
    REDUCE,
    STOP,
  ]);
  expect(() => readPytorch(zip([['archive/data.pkl', pickle]]))).toThrow(/os\.system/);
  const evaluated = Uint8Array.from([
    PROTO,
    2,
    ...global('builtins', 'eval'),
    ...tuple(unicode('1')),
    REDUCE,
    STOP,
  ]);
  expect(() => readPytorch(zip([['archive/data.pkl', evaluated]]))).toThrow(/builtins\.eval/);
  /* Named and never called — a value in the dictionary — is refused as the name is read. */
  const mentioned = Uint8Array.from([
    PROTO,
    2,
    0x7d,
    ...unicode('x'),
    ...global('os', 'system'),
    0x73,
    STOP,
  ]);
  expect(() => readPytorch(zip([['archive/data.pkl', mentioned]]))).toThrow(/os\.system/);
});

test('a compressed entry, which torch never writes, is refused by name rather than misread', () => {
  const file = zip([['archive/data.pkl', stateDict([])]]);
  /* The method field of the local header and the central record, set to deflate. */
  const view = new DataView(file.buffer);
  view.setUint16(8, 8, true);
  const central = file.length - 22 - (46 + 'archive/data.pkl'.length);
  view.setUint16(central + 10, 8, true);
  expect(() => readPytorch(file)).toThrow(/archive\/data\.pkl.*compressed/);
});

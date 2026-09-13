import { expect, test } from 'vitest';
import { findEntry, readZip } from './zip.ts';

/**
 * The zip container, built by hand so the traps can be built in deliberately.
 *
 * A fixture archive would exercise whichever layout one tool happened to write. What these
 * check is the two things that make naive zip readers wrong on real files, and both are
 * constructed here on purpose: an extra field that differs in length between the local header
 * and the central directory, and a trailing archive comment.
 */

interface Built {
  name: string;
  data: number[];
  /** Bytes of extra field in the local header. */
  localExtra?: number;
  /** Bytes of extra field in the central directory. Different on purpose. */
  centralExtra?: number;
  method?: number;
}

const encoder = new TextEncoder();

/** A minimal but specification-shaped archive. */
function buildZip(entries: Built[], comment = ''): ArrayBuffer {
  const local: number[] = [];
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(local.length);
    const name = [...encoder.encode(e.name)];
    const extra = new Array<number>(e.localExtra ?? 0).fill(0);
    const u32 = (v: number): number[] => [
      v & 255,
      (v >> 8) & 255,
      (v >> 16) & 255,
      (v >>> 24) & 255,
    ];
    const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
    local.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(e.method ?? 0),
      ...u32(0),
      ...u32(0),
      ...u32(e.data.length),
      ...u32(e.data.length),
      ...u16(name.length),
      ...u16(extra.length),
      ...name,
      ...extra,
      ...e.data,
    );
  }

  const central: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Built;
    const name = [...encoder.encode(e.name)];
    const extra = new Array<number>(e.centralExtra ?? 0).fill(0);
    const u32 = (v: number): number[] => [
      v & 255,
      (v >> 8) & 255,
      (v >> 16) & 255,
      (v >>> 24) & 255,
    ];
    const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(e.method ?? 0),
      ...u32(0),
      ...u32(0),
      ...u32(e.data.length),
      ...u32(e.data.length),
      ...u16(name.length),
      ...u16(extra.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offsets[i] as number),
      ...name,
      ...extra,
    );
  }

  const tail = [...encoder.encode(comment)];
  const u32 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(tail.length),
    ...tail,
  ];
  return new Uint8Array([...local, ...central, ...end]).buffer;
}

const text = (s: string): number[] => [...encoder.encode(s)];

test('a stored archive reads, which is the whole of what a usdz needs', () => {
  /* usdz requires its entries stored uncompressed so they can be memory mapped, so this
     path must work with no decompressor supplied at all. */
  const zip = readZip(
    buildZip([
      { name: 'model.usda', data: text('#usda 1.0') },
      { name: 'textures/wall.png', data: text('PNG') },
    ]),
  );
  expect(zip.map((e) => e.name)).toEqual(['model.usda', 'textures/wall.png']);
  expect(new TextDecoder().decode(zip[0]?.bytes)).toBe('#usda 1.0');
});

test('the local header has its own extra length, and using the central one reads noise', () => {
  /*
   * The classic zip bug. The extra field is routinely a different length in the two places —
   * a local header carries alignment padding that the directory does not — so computing the
   * payload offset from the central figure lands short and the entry decodes to rubbish.
   */
  const zip = readZip(
    buildZip([{ name: 'a.txt', data: text('correct'), localExtra: 12, centralExtra: 0 }]),
  );
  expect(new TextDecoder().decode(zip[0]?.bytes)).toBe('correct');
});

test('an archive comment does not hide the end record', () => {
  /* The end record is found by searching backwards precisely because a comment of arbitrary
     length may follow it. A reader that assumes it is the last 22 bytes fails here. */
  const zip = readZip(buildZip([{ name: 'a.txt', data: text('hi') }], 'packed by something'));
  expect(new TextDecoder().decode(zip[0]?.bytes)).toBe('hi');
});

test('directories are not files', () => {
  const zip = readZip(
    buildZip([
      { name: 'textures/', data: [] },
      { name: 'textures/wall.png', data: text('PNG') },
    ]),
  );
  expect(zip.map((e) => e.name)).toEqual(['textures/wall.png']);
});

test('deflate is refused by name when no decompressor was supplied, and used when one was', () => {
  const archive = buildZip([{ name: 'a.txt', data: text('xxxx'), method: 8 }]);
  expect(() => readZip(archive)).toThrow(
    /deflate-compressed and this reader was given no decompressor/,
  );

  /* The injected decompressor is handed the payload and the size the directory promised. */
  let sawExpected = -1;
  const zip = readZip(archive, (compressed, expected) => {
    sawExpected = expected;
    void compressed;
    return new Uint8Array(text('expanded'));
  });
  expect(sawExpected).toBe(4);
  expect(new TextDecoder().decode(zip[0]?.bytes)).toBe('expanded');
});

test('an unknown compression method is refused by its number', () => {
  expect(() => readZip(buildZip([{ name: 'a.txt', data: text('x'), method: 99 }]))).toThrow(
    /compression method 99/,
  );
});

test('something that is not a zip is refused as such', () => {
  /* Long enough to clear the length guard, so the refusal comes from the missing signature
     rather than from the size — otherwise this asserts the wrong check. */
  expect(() =>
    readZip(new Uint8Array(text('this is definitely not a zip archive at all')).buffer),
  ).toThrow(/not a zip archive/);
  /* And the short case still has its own message. */
  expect(() => readZip(new Uint8Array(text('tiny')).buffer)).toThrow(
    /shorter than an empty archive/,
  );
});

test('findEntry matches by pattern', () => {
  const zip = readZip(
    buildZip([
      { name: 'assets/model.usda', data: text('#usda 1.0') },
      { name: 'readme.txt', data: text('hello') },
    ]),
  );
  expect(findEntry(zip, /\.usda$/i)?.name).toBe('assets/model.usda');
  expect(findEntry(zip, /\.gltf$/i)).toBeNull();
});

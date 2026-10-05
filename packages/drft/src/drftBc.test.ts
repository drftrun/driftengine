import { expect, it } from 'vitest';

import { readBcPayload, writeBcPayload } from './drftBc.ts';
import { CODEC_BC, codecName } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/** A file needs a mesh; the texture is what is under test. */
const TRIANGLE: MeshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array(9).fill(1),
  emissive: new Float32Array(3),
  indices: new Uint32Array([0, 1, 2]),
};

/** `n` bytes counting up from `from`, so every level is told apart from every other. */
function run(n: number, from: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (from + i) & 0xff;
  return out;
}

/*
 * **The author's blocks and the author's chain, through a bake and back.** An 8x4 BC7 surface: level
 * 0 is two blocks across and one down, 32 bytes; levels 1 (4x2) and 2 (2x1) are a block each, which
 * is what a level smaller than a block still costs. A chain may stop before 1x1 — this one does, at
 * three — and is carried as it stopped.
 */
it('A BC PAYLOAD KEEPS ITS FORMAT, ITS COLOUR SPACE AND EVERY LEVEL THROUGH A BAKE', () => {
  const levels = [run(32, 0), run(16, 100), run(16, 200)];
  const bytes = writeBcPayload({ format: 'bc7', srgb: true, width: 8, height: 4, levels });
  const file = writeDrft({
    meshes: [TRIANGLE],
    textures: [{ name: 'paint', codec: CODEC_BC, width: 8, height: 4, bytes }],
  });
  const texture = readDrft(file).textures[0];
  expect(texture?.codec).toBe(CODEC_BC);
  expect(codecName(CODEC_BC)).toBe('BC');
  const back = readBcPayload(texture?.width ?? 0, texture?.height ?? 0, texture?.bytes ?? bytes);
  expect(back.format).toBe('bc7');
  expect(back.srgb).toBe(true);
  expect([back.width, back.height]).toEqual([8, 4]);
  expect(back.levels.map((level) => Array.from(level))).toEqual(
    levels.map((level) => Array.from(level)),
  );
});

/*
 * Laid out as FORMAT.md states it, so a reader in another language agrees: the block format's
 * number (BC1 to BC7 by their own digit), a flags word whose lowest bit is sRGB, the level count, a
 * reserved zero, then the levels back to back. A 4x4 BC1 surface with two levels is 16 + 8 + 8.
 */
it('writes the header FORMAT.md states, then the levels back to back', () => {
  const bytes = writeBcPayload({
    format: 'bc1',
    srgb: false,
    width: 4,
    height: 4,
    levels: [run(8, 1), run(8, 9)],
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes.length).toBe(32);
  expect([0, 4, 8, 12].map((at) => view.getUint32(at, true))).toEqual([1, 0, 2, 0]);
  expect(Array.from(bytes.subarray(16))).toEqual([...run(8, 1), ...run(8, 9)]);
});

/*
 * **A side that is not a multiple of four rounds up to whole blocks.** 6x6 is two blocks a side at
 * level 0, 2 x 2 x 8 = 32 bytes of BC1; level 1 is 3x3, one block; level 2 is 1x1, one block. A
 * reader that rounded down would take the first level as one block and every level after it from
 * the wrong place.
 */
it('a level whose side is not a multiple of four takes whole blocks', () => {
  const levels = [run(32, 0), run(8, 50), run(8, 90)];
  const bytes = writeBcPayload({ format: 'bc1', srgb: false, width: 6, height: 6, levels });
  expect(bytes.length).toBe(16 + 48);
  const back = readBcPayload(6, 6, bytes);
  expect(back.levels.map((level) => Array.from(level))).toEqual(
    levels.map((level) => Array.from(level)),
  );
});

/*
 * **Refused by name, never decoded as something else.** A block format this reader does not know —
 * 6 is BC6H, which is HDR and a different contract — a chain longer than the image has levels for,
 * and a payload shorter than the levels it declares.
 */
it('refuses a block format it does not know, a chain too long, and a short payload', () => {
  const header = (format: number, levels: number): Uint8Array => {
    const out = new Uint8Array(16 + 8 * levels);
    const view = new DataView(out.buffer);
    view.setUint32(0, format, true);
    view.setUint32(8, levels, true);
    return out;
  };
  expect(() => readBcPayload(4, 4, header(6, 1))).toThrow(/block format 6/);
  /* 4x4 has three levels: 4x4, 2x2, 1x1. */
  expect(() => readBcPayload(4, 4, header(1, 4))).toThrow(/4 levels.*at most 3/);
  expect(() => readBcPayload(4, 4, header(1, 2).subarray(0, 20))).toThrow(/needs 32 bytes/);
  expect(() =>
    writeBcPayload({ format: 'bc1', srgb: false, width: 8, height: 8, levels: [run(8, 0)] }),
  ).toThrow(/level 0 .* 32 bytes/);
});

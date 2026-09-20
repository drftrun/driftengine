import { expect, test } from 'vitest';

import type { GpuDrivenMaterial } from '../backend/webgpu/gpuDrivenPass.ts';
import { DECODE_NO_PROGRAM } from '../shaders/gpudriven/decode.wgsl.ts';
import type { GpuDrivenProgram } from './decodeTables.ts';
import {
  GPU_DRIVEN_MATERIAL_FLOATS,
  MATERIAL_ALPHA_CUTOFF,
  MATERIAL_EMISSIVE_PROGRAM,
  collectPrograms,
  writeMaterialTable,
} from './materialTable.ts';

const PROGRAM = {
  graph: { nodes: new Uint32Array(0), count: 0, result: 0, addressMode: 3 },
  latents: [],
  networks: [],
} as GpuDrivenProgram;
const OTHER = { ...PROGRAM } as GpuDrivenProgram;

function lanes(buffer: ArrayBuffer, material: number) {
  const at = material * GPU_DRIVEN_MATERIAL_FLOATS;
  return {
    f: Array.from(new Float32Array(buffer, at * 4, GPU_DRIVEN_MATERIAL_FLOATS)),
    u: Array.from(new Uint32Array(buffer, at * 4, GPU_DRIVEN_MATERIAL_FLOATS)),
  };
}

test('A MATERIAL WITH NO TEXTURES WRITES THE EIGHT FLOATS IT ALWAYS WROTE, and says it has no programs', () => {
  const plain: GpuDrivenMaterial = {
    tint: [0.5, 0.25, 1],
    emissive: 0.1,
    roughness: 0.3,
    specular: 0.4,
  };
  const { indices } = collectPrograms([plain]);
  const table = writeMaterialTable([plain], indices, 4);
  const { f, u } = lanes(table, 0);
  expect(f.slice(0, 8)).toEqual([
    0.5,
    0.25,
    1,
    Math.fround(0.1),
    Math.fround(0.3),
    Math.fround(0.4),
    0,
    0,
  ]);
  expect(u.slice(8, 12)).toEqual([
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
  ]);
  /* Scales at one and strengths at their SurfaceMaterial defaults, with no normal map to strengthen. */
  expect(f.slice(12, 18)).toEqual([1, 1, 0, 1, 1, 1]);
  expect(table.byteLength).toBe(4 * GPU_DRIVEN_MATERIAL_FLOATS * 4);
});

test('a textured material names its programs and carries its scales', () => {
  const textured: GpuDrivenMaterial = {
    tint: [1, 1, 1],
    emissive: 0,
    textures: {
      baseColour: PROGRAM,
      orm: OTHER,
      uScale: 3,
      vScale: 0.5,
      roughnessScale: 0.8,
      metallicScale: 0.25,
      occlusionStrength: 0.6,
    },
  };
  const { programs, indices } = collectPrograms([textured]);
  expect(programs).toEqual([PROGRAM, OTHER]);
  const { f, u } = lanes(writeMaterialTable([textured], indices, 1), 0);
  expect(u.slice(8, 11)).toEqual([0, DECODE_NO_PROGRAM, 1]);
  expect(f.slice(12, 18)).toEqual([3, 0.5, 0, Math.fround(0.6), Math.fround(0.8), 0.25]);
});

test('A NORMAL MAP IS USED AT FULL STRENGTH UNLESS THE MATERIAL SAYS OTHERWISE', () => {
  /* SurfaceMaterial's rule: binding a map and saying nothing about strength means "use it". */
  const mapped: GpuDrivenMaterial = { tint: [1, 1, 1], emissive: 0, textures: { normal: PROGRAM } };
  const half: GpuDrivenMaterial = {
    tint: [1, 1, 1],
    emissive: 0,
    textures: { normal: PROGRAM, normalStrength: 0.5 },
  };
  const { indices } = collectPrograms([mapped, half]);
  const table = writeMaterialTable([mapped, half], indices, 2);
  expect(lanes(table, 0).f[14]).toBe(1);
  expect(lanes(table, 1).f[14]).toBe(0.5);
});

test('one program shared by two materials is packed once', () => {
  const a: GpuDrivenMaterial = { tint: [1, 1, 1], emissive: 0, textures: { baseColour: PROGRAM } };
  const b: GpuDrivenMaterial = { tint: [1, 0, 0], emissive: 0, textures: { baseColour: PROGRAM } };
  const { programs, indices } = collectPrograms([a, b]);
  expect(programs.length).toBe(1);
  expect(Array.from(indices)).toEqual([
    0,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    0,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
  ]);
});

test('slots past the last material name no program', () => {
  const { u } = lanes(writeMaterialTable([], new Uint32Array(0), 3), 2);
  expect(u.slice(8, 12)).toEqual([
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
  ]);
});

test('ALPHACUTOFF IS PACKED, AND DEFAULTS TO ZERO SO AN OLD MATERIAL IS BYTE-IDENTICAL', () => {
  const indices = new Uint32Array([DECODE_NO_PROGRAM, DECODE_NO_PROGRAM, DECODE_NO_PROGRAM]);
  const without = new Float32Array(
    writeMaterialTable([{ tint: [1, 1, 1], emissive: 0 }], indices, 1),
  );
  const with_ = new Float32Array(
    writeMaterialTable([{ tint: [1, 1, 1], emissive: 0, alphaCutoff: 0.5 }], indices, 1),
  );
  expect(with_[MATERIAL_ALPHA_CUTOFF]).toBe(0.5);
  expect(without[MATERIAL_ALPHA_CUTOFF]).toBe(0);
  /* And every other lane is untouched, which is what "an old material draws what it drew" means. */
  for (let at = 0; at < GPU_DRIVEN_MATERIAL_FLOATS; at += 1) {
    if (at === MATERIAL_ALPHA_CUTOFF) continue;
    expect(with_[at], `lane ${String(at)} moved`).toBe(without[at]);
  }
});

test('THE CUTOFF LANE IS NOT THE ONE THE PROGRAM LOOP RESERVED', () => {
  /*
   * **Lane 11 looked spare and was not.** The loop at the top of `writeMaterialTable` initialises
   * lanes 8 to 11 to `DECODE_NO_PROGRAM` — four program slots, the fourth reserved until the
   * emissive map took it — so a scalar written there would be read back by the shading pass as a
   * program index, naming a program four billion places away. This pins the cutoff to a lane past
   * the programs, and that a material with no emissive map still names none there.
   */
  const indices = new Uint32Array([
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
  ]);
  const table = writeMaterialTable(
    [{ tint: [1, 1, 1], emissive: 0, alphaCutoff: 0.25 }],
    indices,
    1,
  );
  expect(MATERIAL_ALPHA_CUTOFF).toBeGreaterThan(11);
  expect(new Uint32Array(table)[11]).toBe(DECODE_NO_PROGRAM);
});

test('AN EMISSIVE MAP TAKES THE FOURTH PROGRAM SLOT, which is lane 11', () => {
  /*
   * **The forward path has had an emissive map since phase 1.3 and this pipeline had none**, so a
   * surface glowed everywhere its albedo was bright or nowhere: a facade of lit windows could not be
   * said. The slot was already there — the table reserved a fourth program lane and initialised it
   * to none — so the map takes it and the table does not grow.
   */
  const lit: GpuDrivenMaterial = {
    tint: [1, 1, 1],
    emissive: 2,
    textures: { baseColour: PROGRAM, emissive: OTHER },
  };
  const plain: GpuDrivenMaterial = {
    tint: [1, 1, 1],
    emissive: 0,
    textures: { emissive: PROGRAM },
  };
  const { programs, indices } = collectPrograms([lit, plain]);
  expect(programs).toEqual([PROGRAM, OTHER]);
  expect(Array.from(indices)).toEqual([
    0,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    1,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    DECODE_NO_PROGRAM,
    0,
  ]);
  const table = writeMaterialTable([lit, plain], indices, 2);
  expect(lanes(table, 0).u.slice(8, 12)).toEqual([0, DECODE_NO_PROGRAM, DECODE_NO_PROGRAM, 1]);
  expect(lanes(table, 1).u[11]).toBe(0);
  expect(MATERIAL_EMISSIVE_PROGRAM).toBe(11);
});

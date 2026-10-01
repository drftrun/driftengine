import { readFileSync } from 'node:fs';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { DrftMaterial, MeshData } from '@driftengine/drft';
import { readModel } from './readModel.ts';
import type { ModelImport } from './readModel.ts';
import { BlendNeedsBlender } from './blend.ts';
import { BlendData } from './blendData.ts';

/*
 * The fixtures are authored by `scripts/blender/fixtures.py` and each sits beside Blender's own glTF
 * export of it. The expectation is that export: a separate implementation — Blender evaluating its
 * own file — so these compare two readings of one scene rather than this reader with itself.
 */
const FIXTURES = new URL('../../../scripts/fixtures/blend/', import.meta.url);
const decompress = (bytes: Uint8Array, codec: 'gzip' | 'zstd'): Uint8Array =>
  new Uint8Array(codec === 'zstd' ? zstdDecompressSync(bytes) : gunzipSync(bytes));

async function both(name: string): Promise<{ mine: ModelImport; blender: ModelImport }> {
  const read = (file: string): Promise<ModelImport> =>
    readModel({
      name: file,
      bytes: new Uint8Array(readFileSync(new URL(file, FIXTURES))),
      decompress,
      deriveTangents: false,
    });
  return { mine: await read(`${name}.blend`), blender: await read(`${name}.glb`) };
}

/** Every vertex of `a` has one in `b` at its position whose normal and UV agree, within `tolerance`. */
function unmatched(a: readonly MeshData[], b: readonly MeshData[], tolerance: number): number {
  const cell = (x: number): number => Math.floor(x * 1e3);
  const grid = new Map<string, number[][]>();
  for (const mesh of b) {
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const p = [0, 1, 2].map((k) => mesh.positions[i * 3 + k] as number);
      const key = p.map(cell).join(',');
      const entry = [
        ...p,
        ...[0, 1, 2].map((k) => mesh.normals[i * 3 + k] as number),
        mesh.uvs?.[i * 2] ?? 0,
        mesh.uvs?.[i * 2 + 1] ?? 0,
      ];
      grid.set(key, [...(grid.get(key) ?? []), entry]);
    }
  }
  let misses = 0;
  for (const mesh of a) {
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const p = [0, 1, 2].map((k) => mesh.positions[i * 3 + k] as number);
      const n = [0, 1, 2].map((k) => mesh.normals[i * 3 + k] as number);
      const uv = [mesh.uvs?.[i * 2] ?? 0, mesh.uvs?.[i * 2 + 1] ?? 0];
      let hit = false;
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1])
          for (const dz of [-1, 0, 1]) {
            const key = [
              cell(p[0] as number) + dx,
              cell(p[1] as number) + dy,
              cell(p[2] as number) + dz,
            ].join(',');
            for (const q of grid.get(key) ?? []) {
              const near = (from: number, values: number[], limit: number): boolean =>
                values.every((v, k) => Math.abs(v - (q[from + k] as number)) <= limit);
              if (near(0, p, 1e-5) && near(3, n, tolerance) && near(6, uv, 1e-5)) hit = true;
            }
          }
      if (!hit) misses++;
    }
  }
  return misses;
}

function area(meshes: readonly MeshData[]): number {
  let sum = 0;
  for (const { positions: p, indices } of meshes) {
    for (let t = 0; t < indices.length; t += 3) {
      const [i, j, k] = [
        (indices[t] as number) * 3,
        (indices[t + 1] as number) * 3,
        (indices[t + 2] as number) * 3,
      ];
      const u = [0, 1, 2].map((c) => (p[j + c] as number) - (p[i + c] as number));
      const v = [0, 1, 2].map((c) => (p[k + c] as number) - (p[i + c] as number));
      sum +=
        Math.hypot(
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        ) / 2;
    }
  }
  return sum;
}

/** A material with its texture ordinals replaced by the bytes they name, so numbering cannot differ. */
function comparable(material: DrftMaterial, imported: ModelImport): Record<string, unknown> {
  const image = (index: number): number =>
    index < 0 ? -1 : (imported.textures?.[index]?.bytes?.length ?? -2);
  return {
    ...material,
    albedo: image(material.albedo),
    normalMap: image(material.normalMap),
    ormMap: image(material.ormMap),
    emissiveMap: image(material.emissiveMap),
  };
}

describe('the direct .blend reader', () => {
  it.each(['mesh', 'hierarchy', 'normals', 'materials', 'shapes', 'lights'])(
    "A .blend READS AS BLENDER'S OWN EXPORT OF IT: %s",
    async (name) => {
      const { mine, blender } = await both(name);
      expect(mine.meshes.length).toBe(blender.meshes.length);
      /* Same surface, however each side triangulated an ngon. */
      expect(area(mine.meshes)).toBeCloseTo(area(blender.meshes), 4);
      /* Every corner's normal and UV as Blender shades it: float against double, so 2e-4. */
      expect(unmatched(mine.meshes, blender.meshes, 2e-4)).toBe(0);
      expect(unmatched(blender.meshes, mine.meshes, 2e-4)).toBe(0);
      const theirs = new Map(
        (blender.materials ?? []).map((m) => [m.name, comparable(m, blender)]),
      );
      for (const material of mine.materials ?? []) {
        expect(comparable(material, mine)).toEqual(theirs.get(material.name));
      }
      expect(mine.lights?.length ?? 0).toBe(blender.lights?.length ?? 0);
      (mine.lights ?? []).forEach((light, i) => {
        const other = blender.lights?.[i];
        expect(light.kind).toBe(other?.kind);
        expect(light.intensity).toBeCloseTo(other?.intensity ?? 0, 3);
        /* A temperature's colour is computed from Planck's law, within 2% of Blender's table. */
        light.color.forEach((c, k) =>
          expect(Math.abs(c - (other?.color[k] ?? 0))).toBeLessThan(0.02 * Math.max(1, c)),
        );
        light.direction.forEach((d, k) => expect(d).toBeCloseTo(other?.direction[k] ?? 0, 4));
      });
    },
  );

  it('REFUSES A MODIFIER IT CANNOT EVALUATE, BY NAME, AND IGNORES ONE OFF FOR RENDER', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('modifiers.blend', FIXTURES)));
    const error = await readModel({ name: 'modifiers.blend', bytes, decompress }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BlendNeedsBlender);
    const reasons = (error as BlendNeedsBlender).reasons;
    expect(reasons).toEqual([
      '"Subdivided" has a Subsurf modifier ("Subdivision"), which Blender evaluates',
    ]);
  });

  it('A COMPRESSED FILE WITH NO DECOMPRESSOR IS TOLD WHAT TO PASS', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('shapes.blend', FIXTURES)));
    await expect(readModel({ name: 'shapes.blend', bytes })).rejects.toThrow(
      'needs a "decompress"',
    );
  });
});

/**
 * A synthetic file in the container every Blender before 5.0 wrote, so the twelve-byte header is
 * tested in both byte orders and both pointer sizes without a fixture from each era.
 */
function legacyFile(pointer: 4 | 8, little: boolean): Uint8Array {
  const parts: number[] = [];
  const u8 = (...v: number[]): void => void parts.push(...v);
  const text = (s: string): void => u8(...[...s].map((c) => c.charCodeAt(0)));
  const int = (v: number, size: number): void => {
    const b = new Uint8Array(Math.max(4, size));
    if (size === 2) new DataView(b.buffer).setInt16(0, v, little);
    else new DataView(b.buffer).setInt32(0, v, little);
    u8(
      ...(size === 8
        ? little
          ? [...b.slice(0, 4), 0, 0, 0, 0]
          : [0, 0, 0, 0, ...b.slice(0, 4)]
        : b.slice(0, size)),
    );
  };
  const align = (): void => {
    while (parts.length % 4 !== 0) u8(0);
  };
  text(`BLENDER${pointer === 8 ? '-' : '_'}${little ? 'v' : 'V'}279`);
  const block = (
    code: string,
    length: number,
    address: number,
    sdna: number,
    body: () => void,
  ): void => {
    text(code.padEnd(4, '\0'));
    int(length, 4);
    int(address, pointer);
    int(sdna, 4);
    int(1, 4);
    body();
  };
  /* struct Thing { Thing *next; int count; float weight; char name[8]; } */
  const size = pointer + 4 + 4 + 8;
  block('OB', size, 0x1000, 0, () => {
    int(0x2000, pointer);
    int(-7, 4);
    const f = new Uint8Array(4);
    new DataView(f.buffer).setFloat32(0, 2.5, little);
    u8(...f);
    text('crate\0\0\0');
  });
  const dna: number[] = [];
  const saved = parts.splice(0, parts.length);
  text('SDNA');
  text('NAME');
  int(4, 4);
  for (const n of ['*next', 'count', 'weight', 'name[8]']) text(`${n}\0`);
  align();
  text('TYPE');
  int(4, 4);
  for (const n of ['Thing', 'int', 'float', 'char']) text(`${n}\0`);
  align();
  text('TLEN');
  for (const n of [size, 4, 4, 1]) int(n, 2);
  align();
  text('STRC');
  int(1, 4);
  for (const n of [0, 4, 0, 0, 1, 1, 2, 2, 3, 3]) int(n, 2);
  dna.push(...parts.splice(0, parts.length));
  parts.push(...saved);
  block('DNA1', dna.length, 0x3000, 0, () => u8(...dna));
  block('ENDB', 0, 0, 0, () => undefined);
  return Uint8Array.from(parts);
}

describe('the .blend container', () => {
  it.each([
    [8, true],
    [4, true],
    [8, false],
    [4, false],
  ] as const)(
    'THE TWELVE-BYTE HEADER READS WITH %i-BYTE POINTERS, LITTLE ENDIAN %s',
    (pointer, little) => {
      const blend = new BlendData(legacyFile(pointer, little));
      expect(blend.header).toMatchObject({
        pointerSize: pointer,
        littleEndian: little,
        version: 279,
      });
      const [thing] = blend.idsOf('OB');
      expect(thing?.int('count')).toBe(-7);
      expect(thing?.float('weight')).toBe(2.5);
      expect(thing?.string('name')).toBe('crate');
      expect(thing?.ptr('next')).toBe(0x2000n);
    },
  );
});

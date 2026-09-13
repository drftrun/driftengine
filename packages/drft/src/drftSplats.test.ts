import { describe, expect, it } from 'vitest';
import { DRFT_VERSION_MINOR } from './drftFormat.ts';
import type { DrftSplatBlock, DrftSplats } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { DrftStream } from './drftStream.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/** Eight words a splat, which is what `@driftengine/splats` packs. Opaque to this format. */
const WORDS = 8;

/**
 * A capture whose every record says which splat it is, so a reordered file is still readable.
 *
 * The writer lays splats out coarse-first rather than in the caller's order, so a round trip is
 * a *set* comparison and not a sequence one — and a record that names itself is what makes that
 * checkable without depending on the ordering under test.
 */
function capture(count: number, over: Partial<DrftSplats> = {}): DrftSplats {
  const positions = new Float32Array(count * 3);
  const records = new Uint32Array(count * WORDS);
  for (let index = 0; index < count; index++) {
    /* A lattice, so the coarse-first ordering has real spatial structure to work with. */
    positions[index * 3] = index % 8;
    positions[index * 3 + 1] = Math.floor(index / 8) % 8;
    positions[index * 3 + 2] = Math.floor(index / 64);
    for (let word = 0; word < WORDS; word++) records[index * WORDS + word] = index * 100 + word;
  }
  return {
    count,
    positions,
    records,
    wordsPerSplat: WORDS,
    boundsMin: new Float32Array([0, 0, 0]),
    boundsMax: new Float32Array([7, 7, 7]),
    sphericalHarmonics: 45,
    ...over,
  };
}

/** One triangle, for the cases that need a file to also carry geometry. */
function triangle(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

/** Which splat each record came from, recovered from the self-naming payload above. */
function splatsIn(block: DrftSplatBlock): number[] {
  const seen: number[] = [];
  for (let slot = 0; slot < block.count; slot++)
    seen.push((block.records[slot * WORDS] ?? 0) / 100);
  return seen;
}

describe('a capture in the container', () => {
  it('round-trips every splat, and every word of every splat', () => {
    const source = capture(512);
    const asset = readDrft(writeDrft({ meshes: [], splats: source }));

    expect(asset.splats).not.toBeNull();
    const splats = asset.splats as DrftSplatBlock;
    expect(splats.count).toBe(512);
    expect(splats.totalCount).toBe(512);
    expect(splats.wordsPerSplat).toBe(WORDS);
    expect(splats.sphericalHarmonics, 'carried, not read').toBe(45);
    expect(Array.from(splats.boundsMax)).toEqual([7, 7, 7]);

    const seen = splatsIn(splats);
    expect(new Set(seen).size, 'every splat exactly once').toBe(512);
    for (let slot = 0; slot < 512; slot++) {
      const splat = seen[slot] ?? 0;
      for (let word = 0; word < WORDS; word++) {
        expect(splats.records[slot * WORDS + word]).toBe(splat * 100 + word);
      }
    }
  });

  it('opens a file that carries a capture and no geometry at all', () => {
    /*
     * A capture-only asset is an ordinary asset. Refusing it for the absence of a `MESH` — which
     * is what this reader did until 1.5 — would be the container telling a consumer what its
     * scene is allowed to be made of.
     */
    const asset = readDrft(writeDrft({ meshes: [], splats: capture(64) }));
    expect(asset.meshes).toHaveLength(0);
    expect(asset.splats?.count).toBe(64);
  });

  it('still refuses a file that carries neither', () => {
    expect(() => writeDrft({ meshes: [] })).toThrow(/at least one mesh or a capture/);
  });

  it('carries a capture beside geometry without disturbing it', () => {
    const buffer = writeDrft({ meshes: [triangle()], splats: capture(64) });
    const asset = readDrft(buffer);

    expect(asset.meshes).toHaveLength(1);
    expect(asset.meshes[0]?.indices.length).toBe(3);
    expect(asset.splats?.count).toBe(64);
  });

  it('stamps the minor version the chunk arrived in', () => {
    const asset = readDrft(writeDrft({ meshes: [], splats: capture(16) }));
    expect(asset.versionMinor).toBe(DRFT_VERSION_MINOR);
    expect(DRFT_VERSION_MINOR, 'SPLT is a 1.5 chunk').toBeGreaterThanOrEqual(5);
  });

  it('splits a capture into blocks a stream can draw one at a time', () => {
    /*
     * **The property the whole chunk exists for.** One chunk of a million splats completes when
     * its last byte lands and streaming buys nothing; several blocks each complete on their own,
     * and because the writer interleaves them across the capture the first is already a sparse
     * whole. This asserts the split and the arrival; `coarseFirst.test.ts` asserts the spread.
     */
    const source = capture(4000, { blocks: 8 });
    const buffer = writeDrft({ meshes: [], splats: source });

    const arrived: { ordinal: number; count: number; total: number }[] = [];
    let blockCount = 0;
    const stream = new DrftStream({
      onManifest: (manifest) => {
        blockCount = manifest.splatBlockCount;
      },
      onSplats: (block, ordinal) => {
        arrived.push({ ordinal, count: block.count, total: block.totalCount });
      },
    });
    /* Fed in small pieces, so a block completes only when its own last byte lands. */
    const bytes = new Uint8Array(buffer);
    for (let at = 0; at < bytes.length; at += 977) stream.push(bytes.subarray(at, at + 977));
    stream.end();

    expect(blockCount, 'the manifest says how many refinements are coming').toBe(8);
    expect(arrived).toHaveLength(8);
    expect(
      arrived.map((entry) => entry.ordinal),
      "in the writer's order",
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const entry of arrived) {
      expect(entry.total, 'every block knows the whole capture').toBe(4000);
      expect(entry.count).toBe(500);
    }
  });

  it('gives the first block before the last bytes of the file have arrived', () => {
    /*
     * The claim in one assertion: a consumer holding part of the file already has splats to draw.
     * Half the bytes is a deliberately unambitious bar — the payloads sit after the head and the
     * table, so the real figure is better and depends on the block count.
     */
    const buffer = writeDrft({ meshes: [], splats: capture(4000, { blocks: 16 }) });
    const bytes = new Uint8Array(buffer);

    let firstAt = -1;
    let pushed = 0;
    const stream = new DrftStream({
      onSplats: () => {
        if (firstAt === -1) firstAt = pushed;
      },
    });
    for (let at = 0; at < bytes.length; at += 512) {
      const piece = bytes.subarray(at, at + 512);
      pushed += piece.length;
      stream.push(piece);
      if (firstAt !== -1) break;
    }

    expect(firstAt).toBeGreaterThan(0);
    expect(firstAt / bytes.length).toBeLessThan(0.5);
  });

  it('refuses a capture whose records do not cover its splats', () => {
    expect(() =>
      writeDrft({
        meshes: [],
        splats: capture(64, { records: new Uint32Array(10) }),
      }),
    ).toThrow(/need 512 entries/);
  });

  it('refuses a record layout that stores nothing', () => {
    expect(() => writeDrft({ meshes: [], splats: capture(8, { wordsPerSplat: 0 }) })).toThrow(
      /stores nothing/,
    );
  });

  it('writes one block for a capture too small to be worth splitting', () => {
    const asset = readDrft(writeDrft({ meshes: [], splats: capture(12) }));
    expect(asset.splats?.count).toBe(12);
  });
});

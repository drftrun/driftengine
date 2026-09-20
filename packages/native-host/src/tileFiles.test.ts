import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createPageCache,
  createResidencyTable,
  createStreamer,
  pumpStreamer,
  slotFor,
  TILE_RESIDENT,
  tileState,
} from '@driftengine/texture';
import { tileFiles } from './tileFiles.ts';

/**
 * **What this file is for: a texture streaming from disk, with no network.** The texture streamer
 * asks a `TileSource` for a tile by its hash and treats "not there" as a fact to remember, not an
 * error. This host's source is a directory of tiles named by hash, so these tests drive the real
 * streamer over one.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const HERE = '0123456789abcdef';
const GONE = 'fedcba9876543210';

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'drift-tiles-'));
  dirs.push(root);
  const tiles = join(root, 'tiles');
  mkdirSync(tiles);
  writeFileSync(join(tiles, HERE), new Uint8Array([7, 8, 9, 10]));
  const table = createResidencyTable(4);
  const cache = createPageCache(4, 4);
  const streamer = createStreamer(tileFiles(tiles), table, cache);
  return { root, tiles, table, cache, streamer };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('tiles from a directory', () => {
  test('A TILE ON DISK STREAMS IN, its bytes in a page', async () => {
    const { table, cache, streamer } = rig();
    pumpStreamer(streamer, [HERE], 1);
    await settle();
    expect(tileState(table, HERE)).toBe(TILE_RESIDENT);
    const slot = slotFor(table, HERE);
    expect(Array.from(cache.bytes.subarray(slot * 4, slot * 4 + 4))).toEqual([7, 8, 9, 10]);
  });

  test('A TILE THAT IS NOT THERE IS NOTHING, not an error, and is not asked for again', async () => {
    const { streamer } = rig();
    pumpStreamer(streamer, [GONE], 1);
    await settle();
    expect(streamer.missing.has(GONE)).toBe(true);
    expect(streamer.inFlight.size).toBe(0);
  });

  test('A NAME THAT IS NOT A TILE’S HASH NEVER REACHES THE FILESYSTEM', async () => {
    const { root, tiles } = rig();
    /* A real file one directory up, named like a tile, which a path climbing out would find. */
    writeFileSync(join(root, GONE), 'not a tile');
    const source = tileFiles(tiles);
    expect(await source.fetch(`../${GONE}`)).toBeNull();
    expect(await source.fetch(`${HERE}0`)).toBeNull();
    expect(Array.from((await source.fetch(HERE)) ?? [])).toEqual([7, 8, 9, 10]);
    /* And an absent one resolves rather than throwing, which the streamer cannot tell apart. */
    await expect(source.fetch(GONE)).resolves.toBeNull();
  });
});

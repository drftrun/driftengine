/**
 * Texture tiles from a directory on disk: the texture streamer's `TileSource`, with no network.
 *
 * **A tile is a file named by its hash**, the 64-bit FNV-1a `hashTile` gives as sixteen hex
 * characters, which is what the streamer asks for. A name that is anything else is answered
 * `null` before the filesystem is touched, so a hash from a stale or hostile index cannot climb out
 * of the directory.
 *
 * **A file that is not there is `null`, which the streamer remembers as missing** and stops asking
 * for. One that is there and cannot be read is a deployment fault rather than an absence, so it is
 * said, once a tile, and then counted as missing too: the streamer treats a refusal as an absence
 * either way, and a world that never finishes loading with nothing said is what it exists to
 * prevent.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TileSource } from '@driftengine/texture';

const TILE_NAME = /^[0-9a-f]{16}$/;

export function tileFiles(directory: string): TileSource {
  const said = new Set<string>();
  return {
    async fetch(hash: string): Promise<Uint8Array | null> {
      if (!TILE_NAME.test(hash)) return null;
      try {
        return new Uint8Array(await readFile(join(directory, hash)));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' && !said.has(hash)) {
          said.add(hash);
          console.warn(`[driftengine] tile ${hash} is on disk and could not be read:`, cause);
        }
        return null;
      }
    },
  };
}

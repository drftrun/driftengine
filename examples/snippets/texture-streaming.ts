/**
 * Streaming the tiles of DriftTexture materials by where the camera will be: a source over a
 * file's `DTEX` tile tables, the residency it fills, and the loop a frame runs.
 *
 * A snippet, typechecked with the examples and quoted by the manual's texture streaming chapter.
 */
import { dtexTileBytes, tileGridFromDtex } from '@driftengine/assets';
import type { DtexMaterial } from '@driftengine/drft';
import {
  TILE_RESIDENT,
  acquirePage,
  beginCacheFrame,
  createPageCache,
  createPrefetchQueue,
  createResidencyTable,
  createStreamer,
  enqueue,
  pumpStreamer,
  runPrediction,
  setDecodeMode,
  takeBatch,
  tileState,
  tilesForView,
  touchTile,
} from '@driftengine/texture';
import type {
  InstanceTileInfo,
  PageDecode,
  Predictor,
  SimulationHandle,
  TileSource,
} from '@driftengine/texture';

// #region source
/**
 * Where tiles come from: here, the tile tables of a file already read, by content hash. A game
 * streaming over a network answers the same question with a range request.
 */
export function sourceOf(materials: readonly DtexMaterial[]): TileSource {
  const bytes = new Map<string, Uint8Array>();
  for (const material of materials) {
    const grid = tileGridFromDtex(material);
    if (grid === null) continue;
    const across = Math.ceil(grid.width / grid.tileSize);
    grid.levels[0]?.forEach((hash, at) => {
      const tile = dtexTileBytes(material, at % across, Math.floor(at / across));
      if (tile !== null) bytes.set(hash, tile);
    });
  }
  return { fetch: (hash) => Promise.resolve(bytes.get(hash) ?? null) };
}
// #endregion

// #region residency
/** What is resident, the pages holding it, what is wanted next, and the fetches in flight. */
const TILE_BYTES = 4096;
const table = createResidencyTable(4096);
const cache = createPageCache(256, TILE_BYTES);
const queue = createPrefetchQueue(2048);

export function residency(source: TileSource): ReturnType<typeof createStreamer> {
  return createStreamer(source, table, cache, { maxInFlight: 64 });
}
// #endregion

// #region frame
/** What a predicted view would sample, and how to ask for what is missing. */
export function predictorFor(scene: InstanceTileInfo, projection: Float32Array): Predictor<string> {
  return {
    needs: (view, out, budget) => tilesForView(view, projection, scene, out, budget),
    resident: (hash) => tileState(table, hash) === TILE_RESIDENT,
    request: (hash, priority) => enqueue(queue, hash, priority),
  };
}

const batch: string[] = [];

/**
 * One frame: protect what this frame samples, look six steps ahead, send the most urgent fetches
 * a 256 KB budget allows, and mark what is drawn as in use.
 */
export function streamFrame(
  streamer: ReturnType<typeof createStreamer>,
  simulation: SimulationHandle,
  predictor: Predictor<string>,
  sampled: readonly string[],
): void {
  beginCacheFrame(cache);
  runPrediction(simulation, predictor, 6, 1 / 60, 512);
  const taken = takeBatch(
    queue,
    (hash) => tileState(table, hash) === TILE_RESIDENT,
    256 * 1024,
    TILE_BYTES,
    batch,
  );
  pumpStreamer(streamer, batch, taken);
  for (const hash of sampled) {
    if (tileState(table, hash) !== TILE_RESIDENT) continue;
    acquirePage(cache, hash);
    touchTile(table, hash);
  }
}
// #endregion

// #region decode
/** A cache that decodes each tile once, as it becomes resident, to be sampled as a plain texture. */
export function decodingCache(decode: PageDecode): ReturnType<typeof createPageCache> {
  return createPageCache(256, TILE_BYTES, { mode: 'on-residency', decode });
}

/** Back to decoding per sample, at run time. Every page decoded under the old rule is invalidated. */
export function decodePerSample(): void {
  setDecodeMode(cache, 'per-sample');
}
// #endregion

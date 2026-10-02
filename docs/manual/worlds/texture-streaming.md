---
title: Texture streaming
description: Deciding which tiles of a texture are resident by running the simulation ahead to see where the camera will be, and giving up on tiles that will not come.
packages: ['@driftengine/texture', '@driftengine/assets']
covers: ['Predictive texture streaming', 'Mispredicting', 'Streaming that gives up', 'The decode-time switch']
---

# Texture streaming

A world's textures do not fit in memory at once, so tiles of them are fetched as they are needed
and dropped when they are not. A streamer that waits until a frame has sampled a missing tile
asks for it two or three frames late, and the tile pops in. DriftEngine can run its simulation
forward and put it back exactly, which it already does for networking, so residency is decided by
where the camera **will** be: the simulation is saved, advanced a few deterministic steps without
rendering, asked which tiles those views would sample, and restored.

`@driftengine/texture` holds the residency: a table of what is resident, a queue of what is wanted,
a cache of pages and a streamer of fetches, all on the CPU. It decides what is in memory and when;
moving a page to wherever a renderer samples it is the caller's.
[Large worlds](large-worlds.md) streams cells of a world through the same prediction.

## Where tiles come from

A tile is addressed by a content hash, so a tile two materials share is one address and one fetch.
`latentTileGrid(image, tileSize, addressMode)` cuts a latent and its mips into hashed tiles, level by
level, which is what a baker has; `tileGridFromDtex(material)` reads the same grid from a
[`DTEX`](drifttexture.md) chunk's tile table, which is what a game loading a file has, and
`dtexTileBytes(material, tx, ty)` gives one tile's bytes. The two hash different things, decoded
texels against stored bytes, so a game keeps to one of them.

```ts sample=snippets/texture-streaming.ts#source
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
```

A `TileSource` is one method, `fetch(hash)`, returning a promise of the tile's bytes or `null`
where the source does not have it. What sits behind it, a file already read, a range request or a
cache, is the caller's.

## The residency

```ts sample=snippets/texture-streaming.ts#residency
/** What is resident, the pages holding it, what is wanted next, and the fetches in flight. */
const TILE_BYTES = 4096;
const table = createResidencyTable(4096);
const cache = createPageCache(256, TILE_BYTES);
const queue = createPrefetchQueue(2048);

export function residency(source: TileSource): ReturnType<typeof createStreamer> {
  return createStreamer(source, table, cache, { maxInFlight: 64 });
}
```

- `createResidencyTable(capacity)` records each tile as `TILE_ABSENT`, `TILE_REQUESTED` or
  `TILE_RESIDENT`. `tileState`, `markRequested`, `markResident`, `evict`, `slotFor` and
  `residentCount` read and change it, `touchTile` stamps a tile as used this frame, and
  `leastRecentlyUsed` lists resident tiles oldest first, never one touched since the frame began.
- `createPageCache(pages, pageBytes, options)` holds the bytes. A page acquired this frame is never
  evicted: a cache with nothing else to give refuses with `-1` from `acquirePage`, because a frame
  drawn against bytes being overwritten is a corruption, not a stall. `pageSlot`, `pageDecoded`,
  `releasePage` and `occupiedPages` read it, and `takeEvicted` drains what it gave up.
- `createPrefetchQueue(capacity)` holds what is wanted by priority, lower first. `enqueue` adds or
  raises a tile, `queueSize` says how many wait, and `takeBatch(queue, isResident, bytesBudget,
tileBytes, out)` takes the most urgent that fit a byte budget, checking residency at the moment
  of taking, since a tile asked for frames ago may have arrived.
- `createStreamer(source, table, cache, { maxInFlight })` sends fetches. `pumpStreamer(streamer,
batch, count)` starts them and returns at once, never awaiting, and skips anything resident, in
  flight or known missing, so calling it every frame with the same batch is correct.
  `streamerInFlight` counts what is outstanding.

## A frame

```ts sample=snippets/texture-streaming.ts#frame
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
```

Each frame:

1. `beginCacheFrame(cache)`, so everything acquired from here on is protected.
2. `runPrediction(simulation, predictor, frames, dt, budget)` runs the simulation ahead, as
   [Large worlds](large-worlds.md) describes for cells, and requests what each predicted view needs,
   nearer frames first and at most `budget` tiles in all.
3. `takeBatch` and `pumpStreamer` send the most urgent fetches.
4. For every tile the frame samples, `acquirePage` and `touchTile`, so it is in use and recent.

`tilesForView(view, projection, scene, out, budget)` is what a predicted view needs: for each
instance whose bounding sphere is in view, the mip level its nearest point asks for, the finer level
too within an eighth of a level of a boundary (`LEVEL_MARGIN`), and every coarser level a sampler
falls back to, over the span of texture coordinates it shows. The answer is ordered by the screen
each tile covers, so at any budget it is a prefix of the answer with none. `InstanceTileInfo`
describes the scene it reads: each instance's bounding sphere, its texture coordinate span, how
many metres one unit of texture coordinate covers on it, which material it wears, each material's
tile grids, and the size of the target in pixels, since the level a sampler picks is texels a pixel.
`predictViews` is the save, advance and restore underneath, for a caller that wants the views
themselves.

### What it buys

The engine's own gate flies a scripted path down a corridor of real latents: 452 tiles through a
256-page cache, never more than 102 sampled in a frame. Predicting, 296 samples are late; reacting,
1,294 are. The 296 are exactly the three frames before the first fetch could possibly have landed.

When prediction is wrong it costs a wasted fetch and a tile as late as it would have been without
it. A camera reversing every three frames is the case prediction cannot help, and on that flight
it is 102 late samples predicted against 755 reacting; the picture converges once the camera
settles.

## Giving up

A fetch that resolves with nothing, a tile the container lacks, a name from a stale index, a
refused range, would leave the tile requested and its in-flight slot taken for ever, and a handful
of those stop streaming with no error anywhere. So the streamer remembers a missing tile as
missing and does not ask again, treats a rejected fetch the same way, refuses bytes larger than a
page instead of truncating them, and drops a fetch that lands after its tile was evicted, counting
those in `oversize` and `stale`. A fetch that lands with no page free is counted in `deferred`, and
the tile stays absent to be asked for again. `forgetMissing(streamer, hash)` and
`clearMissing(streamer)` ask again, for a game that has mounted a different container.

## When the decode happens

```ts sample=snippets/texture-streaming.ts#decode
/** A cache that decodes each tile once, as it becomes resident, to be sampled as a plain texture. */
export function decodingCache(decode: PageDecode): ReturnType<typeof createPageCache> {
  return createPageCache(256, TILE_BYTES, { mode: 'on-residency', decode });
}

/** Back to decoding per sample, at run time. Every page decoded under the old rule is invalidated. */
export function decodePerSample(): void {
  setDecodeMode(cache, 'per-sample');
}
```

A DriftTexture is decoded per sample by default. If that proves too slow for some material, the
cache can decode each tile once, when it becomes resident, and the renderer samples it as an
ordinary texture after: `mode: 'on-residency'` with a `PageDecode` function, and
`ensurePageDecoded(cache, hash)` to run it. That keeps the compression, the joint channels and the
streaming, and loses procedural and per-sample variation for the materials it is used on.
`setDecodeMode` switches at run time and invalidates every page decoded under the old rule, since
the two modes hold different bytes; `decodeMode` says which is in force.

`progressiveOrder(tileCount, out)` gives an order to send a material's tiles in, every tile once,
and `usableAt` says which level the bytes received so far support, rising and never going back, so a
loader shows something at once and refines it.

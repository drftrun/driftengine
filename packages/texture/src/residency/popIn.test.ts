/**
 * Every tile a frame sampled was already resident when that frame began.
 *
 * **That is the design's exact claim, and it is far more testable than "no visible pop-in".** A
 * scripted flight down a corridor of textured panels whose tiles exceed the page cache, with
 * prediction on, and nothing is late. The same flight with prediction off, and things are late —
 * which is what proves the mechanism is doing something rather than the flight being too easy.
 *
 * **And a third flight that mispredicts on purpose.** A camera reversing every few frames is the
 * case prediction cannot help with, and what the design promises there is *degradation, not
 * failure*: tiles arrive late, exactly as they would in a reactive engine, and nothing is wrong.
 * The floor of this mechanism is everyone else's ceiling, and that sentence is worth a test.
 *
 * **What a frame samples is `tilesForView`'s answer for that frame's view**, over a scene of real
 * latents cut by `latentTileGrid` — the same function prediction asks of the views it has not
 * drawn. Until 2026-09-17 this gate stood in a hand-written square of tile names around the
 * camera, which proved the queue, the cache and the streamer and said nothing about a scene.
 */
import { describe, expect, it } from 'vitest';
import { ADDRESS_MODE } from '../decodeGraph.ts';
import type { LatentImage } from '../decodeCpu.ts';
import { TILE_RESIDENT, createResidencyTable, tileState, touchTile } from './table.ts';
import { createPrefetchQueue, enqueue, takeBatch } from './queue.ts';
import { acquirePage, beginCacheFrame, createPageCache } from './pageCache.ts';
import { createStreamer, pumpStreamer, type TileSource } from './stream.ts';
import { runPrediction, type Predictor } from './predictor.ts';
import { latentTileGrid, tilesForView, type InstanceTileInfo } from './viewTiles.ts';
import type { SimulationHandle } from './predict.ts';

/** Frames between asking for a tile and its bytes arriving. Prediction has to beat this. */
const LATENCY = 3;
const HORIZON = 6;
const PAGES = 256;
/** World units the camera moves a frame. */
const SPEED = 2;

/**
 * The corridor: a panel on each wall every four units, each showing one of sixty-four materials,
 * each material a 32-texel latent with its whole chain, cut into 16-texel tiles — four at level 0
 * and one at each of the five levels above, nine a material and 576 in all.
 *
 * **Sized so that a late tile is a prediction failure and never a capacity one**: the widest frame
 * samples 102 tiles of the cache's 256, and the straight flight samples 452 distinct tiles, so the
 * cache is exceeded over the flight and never within a frame. The first sizing sampled 320 a frame
 * through 256 pages — more than the cache holds at once — and prediction came out *later* than
 * reacting, 3,675 samples against 3,313; through 1,024 pages the same flight was late for its
 * warm-up alone, 944 against 1,680. Prefetching into a cache smaller than a frame is a real cost,
 * and it is not what this gate measures.
 */
const MATERIALS = 64;
const LATENT = 32;
const TILE_TEXELS = 16;
const STATION = 4;
const FIRST_STATION = -30;
const STATIONS = 80;
const WALL = 4;
const EYE_HEIGHT = 1.5;
const TARGET_WIDTH = 80;
const TARGET_HEIGHT = 45;

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/** Sixty degrees high, twenty-four units deep. */
const PROJ = perspective(Math.PI / 3, TARGET_WIDTH / TARGET_HEIGHT, 0.1, 24);

/** A material's latent, every texel of every level its own value. */
function latent(material: number): LatentImage {
  const level = (edge: number, depth: number) => ({
    width: edge,
    height: edge,
    data: Float32Array.from(
      { length: edge * edge },
      (_, i) => material * 100_000 + depth * 10_000 + i,
    ),
  });
  const mips = [];
  for (let depth = 1; LATENT >> depth >= 1; depth += 1) mips.push(level(LATENT >> depth, depth));
  return { ...level(LATENT, 0), channels: 1, mips };
}

function corridor(): InstanceTileInfo {
  const count = STATIONS * 2;
  const spheres = new Float32Array(count * 4);
  const uvs = new Float32Array(count * 4);
  const worldPerUv = new Float32Array(count);
  const material = new Uint32Array(count);
  for (let station = 0; station < STATIONS; station += 1) {
    for (let side = 0; side < 2; side += 1) {
      const i = station * 2 + side;
      const x = (FIRST_STATION + station) * STATION;
      /* A four-unit square panel standing on a wall: its bounds are its half-diagonal. */
      spheres.set([x, EYE_HEIGHT, side === 0 ? -WALL : WALL, Math.SQRT2 * 2], i * 4);
      uvs.set([0, 0, 1, 1], i * 4);
      worldPerUv[i] = STATION;
      material[i] = (station * 7 + side * 11) % MATERIALS;
    }
  }
  return {
    count,
    spheres,
    uvs,
    worldPerUv,
    material,
    materials: Array.from({ length: MATERIALS }, (_, m) => [
      latentTileGrid(latent(m), TILE_TEXELS, ADDRESS_MODE.CENTRE_WRAP),
    ]),
    targetWidth: TARGET_WIDTH,
    targetHeight: TARGET_HEIGHT,
  };
}

const SCENE = corridor();

/** Where the camera is along the corridor on a given frame. Each flight is one of these. */
type Path = (frame: number) => number;

const straight: Path = (frame) => frame * SPEED;
/**
 * Reverses every three frames until frame 30, then holds still.
 *
 * **The holding is not a convenience; it is what "converges" means.** A flight that ends mid-jump
 * has nothing left to converge in — its last frame asked for tiles that are still in the air, and
 * there is no frame after it for them to land in. The first version of this test asserted that
 * everything had arrived at the end of a flight that was still moving, which is a claim about
 * latency being zero rather than about the mechanism.
 */
const erratic: Path = (frame) => {
  const at = Math.min(frame, 30);
  return (Math.floor(at / 3) % 2 === 0 ? at : -at) * SPEED;
};

/**
 * The view of a camera at `x` along the corridor, looking down it.
 *
 * **Turned, not the identity**: the camera looks along +x, so its view matrix has a rotation in
 * it and a view read as a bare translation would be looking at the wall.
 */
function viewAt(x: number, out: Float32Array): void {
  out.fill(0);
  out[8] = 1;
  out[5] = 1;
  out[2] = -1;
  out[13] = -EYE_HEIGHT;
  out[14] = x;
  out[15] = 1;
}

/** What a frame at `x` samples. */
const VIEW = new Float32Array(16);
function sampledAt(x: number, out: string[]): number {
  viewAt(x, VIEW);
  return tilesForView(VIEW, PROJ, SCENE, out, 1 << 20);
}

interface Flight {
  /** Samples of a tile that was not resident when its frame began. */
  late: number;
  /** Every distinct tile the flight ever sampled. */
  seen: Set<string>;
  /** The most tiles one frame sampled. */
  widest: number;
  /** Tiles that were still not resident at the end of the flight. */
  neverArrived: string[];
  /** Frames on which the cache had no page for a sampled tile. */
  starved: number;
}

/**
 * Fly the path for `frames`, with prediction on or off, and report what was late.
 *
 * The loop is the one a real frame would run: begin the frame, predict (or react), pump the
 * streamer, land whatever is due, then sample.
 */
async function fly(path: Path, frames: number, options: { predict: boolean }): Promise<Flight> {
  const table = createResidencyTable(4096);
  const cache = createPageCache(PAGES, 4);
  const queue = createPrefetchQueue(2048);

  /* A source with a fixed latency in frames: a tile asked for on frame `f` lands on `f + LATENCY`,
     which is what makes prediction worth anything. Zero latency would pass either way. */
  let now = 0;
  const due: { hash: string; at: number; settle: (bytes: Uint8Array | null) => void }[] = [];
  const source: TileSource = {
    fetch: (hash: string): Promise<Uint8Array | null> =>
      new Promise<Uint8Array | null>((resolve) => {
        due.push({ hash, at: now + LATENCY, settle: resolve });
      }),
  };
  const streamer = createStreamer(source, table, cache, { maxInFlight: 512 });

  const world = { frame: 0 };
  let saved = 0;
  const sim: SimulationHandle = {
    save: (): void => {
      saved = world.frame;
    },
    restore: (): void => {
      world.frame = saved;
    },
    advance: (): void => {
      world.frame += 1;
    },
    viewAt: (out: Float32Array): void => {
      viewAt(path(world.frame), out);
    },
  };

  const predictor: Predictor<string> = {
    needs: (view: Float32Array, out: string[], budget: number): number =>
      tilesForView(view, PROJ, SCENE, out, budget),
    resident: (hash: string): boolean => tileState(table, hash) === TILE_RESIDENT,
    request: (hash: string, priority: number): void => {
      enqueue(queue, hash, priority);
    },
  };

  const flight: Flight = {
    late: 0,
    seen: new Set<string>(),
    widest: 0,
    neverArrived: [],
    starved: 0,
  };
  const wanted: string[] = [];
  const batch: string[] = [];

  for (world.frame = 0; world.frame < frames; world.frame += 1) {
    now = world.frame;
    beginCacheFrame(cache);

    /* Everything whose latency has elapsed arrives now. */
    for (let at = due.length - 1; at >= 0; at -= 1) {
      const entry = due[at];
      if (entry === undefined || entry.at > now) continue;
      due.splice(at, 1);
      entry.settle(new Uint8Array(4));
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    if (options.predict) {
      runPrediction(sim, predictor, HORIZON, 1, 4096);
    } else {
      /*
       * Reactive, which is what every other engine can do: ask for what *this* frame needs, having
       * already needed it. The tiles arrive `LATENCY` frames later.
       */
      const count = sampledAt(path(world.frame), wanted);
      for (let at = 0; at < count; at += 1) {
        const hash = wanted[at] as string;
        if (tileState(table, hash) === TILE_RESIDENT) continue;
        enqueue(queue, hash, 0);
      }
    }
    /* Five hundred and twelve tiles of four bytes: a budget in bytes, which is what the queue takes. */
    const taken = takeBatch(
      queue,
      (hash: string): boolean => tileState(table, hash) === TILE_RESIDENT,
      512 * 4,
      4,
      batch,
    );
    pumpStreamer(streamer, batch, taken);

    /* The frame samples. Anything not here is a tile the picture is missing. */
    const count = sampledAt(path(world.frame), wanted);
    flight.widest = Math.max(flight.widest, count);
    let starved = false;
    for (let at = 0; at < count; at += 1) {
      const hash = wanted[at] as string;
      flight.seen.add(hash);
      if (tileState(table, hash) !== TILE_RESIDENT) {
        flight.late += 1;
        continue;
      }
      /* A sampled tile is in use: the page cache must not take it, and the table must know. */
      if (acquirePage(cache, hash) < 0) starved = true;
      touchTile(table, hash);
    }
    if (starved) flight.starved += 1;
  }

  const finalCount = sampledAt(path(frames - 1), wanted);
  for (let at = 0; at < finalCount; at += 1) {
    const hash = wanted[at] as string;
    if (tileState(table, hash) !== TILE_RESIDENT) flight.neverArrived.push(hash);
  }
  return flight;
}

/** Tiles sampled over a flight's first `frames` frames — what nothing could have fetched in time. */
function demandOver(path: Path, frames: number): number {
  let total = 0;
  for (let frame = 0; frame < frames; frame += 1) total += sampledAt(path(frame), []);
  return total;
}

describe('a predicted flight is never late', () => {
  it('has every tile resident before the frame that samples it, warm-up aside', async () => {
    const flight = await fly(straight, 40, { predict: true });
    /*
     * **Exactly the first three frames' samples, and nothing after them**: 102, 92 and 102. A tile
     * asked for on frame 0 lands on frame 3, so the first three frames cannot be helped by anything,
     * and that warm-up is the whole of what a predicted flight is ever late for.
     */
    expect(demandOver(straight, LATENCY)).toBe(296);
    expect(flight.late).toBe(demandOver(straight, LATENCY));
    /* And the scene really did exceed the cache, while no single frame did. */
    expect(flight.seen.size).toBe(452);
    expect(flight.seen.size).toBeGreaterThan(PAGES);
    expect(flight.widest).toBe(102);
    expect(flight.starved).toBe(0);
  });

  it('is late for nothing at all once the horizon has filled', async () => {
    /* Counted separately from the warm-up, because mixing them lets a regression hide inside the
       allowance the first frames get. */
    const early = await fly(straight, LATENCY + 1, { predict: true });
    const whole = await fly(straight, 40, { predict: true });
    expect(whole.late).toBe(early.late);
  });

  it('leaves nothing outstanding at the end', async () => {
    const flight = await fly(straight, 40, { predict: true });
    expect(flight.neverArrived).toEqual([]);
  });
});

describe('the same flight without prediction is late, which is what proves the mechanism', () => {
  it('misses tiles a predicted flight has', async () => {
    /*
     * Reactive streaming cannot know a tile is needed until a frame has needed it — the state of
     * the art says so in as many words. Without this comparison the test above would pass for a
     * flight that was simply too easy.
     */
    const predicted = await fly(straight, 40, { predict: true });
    const reactive = await fly(straight, 40, { predict: false });
    /* 1,294 against 296, measured 2026-09-17: more than four times as many late samples, and the
       296 are all warm-up. */
    expect(reactive.late).toBe(1294);
    expect(predicted.late).toBe(296);
    /* Both saw the same scene, so the difference is when the bytes arrived and nothing else. */
    expect(reactive.seen.size).toBe(predicted.seen.size);
  });
});

describe('mispredicting degrades rather than fails', () => {
  it('is late and still correct when the camera will not hold a direction', async () => {
    /*
     * A camera reversing every three frames is what prediction cannot help with. What the design
     * promises is that the cost is a wasted fetch and a late tile — the behaviour of a reactive
     * engine — and never a wrong picture or a broken structure.
     */
    const flight = await fly(erratic, 40, { predict: true });
    /* 609 against 296 for a flight it could predict: mispredicting costs 313 late samples over
       forty frames, and nothing else. */
    expect(flight.late).toBe(609);
    expect(flight.starved).toBe(0);

    /* And it converges once the camera stops thrashing, which is the honest form of the claim. */
    expect(flight.neverArrived).toEqual([]);
  });

  it('is no worse than not predicting at all, which is the floor the design claims', async () => {
    const predicted = await fly(erratic, 40, { predict: true });
    const reactive = await fly(erratic, 40, { predict: false });
    /* 609 against 1,471. Even on the path prediction cannot help with, it helps — because the
       tiles it guessed right about are still most of them. */
    expect(predicted.late).toBe(609);
    expect(reactive.late).toBe(1471);
  });
});

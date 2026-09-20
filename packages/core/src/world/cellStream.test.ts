import { mat4 } from 'gl-matrix';
import { describe, expect, it } from 'vitest';
import { runPrediction } from '@driftengine/texture';
import type { SimulationHandle } from '@driftengine/texture';
import { cellCoordsOf, cellIdFor, cellIdFrom } from './cell.ts';
import {
  cameraPositionFrom,
  cellPredictor,
  createCellStream,
  pumpCellStream,
  type CellStore,
} from './cellStream.ts';

const SIZE = 100;

/** A store that records what it was asked to do and nothing else. */
function store(): CellStore & { live: Set<number>; asked: number[]; dropped: number[] } {
  const live = new Set<number>();
  const asked: number[] = [];
  const dropped: number[] = [];
  return {
    live,
    asked,
    dropped,
    loaded: (id) => live.has(id),
    load: (id) => {
      asked.push(id);
      live.add(id);
    },
    unload: (id) => {
      dropped.push(id);
      live.delete(id);
    },
  };
}

/** A view matrix for a camera at `p` looking down −z with no rotation: V = T(−p). */
function viewAt(px: number, py: number, pz: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  m[12] = -px;
  m[13] = -py;
  m[14] = -pz;
  return m;
}

/** A camera walking along +x, one `speed` per step. Saves and restores exactly. */
function walker(speed: number): SimulationHandle & { x: number } {
  const state = {
    x: 0,
    saved: 0,
    save(): void {
      state.saved = state.x;
    },
    restore(): void {
      state.x = state.saved;
    },
    advance(): void {
      state.x += speed;
    },
    viewAt(out: Float32Array): void {
      out.set(viewAt(state.x, 0, 0));
    },
  };
  return state;
}

describe('a camera position out of a view matrix', () => {
  it('is the translation, negated, for a camera that is not turned', () => {
    const out = new Float64Array(3);
    cameraPositionFrom(viewAt(500, 20, -300), out);
    expect([...out]).toEqual([500, 20, -300]);
  });

  /**
   * **A view matrix is `R · T(−p)`, so the translation column is in *view* space.** Reading it
   * directly is right only while the camera is unrotated, which is exactly the case a test
   * happens to write first — and wrong by the whole camera offset the moment anybody turns.
   */
  it('accounts for the rotation, which a turned camera has', () => {
    /* A quarter turn about y: world +x becomes view −z. */
    const m = new Float32Array(16);
    m[0] = 0;
    m[2] = -1;
    m[5] = 1;
    m[8] = 1;
    m[10] = 0;
    m[15] = 1;
    /* t = −R·p for p = (10, 0, 0). R·p is R's first column times ten, which is (0, 0, −10),
       so t = (0, 0, 10) — and reading the translation directly would answer −10. */
    m[12] = 0;
    m[13] = 0;
    m[14] = 10;

    const out = new Float64Array(3);
    cameraPositionFrom(m, out);
    expect(out[0]).toBeCloseTo(10, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });
});

describe('streaming cells', () => {
  it('loads the cells a predicted path enters before the camera arrives', () => {
    const shop = store();
    const stream = createCellStream({ store: shop, size: SIZE, radius: 10, hysteresis: 4 });
    const sim = walker(60);

    /* Eight frames ahead at sixty units a frame is 480 units of +x, which is five cells on. */
    runPrediction(sim, cellPredictor(stream), 8, 1 / 60, 64);

    expect(sim.x, 'the simulation was put back exactly').toBe(0);
    expect(shop.asked, 'a cell five along was asked for before the camera got there').toContain(
      cellIdFor(480, 0, 0, SIZE),
    );
    expect(shop.asked).toContain(cellIdFor(0, 0, 0, SIZE));
  });

  it('asks for a cell once, however many predicted frames want it', () => {
    const shop = store();
    const stream = createCellStream({ store: shop, size: SIZE, radius: 10, hysteresis: 4 });
    runPrediction(walker(1), cellPredictor(stream), 8, 1 / 60, 64);

    expect(new Set(shop.asked).size, 'no duplicates').toBe(shop.asked.length);
  });

  it('does not ask again for a cell that is already there', () => {
    const shop = store();
    shop.live.add(cellIdFor(0, 0, 0, SIZE));
    const stream = createCellStream({ store: shop, size: SIZE, radius: 10, hysteresis: 4 });
    runPrediction(walker(0), cellPredictor(stream), 4, 1 / 60, 64);

    expect(shop.asked).not.toContain(cellIdFor(0, 0, 0, SIZE));
  });

  it('stops at the budget', () => {
    const shop = store();
    const stream = createCellStream({ store: shop, size: SIZE, radius: 400, hysteresis: 4 });
    const requested = runPrediction(walker(60), cellPredictor(stream), 8, 1 / 60, 5);

    expect(requested).toBe(5);
    expect(shop.asked.length).toBe(5);
  });
});

describe('unloading', () => {
  function primed(): {
    shop: ReturnType<typeof store>;
    stream: ReturnType<typeof createCellStream>;
  } {
    const shop = store();
    const stream = createCellStream({ store: shop, size: SIZE, radius: 10, hysteresis: 3 });
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 64);
    return { shop, stream };
  }

  /**
   * **A camera that turns around should not pay to reload what it just left.** Dropping a cell the
   * instant it leaves the radius means walking back and forth across a boundary reloads it every
   * few frames, which is the single most visible failure a streamer has.
   */
  it('keeps a cell that has just gone out of range', () => {
    const { shop, stream } = primed();
    const far = 10_000;

    pumpCellStream(stream, far, 0, 0);
    expect(shop.dropped, 'not on the first frame it is unwanted').toEqual([]);
    pumpCellStream(stream, far, 0, 0);
    pumpCellStream(stream, far, 0, 0);
    expect(shop.dropped).toEqual([]);
  });

  it('drops it once it has gone unwanted for the whole hysteresis', () => {
    const { shop, stream } = primed();
    const far = 10_000;
    for (let at = 0; at < 4; at += 1) pumpCellStream(stream, far, 0, 0);
    expect(shop.dropped).toContain(cellIdFor(0, 0, 0, SIZE));
  });

  it('forgets the countdown when the camera comes back', () => {
    const { shop, stream } = primed();
    pumpCellStream(stream, 10_000, 0, 0);
    pumpCellStream(stream, 10_000, 0, 0);
    /* Back where it started, which is what a camera turning round does. */
    pumpCellStream(stream, 0, 0, 0);
    pumpCellStream(stream, 10_000, 0, 0);
    pumpCellStream(stream, 10_000, 0, 0);
    expect(shop.dropped, 'the countdown restarted').toEqual([]);
  });

  /**
   * **Unloading the ground somebody is standing on is the one case that must never happen**, and
   * it must not depend on prediction having run. A camera standing still has no predicted path
   * asking for anything, so the pump is what keeps the cell it is in alive.
   */
  it('never unloads the cell the camera is inside, however long it stands there', () => {
    const shop = store();
    const stream = createCellStream({ store: shop, size: SIZE, radius: 0, hysteresis: 1 });
    const here = cellIdFor(50, 0, 0, SIZE);
    shop.live.add(here);
    stream.lastWanted.set(here, -999);

    for (let at = 0; at < 10; at += 1) pumpCellStream(stream, 50, 0, 0);
    expect(shop.dropped).toEqual([]);
    expect(shop.loaded(here)).toBe(true);
  });

  it('reports how many it dropped', () => {
    const { stream } = primed();
    for (let at = 0; at < 3; at += 1) expect(pumpCellStream(stream, 10_000, 0, 0)).toBe(0);
    expect(pumpCellStream(stream, 10_000, 0, 0)).toBeGreaterThan(0);
  });
});

describe('a stream that knows the lens looks where the camera looks', () => {
  /*
   * **Streaming by radius alone loads what is near the camera, not what it faces**: a view two
   * cells deep wants the cells two cells ahead, and a radius wide enough to reach them loads as
   * much behind the camera as in front. Given the projection its views are drawn through, a stream
   * wants both — the radius first, because a camera can turn, and then the cells the view looks
   * into, nearest first.
   */
  /*
   * Sixty degrees, so that no plane through the eye — which stands on a cell corner — runs along a
   * cell's edge: a cell that only touches the view is kept or not by the last bit of a rounding.
   */
  const LENS = mat4.perspective(new Float32Array(16), Math.PI / 3, 1, 1, 450) as Float32Array;

  it('asks for the cells ahead that the radius does not reach, and none behind', () => {
    const shop = store();
    const stream = createCellStream({
      store: shop,
      size: SIZE,
      radius: 10,
      hysteresis: 4,
      projection: LENS,
    });
    const sim = walker(0);
    runPrediction(sim, cellPredictor(stream), 1, 1 / 60, 256);
    expect(shop.asked).toContain(cellIdFor(0, 0, -400, SIZE));
    /* Its near corner, (200, 0, -450), is inside: the view is 260 wide either side at 450 deep. */
    expect(shop.asked).toContain(cellIdFor(200, 0, -400, SIZE));
    expect(shop.asked).not.toContain(cellIdFor(300, 0, -400, SIZE));
    expect(shop.asked).not.toContain(cellIdFor(0, 0, 300, SIZE));
    /* The radius still covers the camera's own cell and the ones it straddles. */
    expect(shop.asked).toContain(cellIdFor(-5, 0, 5, SIZE));
  });

  it('asks for the radius first and then the view, nearest first', () => {
    const shop = store();
    const stream = createCellStream({
      store: shop,
      size: SIZE,
      radius: 10,
      hysteresis: 4,
      projection: LENS,
    });
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 256);
    /* Ten units round (0, 0, 0) touches two cells an axis: eight cells. */
    const around = 8;
    const coords = new Int32Array(3);
    const centre = (id: number): number => {
      cellCoordsOf(id, coords);
      const x = ((coords[0] as number) + 0.5) * SIZE;
      const y = ((coords[1] as number) + 0.5) * SIZE;
      const z = ((coords[2] as number) + 0.5) * SIZE;
      /* Squared, and exact: `Math.hypot` of two orderings of one triple can differ in its last bit. */
      return x * x + y * y + z * z;
    };
    const ahead = shop.asked.slice(around).map(centre);
    expect(ahead.length).toBeGreaterThan(20);
    expect(ahead).toEqual([...ahead].sort((a, b) => a - b));
    for (const id of shop.asked.slice(0, around)) {
      cellCoordsOf(id, coords);
      expect([...coords].every((c) => c === 0 || c === -1)).toBe(true);
    }
  });

  it('keeps the radius and then the nearest of the view under a budget smaller than both', () => {
    const shop = store();
    const stream = createCellStream({
      store: shop,
      size: SIZE,
      radius: 10,
      hysteresis: 4,
      projection: LENS,
    });
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 9);
    expect(shop.asked).toHaveLength(9);
    /*
     * The eight round the camera, then the nearest cell of the view beyond them: four cells tie,
     * the ones straight ahead one row further on, and the lowest identifier breaks the tie.
     */
    expect(shop.asked[8]).toBe(cellIdFor(-50, -50, -150, SIZE));
  });

  it('places the view by the stream’s origin, so a far world streams where it is', () => {
    /* A render origin six thousand kilometres out, as far as hundred-metre cells reach: the view
       itself is at render zero. */
    const origin = 6_000_000;
    const shop = store();
    const stream = createCellStream({
      store: shop,
      size: SIZE,
      radius: 10,
      hysteresis: 4,
      projection: LENS,
      origin: [origin, 0, 0],
    });
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 256);
    expect(shop.asked).toContain(cellIdFor(origin, 0, -400, SIZE));
    expect(shop.asked).toContain(cellIdFor(origin + 200, 0, -400, SIZE));
    expect(shop.asked).not.toContain(cellIdFor(0, 0, -400, SIZE));

    /* Nearest is measured from where the camera is, not from the world's origin. */
    const budgeted = store();
    const tight = createCellStream({
      store: budgeted,
      size: SIZE,
      radius: 10,
      hysteresis: 4,
      projection: LENS,
      origin: [origin, 0, 0],
    });
    runPrediction(walker(0), cellPredictor(tight), 1, 1 / 60, 9);
    expect(budgeted.asked[8]).toBe(cellIdFor(origin - 50, -50, -150, SIZE));
  });

  it('follows a lens that changes, because it reads the caller’s projection every frame', () => {
    const lens = mat4.perspective(new Float32Array(16), Math.PI / 3, 1, 1, 150) as Float32Array;
    const shop = store();
    const stream = createCellStream({
      store: shop,
      size: SIZE,
      radius: 10,
      hysteresis: 4,
      projection: lens,
    });
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 256);
    expect(shop.asked).not.toContain(cellIdFor(0, 0, -400, SIZE));
    mat4.perspective(lens, Math.PI / 3, 1, 1, 450);
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 256);
    expect(shop.asked).toContain(cellIdFor(0, 0, -400, SIZE));
  });

  it('refuses a lens wider than its grid allows, and says so', () => {
    const stream = createCellStream({
      store: store(),
      size: SIZE,
      radius: 10,
      hysteresis: 4,
      projection: LENS,
      maxCells: 10,
    });
    const sim = walker(0);
    expect(() => runPrediction(sim, cellPredictor(stream), 1, 1 / 60, 256)).toThrow(
      /more than the 10/,
    );
    /* The refusal comes after the views were taken, so the simulation was already put back. */
    expect(sim.x).toBe(0);
  });

  it('lets the cells a view has turned from go after the hysteresis, and not before', () => {
    const shop = store();
    const stream = createCellStream({
      store: shop,
      size: SIZE,
      radius: 10,
      hysteresis: 2,
      projection: LENS,
    });
    const ahead = cellIdFor(0, 0, -400, SIZE);
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 256);
    expect(shop.loaded(ahead)).toBe(true);

    /* Turned round: the same camera looking down +z. */
    const behind: SimulationHandle = {
      save: () => {},
      restore: () => {},
      advance: () => {},
      viewAt: (out) => {
        out.set(mat4.lookAt(new Float32Array(16), [0, 0, 0], [0, 0, 1], [0, 1, 0]));
      },
    };
    for (let frame = 0; frame < 2; frame += 1) {
      runPrediction(behind, cellPredictor(stream), 1, 1 / 60, 256);
      pumpCellStream(stream, 0, 0, 0);
    }
    expect(shop.dropped).not.toContain(ahead);
    runPrediction(behind, cellPredictor(stream), 1, 1 / 60, 256);
    pumpCellStream(stream, 0, 0, 0);
    expect(shop.dropped).toContain(ahead);
    expect(shop.loaded(cellIdFor(0, 0, 400, SIZE))).toBe(true);
  });

  it('asks for nothing past the radius when it has no lens, as before', () => {
    const shop = store();
    const stream = createCellStream({ store: shop, size: SIZE, radius: 10, hysteresis: 4 });
    runPrediction(walker(0), cellPredictor(stream), 1, 1 / 60, 256);
    expect(shop.asked).toHaveLength(8);
    expect(cellIdFrom(0, 0, 0)).toBe(cellIdFor(0, 0, 0, SIZE));
  });
});

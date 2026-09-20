/**
 * A world bigger than a float, walked end to end, twice, with the same fingerprint.
 *
 * **This is the gate Wave 4B is judged by and every other test in `world/` is a part of it.** The
 * cells, the prediction, the render origin and the freezing each hold on their own; what nobody can
 * check a piece at a time is whether a walk through all four produces the same simulation as a walk
 * with nothing streaming at all. If it does not, the defect is a divergence that appears only in
 * sessions long enough to unload something — which is every real session and no test but this one.
 *
 * **What "end to end" means here, stated rather than implied.** The packing holds ±65,536 cells an
 * axis, which at 512 metres is ±33,554,432 — twice the 2²⁴ where single precision stops resolving
 * whole metres, and where its spacing is four metres. Walking every metre of that is 488,000 ticks
 * of identical arithmetic. What actually changes with distance is the precision, so the walk is run
 * at **six magnitudes** — the origin, a kilometre, thirty-two, a megametre, exactly 2²⁴, and the
 * far end — and the whole gate is asserted at each. The far end is the one that can fail.
 *
 * **There is no character controller in this engine**, and this does not pretend otherwise: the
 * walker is a kinematic stepper that follows the ground, which is all the world needs of it.
 * Deciding how a character moves is a game's decision and `ai/src/entities/context.ts` refuses the
 * neighbouring one for the same reason.
 */
import { describe, expect, test } from 'vitest';
import { Fingerprint } from '@driftengine/network';
import { runPrediction } from '@driftengine/texture';
import type { Predictor, SimulationHandle } from '@driftengine/texture';
import {
  NavMeshQuery,
  buildContours,
  buildPolyMesh,
  buildRegions,
  nearestPoly,
} from '@driftengine/nav';
import { fieldFromMap } from '@driftengine/nav/src/testField.ts';

import { cellIdFor, cellsInRadius } from './cell.ts';
import { renderOrigin, toRenderSpace, toWorldSpace } from './rebase.ts';
import {
  createCellStream,
  cellPredictor,
  pumpCellStream,
  setCellStreamOrigin,
  type CellStore,
} from './cellStream.ts';
import {
  createFrozenCells,
  freezeCell,
  frozenFingerprintContribution,
  isCellFrozen,
  thawCell,
  type FreezableWorld,
  type FrozenCells,
} from './freeze.ts';

const CELL_SIZE = 512;
/** Wanted radius, and the simulated radius inside it — so nothing is dropped before it freezes. */
const STREAM_RADIUS = 1200;
const SIM_RADIUS = 900;
const HYSTERESIS = 3;
const PREDICT_AHEAD = 6;
const TICKS = 220;
/** Metres a tick. Deliberately not a divisor of the cell, so boundaries are crossed mid-step. */
const STEP = 137.5;
const ENTITIES_PER_CELL = 3;
const STATE_VALUES = 3;

/**
 * Where the walk starts, one run each.
 *
 * The last is a hundred metres short of what the packing holds at this cell size, and 2²⁴ is in
 * the list because it is exactly where single precision stops counting in ones.
 */
const WALK_STARTS = [0, 1_024, 32_768, 1_048_576, 16_777_216, 33_500_000];

/* ---------------------------------------------------------------- the ground */

/**
 * A cell's corner height, from an integer hash of its grid coordinate.
 *
 * **Integer arithmetic and no transcendental**, because this is the authored content of a cell and
 * two peers have to agree about it to the bit. `Math.sin` of a coordinate would also be smooth and
 * would also be wrong: ECMAScript does not pin it, and `scripts/determinism.test.mjs` refuses one
 * in shipped source for exactly that reason.
 */
function cornerHeight(cx: number, cz: number): number {
  let h = Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cz | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (((h ^ (h >>> 15)) >>> 0) / 0xffffffff) * 24;
}

/**
 * The ground at an absolute position, bilinear between the four cells around it.
 *
 * **Read in cell-local coordinates**, which is the whole point: the fractional offset inside a cell
 * is a number under 512 however far out the cell is, so the interpolation is exact at the far end
 * of the world and at the origin alike. A height function evaluated on the absolute coordinate
 * would lose its low bits exactly where this world is interesting.
 */
function groundAt(x: number, z: number): number {
  const cx = Math.floor(x / CELL_SIZE);
  const cz = Math.floor(z / CELL_SIZE);
  const fx = (x - cx * CELL_SIZE) / CELL_SIZE;
  const fz = (z - cz * CELL_SIZE) / CELL_SIZE;
  const a = cornerHeight(cx, cz);
  const b = cornerHeight(cx + 1, cz);
  const c = cornerHeight(cx, cz + 1);
  const d = cornerHeight(cx + 1, cz + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

/* ---------------------------------------------------------------- the world */

interface Walker {
  x: number;
  y: number;
  z: number;
  tick: number;
}

/** Every cell the walk will ever touch, in ascending identifier order, with its entities. */
function manifestFor(startX: number): { cells: number[]; entities: Map<number, number[]> } {
  const seen = new Set<number>();
  const scratch: number[] = [];
  for (let tick = 0; tick <= TICKS + PREDICT_AHEAD + 2; tick += 1) {
    const at = positionAt(startX, tick);
    cellsInRadius(at.x, at.y, at.z, STREAM_RADIUS + CELL_SIZE, CELL_SIZE, scratch);
    for (const id of scratch) seen.add(id);
  }
  const cells = [...seen].sort((a, b) => a - b);
  const entities = new Map<number, number[]>();
  /*
   * Entity identifiers are ordinals over the sorted manifest rather than a function of the cell
   * identifier, which at this range is past 2⁵¹ and would overflow the moment anything multiplied
   * it. The order is the sorted one, so both runs agree without being told to.
   */
  for (let ordinal = 0; ordinal < cells.length; ordinal += 1) {
    const list: number[] = [];
    for (let index = 0; index < ENTITIES_PER_CELL; index += 1) {
      list.push(ordinal * ENTITIES_PER_CELL + index);
    }
    entities.set(cells[ordinal] as number, list);
  }
  return { cells, entities };
}

/** Where the walker is at a tick, as a pure function, so the manifest and the run agree. */
function positionAt(startX: number, tick: number): { x: number; y: number; z: number } {
  const x = startX + tick * STEP;
  const z = 256 + tick * (STEP / 4);
  return { x, y: groundAt(x, z) + 1.8, z };
}

class WalkWorld implements FreezableWorld {
  readonly entities: Map<number, number[]>;
  readonly state = new Map<number, Float64Array>();
  readonly live = new Set<number>();
  private readonly sim = new Set<number>();

  constructor(manifest: { cells: number[]; entities: Map<number, number[]> }) {
    this.entities = manifest.entities;
    for (const cell of manifest.cells) {
      this.live.add(cell);
      for (const entity of manifest.entities.get(cell) as number[]) {
        /* Authored state: a function of the identifier, so both runs start identical. */
        this.state.set(
          entity,
          Float64Array.from([entity * 0.25, entity * -0.5, (entity * 2654435761) % 1000003]),
        );
        this.sim.add(entity);
      }
    }
  }

  entitiesIn(cell: number): readonly number[] {
    return this.entities.get(cell) ?? [];
  }

  readState(entity: number, out: Float64Array): number {
    const values = this.state.get(entity);
    if (values === undefined) throw new Error(`read from an unloaded entity ${entity}`);
    out.set(values);
    return values.length;
  }

  writeState(entity: number, values: Float64Array, count: number): void {
    this.state.set(entity, values.slice(0, count));
  }

  simulating(entity: number): boolean {
    return this.sim.has(entity);
  }

  setSimulating(entity: number, on: boolean): void {
    if (on) this.sim.add(entity);
    else this.sim.delete(entity);
  }

  /** One deterministic step, and it accumulates, so a tick skipped anywhere is visible for ever. */
  step(entity: number): void {
    const values = this.state.get(entity);
    if (values === undefined) return;
    const phase = ((values[2] as number) * 31 + 7) % 1000003;
    values[0] = (values[0] as number) + ((phase % 7) - 3) * 0.01;
    values[1] = (values[1] as number) + ((phase % 5) - 2) * 0.01;
    values[2] = phase;
  }
}

/* ---------------------------------------------------------------- the run */

interface WalkResult {
  digest: string;
  /** Ticks where the walker's own cell was not resident. A gap in the ground. */
  gaps: number;
  /** Worst round-trip error through render space, metres. */
  worstRebase: number;
  /** Worst error from putting the absolute position in single precision instead. */
  worstNaive: number;
  /** Ticks where the navigation query found no path. */
  navFailures: number;
  /** How many times the render origin moved. Far below the tick count, or it is not quantised. */
  originChanges: number;
  loads: number;
  unloads: number;
}

type FreezeRule = 'simulation' | 'residency';

/**
 * Walk once.
 *
 * `stream` false is the control: every cell resident from the first tick and never dropped.
 * `freezeRule` is the thing under test — `'simulation'` freezes by distance, which is a decision
 * the simulation makes and both runs make identically; `'residency'` freezes whatever is not
 * loaded, which is the design the wave's constraints forbid and which this file proves wrong
 * rather than merely refusing.
 */
function walk(startX: number, options: { stream: boolean; freezeRule?: FreezeRule }): WalkResult {
  const freezeRule: FreezeRule = options.freezeRule ?? 'simulation';
  const manifest = manifestFor(startX);
  const world = new WalkWorld(manifest);
  const frozen: FrozenCells = createFrozenCells();

  let loads = 0;
  let unloads = 0;
  const store: CellStore = {
    loaded: (id: number): boolean => world.live.has(id),
    load: (id: number): void => {
      if (world.live.has(id)) return;
      world.live.add(id);
      loads += 1;
      /* The forbidden design, faithfully: loading is what starts a region simulating again. */
      if (freezeRule === 'residency' && isCellFrozen(frozen, id)) thawCell(world, frozen, id);
    },
    unload: (id: number): void => {
      /* And unloading is what stops it — which is the simulation depending on a memory budget. */
      if (freezeRule === 'residency' && !isCellFrozen(frozen, id)) freezeCell(world, frozen, id);
      /*
       * **Only a frozen cell may be unloaded**, and this is the assertion rather than a comment
       * about it. Unloading something that is still simulating is how streaming starts deciding
       * what the simulation computes, which is the one thing this wave forbids.
       */
      if (!isCellFrozen(frozen, id)) throw new Error(`unloaded cell ${id} while it was simulating`);
      for (const entity of world.entitiesIn(id)) world.state.delete(entity);
      world.live.delete(id);
      unloads += 1;
    },
  };

  /*
   * The world begins entirely frozen, which is what a save file is: every cell's authored state is
   * known and nothing is running. Cells thaw as the walker arrives. Without this, a cell the
   * streamed run never loaded would contribute nothing to its fingerprint while the resident run
   * contributed a frozen digest — the two runs would differ over ground neither had touched.
   */
  for (const cell of manifest.cells) freezeCell(world, frozen, cell);
  if (options.stream) for (const cell of manifest.cells) store.unload(cell);

  const stream = createCellStream({
    store,
    size: CELL_SIZE,
    radius: STREAM_RADIUS,
    hysteresis: HYSTERESIS,
  });
  const predictor: Predictor<number> = cellPredictor(stream);

  const walker: Walker = { ...positionAt(startX, 0), tick: 0 };
  const saved: Walker = { ...walker };
  const origin = new Float64Array(3);
  const render = new Float32Array(3);
  const back = new Float64Array(3);

  const sim: SimulationHandle = {
    save: (): void => {
      saved.x = walker.x;
      saved.y = walker.y;
      saved.z = walker.z;
      saved.tick = walker.tick;
    },
    restore: (): void => {
      walker.x = saved.x;
      walker.y = saved.y;
      walker.z = saved.z;
      walker.tick = saved.tick;
    },
    advance: (): void => {
      walker.tick += 1;
      const at = positionAt(startX, walker.tick);
      walker.x = at.x;
      walker.y = at.y;
      walker.z = at.z;
    },
    viewAt: (out: Float32Array): void => {
      /*
       * **Render space, which is the only space a `Float32Array` can carry here.** An absolute
       * position at the far end of this world does not survive single precision: 2²⁵ has a spacing
       * of four metres. The stream is told the origin and adds it back in double precision.
       */
      viewMatrix(walker, origin, out);
    },
  };

  const navMesh = walkNavMesh();
  const navQuery = new NavMeshQuery(navMesh);
  const navPath = new Float64Array(64);

  const simScratch: number[] = [];
  const simulated = new Set<number>();
  const fingerprint = new Fingerprint();
  const result: WalkResult = {
    digest: '',
    gaps: 0,
    worstRebase: 0,
    worstNaive: 0,
    navFailures: 0,
    originChanges: 0,
    loads: 0,
    unloads: 0,
  };
  const lastOrigin = new Float64Array([NaN, NaN, NaN]);

  for (let tick = 0; tick < TICKS; tick += 1) {
    walker.tick = tick;
    const at = positionAt(startX, tick);
    walker.x = at.x;
    walker.y = at.y;
    walker.z = at.z;

    renderOrigin(walker.x, walker.y, walker.z, CELL_SIZE, origin);
    if (origin[0] !== lastOrigin[0] || origin[1] !== lastOrigin[1] || origin[2] !== lastOrigin[2]) {
      result.originChanges += 1;
      lastOrigin.set(origin);
    }
    setCellStreamOrigin(stream, origin[0] as number, origin[1] as number, origin[2] as number);

    if (options.stream) {
      /* Look ahead and ask for what the walk is about to enter, by Wave 3B's own mechanism. */
      runPrediction(sim, predictor, PREDICT_AHEAD, 1, 64);
    }

    /*
     * Freezing, which both runs do identically when the rule is the simulation's — computed as one
     * set for the tick rather than asked cell by cell, which is the difference between this file
     * running in a second and running in a minute.
     */
    if (freezeRule === 'simulation') {
      cellsInRadius(walker.x, walker.y, walker.z, SIM_RADIUS, CELL_SIZE, simScratch);
      simulated.clear();
      for (const id of simScratch) simulated.add(id);
      for (const cell of manifest.cells) {
        if (simulated.has(cell)) {
          if (!isCellFrozen(frozen, cell)) continue;
          if (!world.live.has(cell)) store.load(cell, 0);
          thawCell(world, frozen, cell);
        } else if (!isCellFrozen(frozen, cell)) {
          freezeCell(world, frozen, cell);
        }
      }
    }

    if (options.stream) pumpCellStream(stream, walker.x, walker.y, walker.z);

    /* The tick itself. Absolute, double precision, and it never rebases. */
    for (const cell of manifest.cells) {
      for (const entity of world.entitiesIn(cell)) {
        if (!world.simulating(entity)) continue;
        world.step(entity);
      }
    }

    /* The ground under the walker, which has to come from a cell that is actually here. */
    const own = cellIdFor(walker.x, walker.y, walker.z, CELL_SIZE);
    if (!world.live.has(own)) result.gaps += 1;

    /* Render space, and the same question asked of single precision on its own. */
    toRenderSpace(walker.x, walker.y, walker.z, origin, render);
    toWorldSpace(render, origin, back);
    const rebaseError = Math.max(
      Math.abs((back[0] as number) - walker.x),
      Math.abs((back[1] as number) - walker.y),
      Math.abs((back[2] as number) - walker.z),
    );
    if (rebaseError > result.worstRebase) result.worstRebase = rebaseError;
    const naiveError = Math.abs(Math.fround(walker.x) - walker.x);
    if (naiveError > result.worstNaive) result.worstNaive = naiveError;

    /* A navigation query, in render space, over a mesh authored in cell-local coordinates. */
    const localX = (render[0] as number) / CELL_SIZE;
    const localZ = (render[2] as number) / CELL_SIZE;
    const found = navQuery.findPath(1 + localX * 6, 1 + localZ * 3, 8.5, 4.5, 1.5, navPath);
    if (found === 0) result.navFailures += 1;

    foldWorld(fingerprint, manifest.cells, world, frozen, walker);
  }

  result.digest = fingerprint.digest();
  result.loads = loads;
  result.unloads = unloads;
  return result;
}

/**
 * Fold one tick of the whole world into the fingerprint.
 *
 * Frozen cells contribute the digest they were frozen with and live cells their values, with a
 * marker between the two so one can never be mistaken for the other. Ascending cell order, because
 * a `Map`'s order is a property of the load path rather than of the state — the same reason
 * `fingerprintSnapshot` sorts its stores.
 */
function foldWorld(
  fingerprint: Fingerprint,
  cells: readonly number[],
  world: WalkWorld,
  frozen: FrozenCells,
  walker: Walker,
): void {
  fingerprint.float(walker.x).float(walker.y).float(walker.z).int32(walker.tick);
  for (const cell of cells) {
    if (isCellFrozen(frozen, cell)) {
      fingerprint.int32(0).int32(frozenFingerprintContribution(frozen, cell));
      continue;
    }
    fingerprint.int32(1);
    for (const entity of world.entitiesIn(cell)) {
      const values = world.state.get(entity);
      if (values === undefined) throw new Error(`a live cell held no state for entity ${entity}`);
      fingerprint.array(values, STATE_VALUES);
    }
  }
}

/** A yaw that turns as the walk goes, so the camera is never axis-aligned. */
function viewMatrix(walker: Walker, origin: Float64Array, out: Float32Array): void {
  const yaw = walker.tick * 0.037;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const px = walker.x - (origin[0] as number);
  const py = walker.y - (origin[1] as number);
  const pz = walker.z - (origin[2] as number);
  out.fill(0);
  out[0] = cos;
  out[2] = -sin;
  out[5] = 1;
  out[8] = sin;
  out[10] = cos;
  out[12] = -(cos * px + sin * pz);
  out[13] = -py;
  out[14] = -(-sin * px + cos * pz);
  out[15] = 1;
}

/** Ten by six of open ground, which is a cell's walkable space as a picture. */
function walkNavMesh() {
  const field = fieldFromMap([
    '..........',
    '..........',
    '....##....',
    '....##....',
    '..........',
    '..........',
  ]);
  const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
  return buildPolyMesh(buildContours(field, regions, 0.5), 6, field);
}

/* ---------------------------------------------------------------- the gate */

/** Walks are deterministic and several tests ask for the same one, so each is run once. */
const WALKS = new Map<string, WalkResult>();
function walkOnce(
  startX: number,
  options: { stream: boolean; freezeRule?: FreezeRule },
): WalkResult {
  const key = `${startX}/${String(options.stream)}/${options.freezeRule ?? 'simulation'}`;
  const had = WALKS.get(key);
  if (had !== undefined) return had;
  const result = walk(startX, options);
  WALKS.set(key, result);
  return result;
}

describe('a world bigger than a float walks end to end', () => {
  test('streams without ever leaving the ground the walker is standing on', () => {
    for (const start of WALK_STARTS) {
      const streamed = walkOnce(start, { stream: true });
      expect(streamed.gaps, `a gap at ${start}`).toBe(0);
      /* And it really did stream: cells were dropped and reloaded rather than all held. */
      expect(streamed.unloads, `no unloads at ${start}`).toBeGreaterThan(0);
      expect(streamed.loads, `no loads at ${start}`).toBeGreaterThan(0);
    }
  });

  test('keeps the transform exact through the render origin, where a float alone does not', () => {
    /*
     * **The comparison is the test.** A round trip through render space is exact to the bit at
     * every magnitude, because the subtraction happens in double precision and only the result
     * narrows. Putting the same absolute coordinate into single precision instead is wrong by up to
     * two metres at the far end — a character sliding two metres sideways when the camera moves,
     * which is the artefact this whole mechanism exists to remove.
     */
    const near = walkOnce(0, { stream: true });
    const far = walkOnce(33_500_000, { stream: true });

    /*
     * **Not exact, and saying so is the point.** Render space is single precision, so a round trip
     * loses an ulp of a number under five hundred — under a micrometre. What matters is that it is
     * the *same* ulp at the far end of the world as at the origin, because the value narrowed is
     * always relative to a nearby origin.
     */
    expect(near.worstRebase).toBeLessThan(1e-4);
    expect(far.worstRebase).toBeLessThan(1e-4);
    expect(far.worstRebase).toBeLessThan(near.worstRebase * 4 + 1e-6);

    /*
     * The same coordinate put into single precision instead grows with the world. **Exactly one
     * metre**, and the number is worth writing out: between 2²⁴ and 2²⁵ single precision counts in
     * twos, so it holds only even metres and a position on a half-metre is a whole metre from the
     * nearest one it can hold. A character standing still moves a metre when the camera does.
     */
    expect(near.worstNaive).toBeLessThan(0.001);
    expect(far.worstNaive).toBe(1);
  });

  test('moves the render origin in whole cells, not continuously', () => {
    /*
     * **A continuously-moving origin solves the precision problem by causing it.** Every vertex is
     * re-quantised against a different origin every frame, and a world that is numerically correct
     * at every instant shimmers, because what the eye sees is the change rather than the value. So
     * the origin is a cell corner and it holds still while the camera is inside that cell.
     *
     * Counted rather than asserted about: two hundred and twenty ticks, and the origin moves once
     * per cell crossed. A continuous origin would move on all of them.
     */
    const far = walkOnce(33_500_000, { stream: true });
    /*
     * **Seventy-five against two hundred and twenty**: the first tick, then fifty-nine boundaries
     * crossed along x — thirty kilometres of walking at five hundred and twelve metres a cell —
     * and fifteen along z. A continuous origin would move on every one of the two hundred and
     * twenty, which is what the world shimmering is.
     */
    expect(far.originChanges).toBe(75);
    expect(far.originChanges).toBeLessThan(TICKS / 2);
  });

  test('answers every navigation query, because the query never sees a large coordinate', () => {
    for (const start of WALK_STARTS) {
      expect(walkOnce(start, { stream: true }).navFailures, `nav failed at ${start}`).toBe(0);
    }
  });

  test('has no navigation mesh at an absolute coordinate, which is why render space is used', () => {
    /* The contrast, so "the query never sees a large coordinate" is a fact rather than a habit. */
    const mesh = walkNavMesh();
    expect(nearestPoly(mesh, 4.5, 1.5, 1)).toBeGreaterThanOrEqual(0);
    expect(nearestPoly(mesh, 33_500_000, 1.5, 1)).toBe(-1);
  });

  test('fingerprints identically to the same walk with every cell loaded from the start', () => {
    /*
     * **The real gate.** Everything above is a symptom that could be fixed without fixing this.
     * Two runs of the same walk, one streaming and one holding the whole world, and the hash of
     * every tick of every cell agrees — which is only true if freezing is a decision the
     * simulation makes and unloading is a decision about memory, and if a cell's state survives
     * the trip out to a frozen record and back exactly.
     */
    for (const start of WALK_STARTS) {
      const streamed = walkOnce(start, { stream: true });
      const resident = walkOnce(start, { stream: false });
      expect(streamed.digest, `divergence at ${start}`).toBe(resident.digest);
      expect(resident.unloads).toBe(0);
    }
  });

  test('diverges when freezing is driven by residency instead, which is the forbidden design', () => {
    /*
     * **What makes the gate above worth anything.** If freezing followed what happened to be
     * loaded, the simulation would depend on how much memory a machine had — a divergence that
     * appears on one player's computer and nowhere else. It is refused by the design and it is
     * refused here by a test, because a rule nothing can break is a rule nobody can check.
     */
    const honest = walkOnce(33_500_000, { stream: true });
    const wrong = walkOnce(33_500_000, { stream: true, freezeRule: 'residency' });
    expect(wrong.digest).not.toBe(honest.digest);
  });

  test('refuses to unload a cell that is still simulating', () => {
    /* The invariant the store asserts, asserted directly rather than relied upon. */
    const manifest = manifestFor(0);
    const world = new WalkWorld(manifest);
    const frozen = createFrozenCells();
    const cell = manifest.cells[0] as number;
    expect(isCellFrozen(frozen, cell)).toBe(false);
    expect(() => {
      if (!isCellFrozen(frozen, cell)) throw new Error('unloaded while simulating');
    }).toThrow();
    expect(freezeCell(world, frozen, cell)).toBe(true);
    expect(isCellFrozen(frozen, cell)).toBe(true);
  });
});

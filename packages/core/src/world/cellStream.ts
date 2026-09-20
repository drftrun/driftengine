/**
 * Streaming world cells by the prediction that already streams texture tiles.
 *
 * **Almost no new mechanism, and that is the point.** Wave 3B built the speculative advance, the
 * queue and the budget generically *for this* — its own header says so: "Wave 4B streams world
 * cells by exactly this mechanism", and writing a second speculative advance here would be a
 * second place for "put the simulation back exactly" to be got wrong, in a subsystem where being
 * wrong means the world runs at double speed only while streaming is on. What is new here is
 * `needs` — which cells a predicted view enters — and the load and the unload.
 *
 * **The predictor is satisfied structurally rather than imported.** `@driftengine/texture` has no
 * dependencies and core must not gain it as one: `scripts/size-gate.test.mjs` asserts that
 * importing core alone pulls in no optional package, and that assertion is worth more than an
 * import. The shape here *is* `Predictor<number>`, and `cellStream.test.ts` proves it by running
 * the real `runPrediction` over it through a dev dependency.
 *
 * **A cell is dropped after a hysteresis and never immediately.** A camera that turns round should
 * not pay to reload what it just left, and dropping on the frame a cell leaves the radius makes
 * walking back and forth across a boundary reload it every few frames — the most visible failure a
 * streamer has.
 */
import { mat4 } from 'gl-matrix';
import { cellCoordsOf, cellsInFrustum, cellsInRadius, createCellGrid } from './cell.ts';
import type { CellGrid } from './cell.ts';

/** What a stream needs of whatever holds a cell's contents. */
export interface CellStore {
  loaded(id: number): boolean;
  /** Begin loading. Lower `priority` is sooner, matching the queue's convention. */
  load(id: number, priority: number): void;
  unload(id: number): void;
}

export interface CellStreamOptions {
  readonly store: CellStore;
  /** Cell edge length, world units. */
  readonly size: number;
  /** How far around a view cells are wanted. */
  readonly radius: number;
  /** How many pumps a cell may go unwanted before it is dropped. */
  readonly hysteresis: number;
  /** The render origin the predicted views are relative to. Absent means the world origin. */
  readonly origin?: ArrayLike<number>;
  /**
   * The projection the predicted views are drawn through. With it, a stream also wants the cells
   * those views look into, out to its far plane; without it, only the cells within `radius`.
   */
  readonly projection?: ArrayLike<number>;
  /** The most cells one view's query may walk. See `CellGrid`. */
  readonly maxCells?: number;
}

export interface CellStream {
  readonly store: CellStore;
  readonly size: number;
  readonly radius: number;
  readonly hysteresis: number;
  /**
   * Where the predicted views' origin is, in absolute world coordinates.
   *
   * **A view matrix is `Float32Array`, and that is why this exists.** `runPrediction` writes views
   * into single precision — which is right, because a view matrix is what a renderer takes — and
   * single precision stops resolving whole metres past 2²⁴. A world larger than that cannot put an
   * absolute position through one: at 2²⁵ the spacing is four metres, so the camera position
   * recovered from the matrix is wrong by up to two. Streaming survives it, because
   * `cellsInRadius` is conservative and four metres against a five-hundred-metre cell only ever
   * adds a cell — but it is wrong, and it is wrong in exactly the place this mechanism exists for.
   *
   * So the views are render-space, relative to this, and the stream adds it back. Zero by default,
   * which is what every consumer that fits inside single precision already had.
   */
  readonly origin: Float64Array;
  /** Cell identifier to the frame it was last wanted. What the hysteresis counts against. */
  readonly lastWanted: Map<number, number>;
  /** Pumps so far. Monotonic, and the only clock this has. */
  frame: number;
  readonly grid: CellGrid;
  /**
   * The caller's own array, read on every predicted frame — so a lens that zooms or pulls its far
   * plane in is followed without telling the stream.
   */
  readonly projection: ArrayLike<number> | null;
}

export function createCellStream(options: CellStreamOptions): CellStream {
  return {
    store: options.store,
    size: options.size,
    radius: options.radius,
    hysteresis: options.hysteresis,
    origin:
      options.origin === undefined
        ? new Float64Array(3)
        : Float64Array.from(options.origin, Number),
    lastWanted: new Map<number, number>(),
    frame: 0,
    grid: createCellGrid(options.size, options.maxCells),
    projection: options.projection ?? null,
  };
}

/**
 * Move the origin the predicted views are relative to.
 *
 * Called with whatever `renderOrigin` answered for this frame, so the two cannot drift apart. It is
 * a write rather than a parameter to `needs` because the predictor's shape is `Predictor<number>`
 * and that interface is Wave 3B's, shared with texture tiles, which have no origin.
 */
export function setCellStreamOrigin(stream: CellStream, x: number, y: number, z: number): void {
  stream.origin[0] = x;
  stream.origin[1] = y;
  stream.origin[2] = z;
}

/**
 * Where the camera is, out of a view matrix, into `out`.
 *
 * **A view matrix is `R · T(−p)`, so its translation column is in *view* space** and negating it is
 * right only while the camera is unrotated. The camera's world position is `−Rᵀ · t`, and the
 * transpose is the inverse because a view rotation is orthonormal. Getting this wrong is invisible
 * in any test whose camera is not turned, and wrong by the whole camera offset in every other.
 *
 * Column-major, as `gl-matrix` writes one: `m[0..2]` is the first column.
 */
export function cameraPositionFrom(view: ArrayLike<number>, out: Float64Array): void {
  const tx = view[12] as number;
  const ty = view[13] as number;
  const tz = view[14] as number;
  /* Rᵀ · t, which is a dot with each *column* of R — and a column of R is a row of Rᵀ. */
  out[0] = -((view[0] as number) * tx + (view[1] as number) * ty + (view[2] as number) * tz);
  out[1] = -((view[4] as number) * tx + (view[5] as number) * ty + (view[6] as number) * tz);
  out[2] = -((view[8] as number) * tx + (view[9] as number) * ty + (view[10] as number) * tz);
}

/* Reused across calls: this runs per predicted frame and these are its only allocations. */
const POSITION = new Float64Array(3);
const WANTED: number[] = [];
const AHEAD: number[] = [];
const AROUND = new Set<number>();
const VIEW = new Float64Array(16);
const LENS = new Float64Array(16);
const VIEW_PROJECTION = new Float64Array(16);
const SHIFT = new Float64Array(3);
const EYE = new Float64Array(3);
const CELL = new Int32Array(3);
let cellEdge = 1;

/** How far a cell's centre is from `EYE`, squared. */
function reachOf(id: number): number {
  cellCoordsOf(id, CELL);
  const x = ((CELL[0] as number) + 0.5) * cellEdge - (EYE[0] as number);
  const y = ((CELL[1] as number) + 0.5) * cellEdge - (EYE[1] as number);
  const z = ((CELL[2] as number) + 0.5) * cellEdge - (EYE[2] as number);
  return x * x + y * y + z * z;
}

/**
 * Nearest first. Two cells as near keep the order the query listed them in, which is identifier
 * order, because a sort in this language is stable — so the order is the view's alone.
 */
function nearerFirst(a: number, b: number): number {
  return reachOf(a) - reachOf(b);
}

/**
 * The cells a view looks into that the radius did not already name, appended to `WANTED`, nearest
 * first — so that a budget smaller than both keeps the ground round the camera and then the view's
 * nearest cells.
 */
function appendView(stream: CellStream, projection: ArrayLike<number>, view: Float32Array): void {
  VIEW.set(view);
  LENS.set(projection);
  mat4.multiply(VIEW_PROJECTION, LENS, VIEW);
  /* The views are render-space; the cells are absolute. Shift in double precision. */
  SHIFT[0] = -(stream.origin[0] as number);
  SHIFT[1] = -(stream.origin[1] as number);
  SHIFT[2] = -(stream.origin[2] as number);
  mat4.translate(VIEW_PROJECTION, VIEW_PROJECTION, SHIFT);
  cellsInFrustum(stream.grid, VIEW_PROJECTION, AHEAD);

  AROUND.clear();
  for (const id of WANTED) AROUND.add(id);
  let kept = 0;
  for (const id of AHEAD) {
    if (!AROUND.has(id)) {
      AHEAD[kept] = id;
      kept += 1;
    }
  }
  AHEAD.length = kept;
  cellEdge = stream.size;
  AHEAD.sort(nearerFirst);
  for (const id of AHEAD) WANTED.push(id);
}

/**
 * The stream as a `Predictor<number>` over cell identifiers.
 *
 * Structurally typed on purpose — see the header. A caller passes the result straight to
 * `runPrediction` from `@driftengine/texture`.
 */
export function cellPredictor(stream: CellStream): {
  needs(view: Float32Array, out: number[], budget: number): number;
  resident(id: number): boolean;
  request(id: number, priority: number): void;
} {
  return {
    needs(view: Float32Array, out: number[], budget: number): number {
      cameraPositionFrom(view, POSITION);
      /* Back to absolute, in double precision, before anything is quantised into a cell. */
      EYE[0] = (POSITION[0] as number) + (stream.origin[0] as number);
      EYE[1] = (POSITION[1] as number) + (stream.origin[1] as number);
      EYE[2] = (POSITION[2] as number) + (stream.origin[2] as number);
      cellsInRadius(
        EYE[0] as number,
        EYE[1] as number,
        EYE[2] as number,
        stream.radius,
        stream.size,
        WANTED,
      );
      if (stream.projection !== null) appendView(stream, stream.projection, view);
      /*
       * Wanting is recorded for every cell a predicted view enters, not only for the ones that fit
       * inside the budget. Otherwise a budget-limited frame would let a cell the camera is heading
       * straight for start its unload countdown.
       */
      const take = Math.min(budget, WANTED.length);
      out.length = 0;
      for (let at = 0; at < WANTED.length; at += 1) {
        const id = WANTED[at] as number;
        stream.lastWanted.set(id, stream.frame);
        if (at < take) out.push(id);
      }
      return out.length;
    },

    resident(id: number): boolean {
      return stream.store.loaded(id);
    },

    request(id: number, priority: number): void {
      stream.store.load(id, priority);
    },
  };
}

/**
 * Mark what is in range *now*, then drop what has gone unwanted long enough. Returns how many went.
 *
 * **The pump marks as well as drops, and the first draft only dropped.** Prediction marks what is
 * coming; without the pump marking what is here, a camera standing still wants nothing — its
 * predicted path never leaves the cell it is in, the horizon moves past every cell it already
 * occupies, and the streamer unloads the ground somebody is standing on. That is not a case to
 * guard against separately: it is the same question as "what does this camera want", asked about
 * the present instead of the future.
 *
 * So there is no special case for the camera's own cell. `cellsInRadius` includes it at any
 * radius, including zero, which means the guarantee follows from the marking rather than from a
 * check somebody could delete without a test failing.
 */
export function pumpCellStream(stream: CellStream, x: number, y: number, z: number): number {
  stream.frame += 1;

  cellsInRadius(x, y, z, stream.radius, stream.size, WANTED);
  for (const id of WANTED) stream.lastWanted.set(id, stream.frame);

  let dropped = 0;
  for (const [id, wanted] of stream.lastWanted) {
    if (stream.frame - wanted <= stream.hysteresis) continue;
    if (stream.store.loaded(id)) {
      stream.store.unload(id);
      dropped += 1;
    }
    stream.lastWanted.delete(id);
  }
  return dropped;
}

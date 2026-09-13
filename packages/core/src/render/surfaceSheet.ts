/**
 * A bounded, roughly horizontal sheet, described by the cross-sections it is
 * swept through, and the triangles that cover it.
 *
 * Cross-sections rather than rectangles, because the things this describes
 * follow a route: a channel of water beside a path, the underside of a bridge
 * over it. A chain of independent rectangles laid along a curve leaves a notch
 * at every joint — small, and exactly the kind of small that reads as broken
 * once light is crawling across it. Consecutive spans share their edge, so a
 * curving sheet is closed by construction.
 *
 * Nothing here knows what a sheet is *for*. It takes numbers.
 */

/** One cross-section: the two ends of a straight edge across the sheet. */
export interface SheetSpan {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Resting height of the sheet at this cross-section. */
  y: number;
}

export interface SheetMesh {
  /** Resting position, 3 floats per vertex. A shader may displace it. */
  positions: Float32Array;
  /**
   * Where the vertex sits inside its own sheet, 0..1 along and across.
   *
   * So a shader can dissolve its own boundary. It reaches 0 and 1 exactly at the
   * outermost vertices rather than approaching them, which is the lesson the
   * ocean's rim already paid for: a fade that only nearly closes leaves a hard
   * edge, and a hard edge reads as geometry rather than as water.
   */
  locals: Float32Array;
  /** Two numbers carried from each sheet onto every one of its vertices. */
  params: Float32Array;
  vertexCount: number;
}

/** Accumulator, so the emit helper stays out of the loop bodies. */
interface Accumulator {
  positions: number[];
  locals: number[];
  params: number[];
  param0: number;
  param1: number;
}

/**
 * One vertex, bilinearly placed between two cross-sections.
 *
 * @param along 0 at span `a`, 1 at span `b`.
 * @param across 0 at the spans' first end, 1 at their second.
 * @param joint index of `a` within the sheet, and how many joints it has, so the
 *   local coordinate measures the whole sheet rather than this piece of it.
 */
function emitVertex(
  into: Accumulator,
  a: SheetSpan,
  b: SheetSpan,
  along: number,
  across: number,
  joint: number,
  joints: number,
): void {
  const ax = a.x0 + (a.x1 - a.x0) * across;
  const az = a.z0 + (a.z1 - a.z0) * across;
  const bx = b.x0 + (b.x1 - b.x0) * across;
  const bz = b.z0 + (b.z1 - b.z0) * across;
  into.positions.push(ax + (bx - ax) * along, a.y + (b.y - a.y) * along, az + (bz - az) * along);
  into.locals.push((joint + along) / joints, across);
  into.params.push(into.param0, into.param1);
}

/**
 * Cover each sheet in cells no coarser than `cellM`.
 *
 * Vertices are duplicated at cell boundaries rather than shared. That is safe
 * here in a way it would not be in general: every displacement applied to this
 * mesh is a pure function of the resting position, so two vertices at the same
 * place move to the same place and the seam cannot open.
 *
 * `params` is called once per sheet at build time — never per frame — and writes
 * the two floats each of that sheet's vertices carries.
 */
export function buildSheets<T extends { spans: readonly SheetSpan[] }>(
  sheets: readonly T[],
  cellM: number,
  params: (sheet: T, out: Float32Array) => void,
): SheetMesh {
  const into: Accumulator = {
    positions: [],
    locals: [],
    params: [],
    param0: 0,
    param1: 0,
  };
  const scratch = new Float32Array(2);
  const cell = cellM > 0 ? cellM : 0;

  for (const sheet of sheets) {
    const spans = sheet.spans;
    if (cell <= 0 || spans.length < 2) continue;
    scratch[0] = 0;
    scratch[1] = 0;
    params(sheet, scratch);
    into.param0 = scratch[0] ?? 0;
    into.param1 = scratch[1] ?? 0;
    const joints = spans.length - 1;

    for (let s = 0; s < joints; s++) {
      const a = spans[s] as SheetSpan;
      const b = spans[s + 1] as SheetSpan;

      /*
       * How finely this piece has to be cut: the longest edge on each axis, so a
       * widening channel is sampled by its wide end rather than its narrow one.
       */
      const alongLength = Math.max(
        Math.hypot(b.x0 - a.x0, b.z0 - a.z0),
        Math.hypot(b.x1 - a.x1, b.z1 - a.z1),
      );
      const acrossLength = Math.max(
        Math.hypot(a.x1 - a.x0, a.z1 - a.z0),
        Math.hypot(b.x1 - b.x0, b.z1 - b.z0),
      );
      if (!(alongLength > 0) || !(acrossLength > 0)) continue;
      const alongCells = Math.max(1, Math.ceil(alongLength / cell));
      const acrossCells = Math.max(1, Math.ceil(acrossLength / cell));

      for (let i = 0; i < alongCells; i++) {
        const t0 = i / alongCells;
        const t1 = (i + 1) / alongCells;
        for (let j = 0; j < acrossCells; j++) {
          const s0 = j / acrossCells;
          const s1 = (j + 1) / acrossCells;
          // Two triangles per cell, wound counter-clockwise from above so the
          // sheet's front face is its top.
          emitVertex(into, a, b, t0, s0, s, joints);
          emitVertex(into, a, b, t1, s0, s, joints);
          emitVertex(into, a, b, t1, s1, s, joints);
          emitVertex(into, a, b, t0, s0, s, joints);
          emitVertex(into, a, b, t1, s1, s, joints);
          emitVertex(into, a, b, t0, s1, s, joints);
        }
      }
    }
  }

  return {
    positions: new Float32Array(into.positions),
    locals: new Float32Array(into.locals),
    params: new Float32Array(into.params),
    vertexCount: into.positions.length / 3,
  };
}

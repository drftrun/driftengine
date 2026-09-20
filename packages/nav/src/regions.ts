/**
 * Walkable space partitioned into regions, by watershed on a distance field.
 *
 * **A flood fill would say a world is one region, and that is the wrong answer.** Two rooms joined
 * by a corridor one cell wide are connected, so a flood fill gives one region — and the contour of
 * that region wraps through the corridor and back, which simplifies into a shape that crosses
 * itself, which produces a polygon the funnel walks out of. The split has to happen at the
 * corridor, and what marks the corridor is that it is *close to a wall on both sides*.
 *
 * So: distance to the nearest edge, then flood downhill from the local maxima. A room is a basin;
 * a corridor is the watershed between two of them.
 *
 * **A region smaller than the threshold is merged and never left as a hole.** A hole in a
 * navigation mesh is a place an agent refuses to stand for no reason anybody can see, and the
 * smallest ones come from a corner of the voxel field surviving erosion by a cell.
 */
import type { VoxelField } from './voxelise.ts';

const SPAN_STRIDE = 3;
const NONE = -1;

export interface RegionSettings {
  /** A region with fewer spans than this is merged into whichever neighbour it touches most. */
  readonly minRegionSpans: number;
  /** How many cells of height an agent can step across. Beyond it, a floor is a wall. */
  readonly maxStep: number;
}

export interface RegionField {
  /** Which region each span belongs to, by span index. `-1` for an unwalkable span. */
  readonly regionOf: Int32Array;
  readonly count: number;
  /** Flat pairs of region identifiers that touch, ascending and without duplicates. */
  readonly links: Int32Array;
  readonly linkCount: number;
}

/** The index of the `at`-th span in a column, or `-1`. Spans are numbered across the whole field. */
export function spanIndexAt(field: VoxelField, x: number, z: number, at = 0): number {
  if (x < 0 || z < 0 || x >= field.width || z >= field.depth) return NONE;
  const column = x + z * field.width;
  const from = (field.columnStart[column] as number) / SPAN_STRIDE;
  const to = (field.columnStart[column + 1] as number) / SPAN_STRIDE;
  return from + at < to ? from + at : NONE;
}

export function regionOfSpan(regions: RegionField, span: number): number {
  return span < 0 ? NONE : (regions.regionOf[span] ?? NONE);
}

export function regionsLinked(regions: RegionField, a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (let at = 0; at < regions.linkCount; at += 1) {
    if (regions.links[at * 2] === lo && regions.links[at * 2 + 1] === hi) return true;
  }
  return false;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** Every span an agent could step to from this one, appended to `out`. */
function neighboursOf(
  field: VoxelField,
  span: number,
  columnOf: Int32Array,
  maxStep: number,
  out: number[],
): void {
  out.length = 0;
  const column = columnOf[span] as number;
  const x = column % field.width;
  const z = (column - x) / field.width;
  const floor = field.spans[span * SPAN_STRIDE] as number;

  for (const [dx, dz] of NEIGHBOURS) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= field.width || nz >= field.depth) continue;
    const other = nx + nz * field.width;
    const from = (field.columnStart[other] as number) / SPAN_STRIDE;
    const to = (field.columnStart[other + 1] as number) / SPAN_STRIDE;
    for (let at = from; at < to; at += 1) {
      if (field.spans[at * SPAN_STRIDE + 2] !== 1) continue;
      if (Math.abs((field.spans[at * SPAN_STRIDE] as number) - floor) > maxStep) continue;
      out.push(at);
    }
  }
}

/** How many sides of this span lead nowhere an agent could go. */
function borders(
  field: VoxelField,
  span: number,
  columnOf: Int32Array,
  maxStep: number,
  scratch: number[],
): boolean {
  neighboursOf(field, span, columnOf, maxStep, scratch);
  return scratch.length < NEIGHBOURS.length;
}

export function buildRegions(field: VoxelField, settings: RegionSettings): RegionField {
  const spanTotal = field.spans.length / SPAN_STRIDE;
  const regionOf = new Int32Array(spanTotal).fill(NONE);
  if (spanTotal === 0) {
    return { regionOf, count: 0, links: new Int32Array(0), linkCount: 0 };
  }

  /* Which column each span belongs to, so a span index alone is enough to find its neighbours. */
  const columnOf = new Int32Array(spanTotal);
  for (let column = 0; column < field.width * field.depth; column += 1) {
    const from = (field.columnStart[column] as number) / SPAN_STRIDE;
    const to = (field.columnStart[column + 1] as number) / SPAN_STRIDE;
    for (let at = from; at < to; at += 1) columnOf[at] = column;
  }

  const walkable: number[] = [];
  for (let span = 0; span < spanTotal; span += 1) {
    if (field.spans[span * SPAN_STRIDE + 2] === 1) walkable.push(span);
  }
  if (walkable.length === 0) {
    return { regionOf, count: 0, links: new Int32Array(0), linkCount: 0 };
  }

  const distance = distanceField(field, walkable, columnOf, settings.maxStep, spanTotal);

  /*
   * Flood downhill, level by level. At each distance, spans already touching a region join it and
   * spans touching none start their own — which is what makes a local maximum a seed without
   * anybody having to find the maxima first.
   */
  let count = 0;
  const scratch: number[] = [];
  const levels = [...new Set(walkable.map((span) => distance[span] as number))].sort(
    (a, b) => b - a,
  );
  for (const level of levels) {
    const here = walkable.filter((span) => distance[span] === level);
    /* Repeat until nothing more joins, so a whole plateau flows from one seed rather than many. */
    for (let changed = true; changed;) {
      changed = false;
      for (const span of here) {
        if (regionOf[span] !== NONE) continue;
        neighboursOf(field, span, columnOf, settings.maxStep, scratch);
        let found = NONE;
        for (const other of scratch) {
          const region = regionOf[other] as number;
          if (region !== NONE && (found === NONE || region < found)) found = region;
        }
        if (found === NONE) continue;
        regionOf[span] = found;
        changed = true;
      }
    }
    for (const span of here) {
      if (regionOf[span] !== NONE) continue;
      regionOf[span] = count;
      count += 1;
      /* Spread the new region across its own plateau before the next one starts. */
      for (let changed = true; changed;) {
        changed = false;
        for (const other of here) {
          if (regionOf[other] !== NONE) continue;
          neighboursOf(field, other, columnOf, settings.maxStep, scratch);
          if (!scratch.some((n) => regionOf[n] === count - 1)) continue;
          regionOf[other] = count - 1;
          changed = true;
        }
      }
    }
  }

  count = mergeSmall(field, regionOf, columnOf, walkable, count, settings, scratch);
  return linksOf(field, regionOf, columnOf, walkable, count, settings, scratch);
}

/**
 * How far each walkable span is from the nearest edge, in steps.
 *
 * A multi-source breadth-first search from every span that has a side leading nowhere. One is what
 * makes a corridor shallow and a room deep, which is the whole basis of the split.
 */
function distanceField(
  field: VoxelField,
  walkable: readonly number[],
  columnOf: Int32Array,
  maxStep: number,
  spanTotal: number,
): Int32Array {
  const distance = new Int32Array(spanTotal).fill(-1);
  const scratch: number[] = [];
  const queue: number[] = [];
  for (const span of walkable) {
    if (!borders(field, span, columnOf, maxStep, scratch)) continue;
    distance[span] = 1;
    queue.push(span);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const span = queue[head] as number;
    neighboursOf(field, span, columnOf, maxStep, scratch);
    for (const other of scratch) {
      if (distance[other] !== -1) continue;
      distance[other] = (distance[span] as number) + 1;
      queue.push(other);
    }
  }
  /* A span with no border anywhere in its component — a closed torus — is as deep as it gets. */
  for (const span of walkable) {
    if (distance[span] === -1) distance[span] = 1;
  }
  return distance;
}

/** Merge every region below the threshold into whichever neighbour it shares the most edge with. */
function mergeSmall(
  field: VoxelField,
  regionOf: Int32Array,
  columnOf: Int32Array,
  walkable: readonly number[],
  count: number,
  settings: RegionSettings,
  scratch: number[],
): number {
  const sizes = new Int32Array(count);
  for (const span of walkable) sizes[regionOf[span] as number] += 1;

  for (let region = 0; region < count; region += 1) {
    if ((sizes[region] as number) === 0 || (sizes[region] as number) >= settings.minRegionSpans) {
      continue;
    }
    const shared = new Map<number, number>();
    for (const span of walkable) {
      if (regionOf[span] !== region) continue;
      neighboursOf(field, span, columnOf, settings.maxStep, scratch);
      for (const other of scratch) {
        const theirs = regionOf[other] as number;
        if (theirs === region || theirs === NONE) continue;
        shared.set(theirs, (shared.get(theirs) ?? 0) + 1);
      }
    }
    /* Most shared edge wins; the lower identifier breaks a tie, so this is reproducible. */
    let best = NONE;
    let bestShare = 0;
    for (const [other, share] of [...shared].sort(([a], [b]) => a - b)) {
      if (share <= bestShare) continue;
      best = other;
      bestShare = share;
    }
    if (best === NONE) continue;
    for (const span of walkable) {
      if (regionOf[span] === region) regionOf[span] = best;
    }
    sizes[best] = (sizes[best] as number) + (sizes[region] as number);
    sizes[region] = 0;
  }

  /* Close the gaps the merges left, so identifiers stay `0..count - 1`. */
  const remap = new Int32Array(count).fill(NONE);
  let next = 0;
  for (const span of walkable) {
    const region = regionOf[span] as number;
    if (remap[region] === NONE) {
      remap[region] = next;
      next += 1;
    }
    regionOf[span] = remap[region] as number;
  }
  return next;
}

function linksOf(
  field: VoxelField,
  regionOf: Int32Array,
  columnOf: Int32Array,
  walkable: readonly number[],
  count: number,
  settings: RegionSettings,
  scratch: number[],
): RegionField {
  const seen = new Set<number>();
  const pairs: number[] = [];
  for (const span of walkable) {
    const mine = regionOf[span] as number;
    neighboursOf(field, span, columnOf, settings.maxStep, scratch);
    for (const other of scratch) {
      const theirs = regionOf[other] as number;
      if (theirs === mine || theirs === NONE) continue;
      const lo = Math.min(mine, theirs);
      const hi = Math.max(mine, theirs);
      const key = lo * count + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(lo, hi);
    }
  }
  return {
    regionOf,
    count,
    links: Int32Array.from(pairs),
    linkCount: pairs.length / 2,
  };
}

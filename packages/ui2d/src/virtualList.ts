/**
 * Which rows a scroll offset makes visible, so that a list costs a screenful rather than a list.
 *
 * An asset browser with ten thousand entries has to cost what a screenful costs. Without this the
 * scene tree is unusable the first time somebody opens a real project, which is the moment nobody
 * wants to discover it.
 *
 * **Overscan is applied before clamping, not after.** Applied after, a window near either end
 * runs past the row count and a caller indexes rows that do not exist.
 */
export interface RowWindow {
  first: number;
  count: number;
}

function clampWindow(first: number, lastExclusive: number, rowCount: number): RowWindow {
  const lo = Math.max(0, Math.min(rowCount, first));
  const hi = Math.max(lo, Math.min(rowCount, lastExclusive));
  return { first: lo, count: hi - lo };
}

/** Uniform row heights, which is arithmetic. */
export function visibleRange(
  scrollY: number,
  viewHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan: number,
): RowWindow {
  if (rowHeight <= 0 || rowCount <= 0) return { first: 0, count: 0 };
  const top = Math.max(0, scrollY);
  const first = Math.floor(top / rowHeight) - overscan;
  const lastExclusive = Math.ceil((top + viewHeight) / rowHeight) + overscan;
  return clampWindow(first, lastExclusive, rowCount);
}

/**
 * Variable row heights, through a prefix-sum table of row tops the caller owns.
 *
 * **The caller owns the table** because only the caller knows when a row's height changed, and
 * recomputing it here every frame would be the cost this module exists to avoid. `offsets` holds
 * `rowCount + 1` entries: the top of each row, then the bottom of the last.
 */
export function visibleRangeVariable(
  scrollY: number,
  viewHeight: number,
  offsets: Float64Array,
  rowCount: number,
  overscan: number,
): RowWindow {
  if (rowCount <= 0) return { first: 0, count: 0 };
  const top = Math.max(0, scrollY);
  const bottom = top + viewHeight;

  /* Largest index whose top is at or before the window's top. */
  let lo = 0;
  let hi = rowCount;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= top) lo = mid;
    else hi = mid - 1;
  }
  const first = lo - overscan;

  /* Smallest index whose top is at or after the window's bottom. */
  let a = 0;
  let b = rowCount;
  while (a < b) {
    const mid = (a + b) >> 1;
    if ((offsets[mid] ?? 0) >= bottom) b = mid;
    else a = mid + 1;
  }
  return clampWindow(first, a + overscan, rowCount);
}

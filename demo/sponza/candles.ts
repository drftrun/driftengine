/**
 * Which of the pack's candles stay: a share of them, scattered as the file scattered them, and none
 * in the camera's path.
 *
 * **Ten thousand read as clutter.** Intel's pack hangs them everywhere from 0.7 m to 11 m, so every
 * shot after dusk looked through a curtain of wax. A fifth keeps the spell and lets the courtyard be
 * seen through it. The share is chosen by a hash of each candle's place in the file, so it is the
 * same candles on every load and they thin evenly rather than by region.
 *
 * **A candle is decided by its light**, the one position its three parts (wax, wick and flame, each
 * with its own prototype and centre) agree on. The answer is a test on a point: the packs ask it of
 * every copy of every part, and the fires ask it of every light, so a candle loses its geometry and
 * its light together or neither.
 */

type Point = { readonly position: readonly [number, number, number] };

/** Whether candle `index` is in the kept share: an integer hash of the index, spread over [0, 1). */
function kept(index: number, share: number): boolean {
  return (Math.imul(index + 1, 2654435761) >>> 0) / 4294967296 < share;
}

/**
 * A test for whether a point belongs to a candle that goes: its nearest candle light, within
 * `sizeM`, is outside the kept `share` or stands where `inPath` says the camera flies.
 *
 * **The nearest, not any within reach.** The arcades hold a candle every half metre or so, and a
 * first version that dropped a point near *any* dropped light took nearly every kept candle with its
 * neighbours: a fifth asked for, almost none left. A candle's wax is a hand below its flame, nearer
 * its own light than any other's, so the nearest is its own.
 */
export function candlesThatGo(
  candles: readonly Point[],
  share: number,
  inPath: (x: number, y: number, z: number) => boolean,
  sizeM: number,
): (x: number, y: number, z: number) => boolean {
  /* Every light by cell, a cell a candle wide, so a point's candidates are in its own 27 cells. The
     fourth number of each entry is 1 where that candle goes. */
  const cells = new Map<number, number[]>();
  const cellOf = (v: number): number => Math.floor(v / sizeM) + 1024;
  const key = (i: number, j: number, k: number): number => (i * 2048 + j) * 2048 + k;
  candles.forEach(({ position: [x, y, z] }, index) => {
    const goes = kept(index, share) && !inPath(x, y, z) ? 0 : 1;
    const at = key(cellOf(x), cellOf(y), cellOf(z));
    const list = cells.get(at);
    if (list === undefined) cells.set(at, [x, y, z, goes]);
    else list.push(x, y, z, goes);
  });
  return (x, y, z) => {
    const i = cellOf(x);
    const j = cellOf(y);
    const k = cellOf(z);
    let nearest = sizeM * sizeM;
    let goes = false;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          const list = cells.get(key(i + di, j + dj, k + dk));
          if (list === undefined) continue;
          for (let n = 0; n < list.length; n += 4) {
            const dx = x - (list[n] as number);
            const dy = y - (list[n + 1] as number);
            const dz = z - (list[n + 2] as number);
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < nearest) {
              nearest = d2;
              goes = list[n + 3] === 1;
            }
          }
        }
      }
    }
    return goes;
  };
}

/**
 * Where things spaced along a whole street stand: a lantern string or a sign span every `gap`
 * metres of the street, counted along it across the junctions that cut it into blocks.
 *
 * **Carried across the blocks, not restarted at each.** The scripts give the spacing per street
 * (`propSpacing` times `propLanternFactor`: two hundred metres on the neon streets), and a street
 * here is a run of block-long segments. Counted afresh on each, a span wanted half a gap in — a
 * hundred metres — and the neon blocks are shorter than that, so the whole district had one sign
 * span and two lantern strings. A stop that falls inside a junction's clearance waits for the next
 * block's start.
 */

export interface LineRun {
  /** Which street line the run is on: runs sharing it are counted together. */
  readonly line: string;
  readonly from: number;
  readonly to: number;
}

/** Each stop, as the index of the run it stands on and how far along. */
export function lineStops(runs: readonly LineRun[], gap: number): { run: number; along: number }[] {
  const order = runs
    .map((r, i) => i)
    .sort((a, b) => {
      const ra = runs[a] as LineRun;
      const rb = runs[b] as LineRun;
      return ra.line === rb.line ? ra.from - rb.from : ra.line < rb.line ? -1 : 1;
    });
  const next = new Map<string, number>();
  const out: { run: number; along: number }[] = [];
  for (const i of order) {
    const r = runs[i] as LineRun;
    let along = Math.max(r.from, next.get(r.line) ?? r.from + gap / 2);
    for (; along < r.to; along += gap) out.push({ run: i, along });
    next.set(r.line, along);
  }
  return out;
}

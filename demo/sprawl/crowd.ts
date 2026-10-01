/**
 * The crowd about the walker: 470 people (`npcCrowdCount`) wandering the pavements near it, each
 * of a kind drawn by weight in one of its palettes, as the reference keeps an ambient crowd round
 * its player whatever hour the residents keep.
 *
 * **One that falls further behind than `RADIUS` is set down again** at a corner between `NEAR` and
 * `RADIUS` away, so the crowd follows the walker without anyone appearing at its feet.
 *
 * What gives: where it is set down may be in view, where the reference's may not; at 60 m it is a
 * figure a few pixels tall arriving at a corner.
 */
import type { PersonRow } from './data/life';
import type { PavementGraph } from './pavements';
import { pickWeighted } from './residents';
import type { Walkers } from './walkers';

/** How far about the walker the crowd keeps, and how near one is set down: ours. */
export const RADIUS = 140;
const NEAR = 60;

export class Crowd {
  readonly kind: Uint8Array;
  readonly palette: Uint8Array;
  private placed = false;

  constructor(
    private readonly walkers: Walkers,
    /** The crowd's first index among the walkers, and how many it is. */
    readonly first: number,
    readonly count: number,
    rows: readonly PersonRow[],
    private readonly graph: PavementGraph,
    private readonly random: () => number,
  ) {
    this.kind = new Uint8Array(count);
    this.palette = new Uint8Array(count);
    for (let c = 0; c < count; c++) {
      const k = pickWeighted(rows, (r) => r.weight, random());
      const row = rows[k] as PersonRow;
      this.kind[c] = k;
      this.palette[c] = pickWeighted(row.palettes, (p) => p.weight, random());
      walkers.speed[first + c] = row.speed[0] + random() * (row.speed[1] - row.speed[0]);
    }
  }

  /** Keep the crowd about (x, z): at first all of it, then whoever has fallen too far behind. */
  step(x: number, z: number): void {
    const w = this.walkers;
    for (let c = 0; c < this.count; c++) {
      const i = this.first + c;
      const far = ((w.x[i] as number) - x) ** 2 + ((w.z[i] as number) - z) ** 2 > RADIUS * RADIUS;
      if (this.placed && !far) continue;
      this.setDown(i, x, z);
    }
    this.placed = true;
  }

  /**
   * Set walker `i` down on a pavement: anywhere within the radius at first, afterwards beyond the
   * near ring — the first of a few draws that lands inside it, else the last.
   */
  private setDown(i: number, x: number, z: number): void {
    const g = this.graph;
    for (let tries = 0; tries < 6; tries++) {
      const r = this.placed ? NEAR + this.random() * (RADIUS - NEAR) : this.random() * RADIUS;
      const a = this.random() * 2 * Math.PI;
      const n = g.nearest(x + Math.sin(a) * r, z + Math.cos(a) * r);
      const lo = g.first[n] as number;
      const count = (g.first[n + 1] as number) - lo;
      if (count === 0) continue;
      const m = g.next[lo + Math.floor(this.random() * count)] as number;
      const f = this.random();
      const px = (g.x[n] as number) + ((g.x[m] as number) - (g.x[n] as number)) * f;
      const pz = (g.z[n] as number) + ((g.z[m] as number) - (g.z[n] as number)) * f;
      if ((px - x) ** 2 + (pz - z) ** 2 <= RADIUS * RADIUS || tries === 5) {
        this.walkers.setDown(i, n, m, f);
        return;
      }
    }
  }
}

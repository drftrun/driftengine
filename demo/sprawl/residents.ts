/**
 * The city's residents going about their days: each of a kind drawn by weight, wearing one of its
 * palettes, with a home, a workplace and a favourite place of the kinds its job names, within the
 * job's radii. **At each step of the job's day** — its hour moved once by a draw within the step's
 * jitter — a resident walks to the step's place and goes in, or, as often as the step's `outside`
 * says, stays out front until the next.
 *
 * At most `TRIPS_PER_STEP` trips begin in one tick, so a shift change spreads over a few ticks
 * rather than routing thousands in one.
 *
 * What gives: a step's dwell is not kept apart from the next step's hour; a home is any home in
 * the city rather than one in the districts the kind's weights favour; and the day starts with
 * everyone already where its hour puts them, indoors.
 */
import type { JobRow, PersonRow } from './data/life';
import type { Places } from './places';
import type { Walkers } from './walkers';

/** Most steps any job's day has. */
const MAX_STEPS = 8;
const TRIPS_PER_STEP = 8;

export class Residents {
  /** Each resident's kind among the rows, its palette, and whether it is out where it can be seen. */
  readonly kind: Uint8Array;
  readonly palette: Uint8Array;
  readonly shown: Uint8Array;
  private readonly job: Uint8Array;
  private readonly home: Int32Array;
  private readonly work: Int32Array;
  private readonly favorite: Int32Array;
  private readonly at: Float32Array;
  private readonly cur: Int8Array;
  private readonly nextAt: Float64Array;
  private readonly jobs: readonly JobRow[];
  private day = 0;
  private last = -1;

  constructor(
    private readonly walkers: Walkers,
    readonly count: number,
    private readonly rows: readonly PersonRow[],
    jobs: Readonly<Record<string, JobRow>>,
    private readonly places: Places,
    private readonly random: () => number,
    hour: number,
  ) {
    const names = Object.keys(jobs);
    this.jobs = names.map((n) => jobs[n] as JobRow);
    this.kind = new Uint8Array(count);
    this.palette = new Uint8Array(count);
    this.shown = new Uint8Array(count);
    this.job = new Uint8Array(count);
    this.home = new Int32Array(count);
    this.work = new Int32Array(count);
    this.favorite = new Int32Array(count);
    this.at = new Float32Array(count * MAX_STEPS);
    this.cur = new Int8Array(count);
    this.nextAt = new Float64Array(count);
    this.last = hour;
    for (let i = 0; i < count; i++) {
      const k = pickWeighted(rows, (r) => r.weight, random());
      const row = rows[k] as PersonRow;
      this.kind[i] = k;
      this.palette[i] = pickWeighted(row.palettes, (p) => p.weight, random());
      walkers.speed[i] = row.speed[0] + random() * (row.speed[1] - row.speed[0]);
      const j = Math.max(0, names.indexOf(row.job));
      this.job[i] = j;
      const job = this.jobs[j] as JobRow;
      const home = places.pick(job.home, 0, 0, Infinity, random());
      const hx = places.x[home] ?? 0;
      const hz = places.z[home] ?? 0;
      this.home[i] = home;
      this.work[i] = places.pick(job.work, hx, hz, job.workRadius, random());
      this.favorite[i] = places.pick(job.favorite, hx, hz, job.favoriteRadius, random());
      job.steps.forEach((s, n) => {
        this.at[i * MAX_STEPS + n] = s.hour + (random() * 2 - 1) * s.jitter;
      });
      /* Where the hour finds it: the last step begun, or yesterday's last. */
      let now = job.steps.length - 1;
      for (let n = 0; n < job.steps.length; n++)
        if ((this.at[i * MAX_STEPS + n] as number) <= hour) now = n;
      this.cur[i] = now;
      const v = this.placeOf(i, now, hx, hz);
      walkers.standAt(i, places.x[v] ?? hx, places.z[v] ?? hz, places.node[v] ?? 0);
      this.nextAt[i] = this.after(i, now, hour);
    }
  }

  /** Begin the trips whose hour has come, and see who has reached its door; `hour` is the clock's. */
  step(hour: number): void {
    if (hour < this.last - 12) this.day++;
    this.last = hour;
    const now = this.day * 24 + hour;
    let begun = 0;
    const walkers = this.walkers;
    for (let i = 0; i < this.count; i++) {
      if (walkers.arrived[i] === 1) {
        walkers.arrived[i] = 0;
        const step = (this.jobs[this.job[i] as number] as JobRow).steps[this.cur[i] as number];
        this.shown[i] = this.random() < (step?.outside ?? 0) ? 1 : 0;
      }
      if (begun >= TRIPS_PER_STEP || now < (this.nextAt[i] as number)) continue;
      const steps = (this.jobs[this.job[i] as number] as JobRow).steps;
      const n = ((this.cur[i] as number) + 1) % steps.length;
      const v = this.placeOf(i, n, walkers.x[i] as number, walkers.z[i] as number);
      this.cur[i] = n;
      this.nextAt[i] = this.day * 24 + this.after(i, n, hour);
      if (v < 0) continue;
      walkers.go(
        i,
        this.places.node[v] as number,
        this.places.x[v] as number,
        this.places.z[v] as number,
      );
      this.shown[i] = 1;
      begun++;
    }
  }

  /** Where step `n` of resident `i`'s day is, seen from (x, z). */
  private placeOf(i: number, n: number, x: number, z: number): number {
    const step = (this.jobs[this.job[i] as number] as JobRow).steps[n];
    switch (step?.place) {
      case 'PlaceWork':
        return this.work[i] as number;
      case 'PlaceFavorite':
        return this.favorite[i] as number;
      case 'PlaceKind':
        return this.places.pick(step.kind, x, z, step.radius, this.random());
      default:
        return this.home[i] as number;
    }
  }

  /** The hour of the step after `n`, on the clock of the day `hour` is in: past midnight, +24. */
  private after(i: number, n: number, hour: number): number {
    const steps = (this.jobs[this.job[i] as number] as JobRow).steps;
    const m = (n + 1) % steps.length;
    const at = this.at[i * MAX_STEPS + m] as number;
    return m <= n || at < hour ? at + 24 : at;
  }
}

/** The index `u` in [0, 1) lands on, each item as likely as its weight. */
export function pickWeighted<T>(
  items: readonly T[],
  weight: (item: T) => number,
  u: number,
): number {
  let total = 0;
  for (const item of items) total += weight(item);
  let pick = u * total;
  for (let i = 0; i < items.length; i++) {
    pick -= weight(items[i] as T);
    if (pick < 0) return i;
  }
  return items.length - 1;
}

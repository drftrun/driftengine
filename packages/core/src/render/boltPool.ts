import { hashToUnit } from '../core/rng.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * A pool of short-lived electrical arcs — lightning, and anything else that
 * strikes between two points and crackles while it lasts.
 *
 * The simulation half only, exactly like `ParticlePool`: this class holds no GL
 * resources, so it is testable without a context, and the drawing lives in
 * `BoltBatch` where the standing rule says WebGL belongs. What comes out is a
 * flat array of *segment endpoints*, which is the one thing a ribbon of quads
 * needs and the one thing a caller can check.
 *
 * **It advances rather than evaluates, so it is for real-time scenes only.** `update(dt)` steps
 * an internal cursor, which means the same plan stepped by two different sequences of `dt`
 * produces different arcs. A consumer that renders one plan twice, once against a wall clock for
 * a preview and once against a frame index for an export, cannot make the two agree. Reported
 * from outside, alongside the observation that `PlumeRenderer.draw` has the signature that does
 * work: it takes the time to *evaluate at* rather than a step to advance by, so the same second
 * draws the same smoke however the frames were spaced. A stateless variant here is not built.
 *
 * A bolt is a jagged polyline between its two ends, and the jaggedness is
 * **re-drawn while it lives** rather than animated. That is what separates
 * lightning from a wire: real arcs do not bend smoothly, they are replaced, many
 * times a second, by a different path between the same two points. Interpolating
 * node positions produces a wobbling snake, which reads as a rope or a tentacle;
 * re-striking produces the crackle.
 *
 * Displacement is mid-point subdivision, seeded, so a replay strikes the same
 * bolts the run did. Nothing here reads a clock or `Math.random`.
 */
export interface BoltPoolOptions {
  /** How many arcs may be alive at once. */
  capacity: number;
  /**
   * Nodes per arc, both ends included. Must be `2^k + 1` so mid-point
   * subdivision lands exactly on it; anything else is rounded up to the next.
   */
  nodes: number;
  /** Seconds an arc lives. */
  lifeSec: number;
  /** How far a node may wander off the straight line, as a share of the span. */
  jitter: number;
  /** How many times a second a live arc re-draws its path. */
  restrikeHz: number;
}

/** One arc's worth of geometry, as the caller reads it back. */
/**
 * The arcs a batch draws, as plain arrays with a live count.
 *
 * **Fillable from outside, and that is the answer to wanting bolts without a pool.** `BoltPool`
 * advances rather than evaluates, so it cannot serve a consumer that renders one plan twice, once
 * against a wall clock and once against a frame index, and expects the same pixels. Nothing here
 * requires the pool: write `from`, `to`, `along`, `fade`, `seed` and `brightness` from any
 * function of a seed and an absolute time, set `count`, and hand it to the batch. That is exactly
 * the route a consumer already took with `ParticleInstances`, and it works for the same reason:
 * the *material* is the valuable half and it is separable from whatever decides where things are.
 *
 * Reported from outside, where the pool's own note that a stateless variant is not built read as
 * "there is no way to do this" rather than "there is no second pool". There is no second pool and
 * none is needed.
 */
export interface BoltSegments {
  /** `from` and `to` per segment, three floats each, live segments first. */
  from: Float32Array;
  to: Float32Array;
  /** Per segment: normalised distance along its arc, and the arc's own fade. */
  along: Float32Array;
  fade: Float32Array;
  /** Per segment: the arc's seed, and how bright the caller asked for it. */
  seed: Float32Array;
  brightness: Float32Array;
  /** How many segments of the above are live. */
  count: number;
  capacity: number;
}

/** Round up to the next `2^k + 1`, the node count subdivision lands on exactly. */
function subdivisionNodes(want: number): number {
  let spans = 1;
  while (spans + 1 < want) spans *= 2;
  return spans + 1;
}

export class BoltPool {
  readonly segments: BoltSegments;

  private readonly nodeCount: number;
  private readonly segmentsPerBolt: number;
  /** Node positions, `capacity * nodeCount * 3`. */
  private readonly nodes: Float32Array;
  /** Both ends, held so a re-strike draws a new path between the same points. */
  private readonly ends: Float32Array;
  private readonly age: Float32Array;
  /** Per-arc lifetime, so a volley is not a row of identically-timed flashes. */
  private readonly life: Float32Array;
  private readonly seed: Float32Array;
  private readonly brightness: Float32Array;
  /** Seconds until this arc re-draws its path. */
  private readonly restrike: Float32Array;
  private next = 0;

  constructor(private readonly options: BoltPoolOptions) {
    const { capacity } = options;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('A bolt pool needs a positive integer capacity.');
    }
    if (options.lifeSec <= 0) throw new Error('Bolts need a positive lifetime.');
    if (options.nodes < 3) throw new Error('A bolt needs at least three nodes.');
    this.nodeCount = subdivisionNodes(options.nodes);
    this.segmentsPerBolt = this.nodeCount - 1;

    const total = capacity * this.segmentsPerBolt;
    this.nodes = new Float32Array(capacity * this.nodeCount * 3);
    this.ends = new Float32Array(capacity * 6);
    this.age = new Float32Array(capacity).fill(Infinity);
    this.life = new Float32Array(capacity).fill(options.lifeSec);
    this.seed = new Float32Array(capacity);
    this.brightness = new Float32Array(capacity);
    this.restrike = new Float32Array(capacity);
    this.segments = {
      from: new Float32Array(total * 3),
      to: new Float32Array(total * 3),
      along: new Float32Array(total),
      fade: new Float32Array(total),
      seed: new Float32Array(total),
      brightness: new Float32Array(total),
      count: 0,
      capacity: total,
    };
  }

  /** How many arcs are alive. */
  get live(): number {
    let count = 0;
    for (let i = 0; i < this.age.length; i++) {
      if ((this.age[i] as number) < (this.life[i] as number)) count++;
    }
    return count;
  }

  /**
   * Strike an arc between two points.
   *
   * `seed` drives the path instead of `Math.random`, so a caller inside a
   * deterministic system can pass a tick count and get the same lightning twice.
   */
  strike(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    seed: number,
    brightness = 1,
    /**
     * Multiplier on the pool's lifetime for this arc alone.
     *
     * A volley of arcs that all die on the same frame reads as one object being
     * switched off, which is the most predictable thing a flash can do. Varying it
     * per strike is the cheapest way to make a burst decay like several discharges.
     */
    lifeScale = 1,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.options.capacity;
    const e = i * 6;
    this.ends[e] = x0;
    this.ends[e + 1] = y0;
    this.ends[e + 2] = z0;
    this.ends[e + 3] = x1;
    this.ends[e + 4] = y1;
    this.ends[e + 5] = z1;
    this.age[i] = 0;
    this.life[i] = this.options.lifeSec * lifeScale;
    this.seed[i] = seed;
    this.brightness[i] = brightness;
    this.restrike[i] = 0;
    this.drawPath(i, seed);
  }

  /**
   * Age every arc, re-strike the ones whose path is due, and rebuild the
   * segment arrays.
   *
   * Compacting as it goes, like the particle pool: live segments are written to
   * the front, so a draw submits exactly the live count and a dead arc costs one
   * loop iteration.
   */
  update(dt: number): void {
    const o = this.options;
    const out = this.segments;
    const restrikeEvery = o.restrikeHz > 0 ? 1 / o.restrikeHz : Infinity;
    let count = 0;

    for (let i = 0; i < this.age.length; i++) {
      const age = this.age[i] as number;
      const life = this.life[i] as number;
      if (age >= life) continue;
      const next = age + dt;
      if (next >= life) {
        this.age[i] = life;
        continue;
      }
      this.age[i] = next;

      let due = (this.restrike[i] as number) - dt;
      if (due <= 0) {
        /*
         * A fresh path between the same two ends. The seed advances with the
         * strike count so consecutive paths differ, and it stays a pure function
         * of the arc's own seed and how many times it has been redrawn — nothing
         * a replay cannot reproduce.
         */
        due += restrikeEvery;
        this.drawPath(i, (this.seed[i] as number) + Math.round(next * o.restrikeHz) * 31.7);
      }
      this.restrike[i] = due;

      /*
       * Fade is the arc's own envelope: a fast attack to full and a longer decay,
       * because that is the shape of a discharge and a linear fade reads as a
       * light being turned down. Squared on the way out so the tail is short.
       */
      const t = next / life;
      const fade = t < ATTACK ? t / ATTACK : 1 - ((t - ATTACK) / (1 - ATTACK)) ** 2;
      const base = i * this.nodeCount * 3;
      for (let s = 0; s < this.segmentsPerBolt; s++) {
        const a = base + s * 3;
        const b = a + 3;
        const w = count * 3;
        out.from[w] = this.nodes[a] as number;
        out.from[w + 1] = this.nodes[a + 1] as number;
        out.from[w + 2] = this.nodes[a + 2] as number;
        out.to[w] = this.nodes[b] as number;
        out.to[w + 1] = this.nodes[b + 1] as number;
        out.to[w + 2] = this.nodes[b + 2] as number;
        out.along[count] = (s + 0.5) / this.segmentsPerBolt;
        out.fade[count] = fade;
        out.seed[count] = this.seed[i] as number;
        out.brightness[count] = this.brightness[i] as number;
        count++;
      }
    }
    out.count = count;
  }

  /** Drop everything, for a respawn or a scene change. */
  clear(): void {
    this.age.fill(Infinity);
    this.segments.count = 0;
    this.next = 0;
  }

  /**
   * Lay one arc's nodes out: the straight line, then mid-point displacement.
   *
   * Displacement is perpendicular to the span and halves with each subdivision,
   * which is what gives an arc detail at every scale instead of one big zigzag —
   * the same construction a fractal terrain uses, in one dimension. The ends
   * never move, because they are where the arc was asked to strike.
   */
  private drawPath(index: number, seed: number): void {
    /*
     * Integer seed for the mixer. Truncating is deliberate: the caller's seed is a tick
     * count plus strides, so its integer part already carries every bit of the variation
     * and a mixer wants an integer.
     */
    const intSeed = seed | 0;
    const e = index * 6;
    const x0 = this.ends[e] as number;
    const y0 = this.ends[e + 1] as number;
    const z0 = this.ends[e + 2] as number;
    const x1 = this.ends[e + 3] as number;
    const y1 = this.ends[e + 4] as number;
    const z1 = this.ends[e + 5] as number;
    const base = index * this.nodeCount * 3;
    const last = this.nodeCount - 1;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const span = Math.hypot(dx, dy, dz) || 1;
    // Two directions across the span, so displacement is not stuck in a plane.
    const ax = Math.abs(dy) < 0.9 * span ? 0 : 1;
    let px = ax === 0 ? -dz : dy;
    let py = ax === 0 ? 0 : -dx;
    let pz = ax === 0 ? dx : 0;
    let plen = Math.hypot(px, py, pz) || 1;
    px /= plen;
    py /= plen;
    pz /= plen;
    // The third axis of the frame, so the two offsets are independent.
    const qx = (dy / span) * pz - (dz / span) * py;
    const qy = (dz / span) * px - (dx / span) * pz;
    const qz = (dx / span) * py - (dy / span) * px;

    for (let n = 0; n <= last; n++) {
      const t = n / last;
      const o = base + n * 3;
      this.nodes[o] = x0 + dx * t;
      this.nodes[o + 1] = y0 + dy * t;
      this.nodes[o + 2] = z0 + dz * t;
    }

    /*
     * Roughness and persistence, both drawn from the arc's own seed.
     *
     * Without these every path is the *same shape* differently placed: one fixed jitter
     * and one fixed halving per level give every arc an identical fractal character, and
     * the eye reads character long before it reads position. `jitter` becomes the mean
     * of a range, and how fast the displacement decays per subdivision varies too — a
     * low persistence gives one big lazy kink, a high one gives a dense crackle, and
     * mixing them is what makes a volley look like several unrelated discharges.
     */
    const roughness = 0.45 + hashToUnit(intSeed + 31337) * 1.5;
    const persistence = 0.36 + hashToUnit(intSeed + 6971) * 0.34;
    const reach = span * this.options.jitter * roughness;
    let stride = last;
    let amplitude = reach;
    while (stride > 1) {
      const half = stride >> 1;
      for (let n = half; n < last; n += stride) {
        const o = base + n * 3;
        const lo = base + (n - half) * 3;
        const hi = base + (n + half) * 3;
        // The mid-point of its two neighbours, displaced across the span.
        const mx = ((this.nodes[lo] as number) + (this.nodes[hi] as number)) * 0.5;
        const my = ((this.nodes[lo + 1] as number) + (this.nodes[hi + 1] as number)) * 0.5;
        const mz = ((this.nodes[lo + 2] as number) + (this.nodes[hi + 2] as number)) * 0.5;
        const u = hashToUnit(intSeed + n * 6151) * 2 - 1;
        const v = hashToUnit(intSeed + n * 7919 + 104729) * 2 - 1;
        this.nodes[o] = mx + (px * u + qx * v) * amplitude;
        this.nodes[o + 1] = my + (py * u + qy * v) * amplitude;
        this.nodes[o + 2] = mz + (pz * u + qz * v) * amplitude;
      }
      stride = half;
      amplitude *= persistence;
    }
  }
}

/**
 * Share of the lifetime spent rising to full brightness.
 *
 * Almost none. A discharge is *already* at full brightness by the time anything can
 * see it — the rise is microseconds — so an attack long enough to perceive reads as a
 * lamp being switched on. What the eye actually reads as lightning is an instant onset
 * and a decay, and this being too slow was part of why the first version looked like
 * drawn lines rather than flashes.
 */
const ATTACK = 0.04;

/** A hot core and an outer glow, as a caller-facing pair. */
export interface BoltColors {
  core: Vec3;
  edge: Vec3;
}

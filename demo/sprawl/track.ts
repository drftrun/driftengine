/**
 * A monorail line's track: a closed polyline measured by arc length, where a point and a heading
 * are found at any distance along it, and **the fastest a train may be anywhere on it** — what a
 * corner allows at the line's lateral limit, `√(a · r)`, and no more than can still be braked for,
 * at the line's braking, by every tighter piece ahead, all the way round the loop. The limit is
 * continuous, so a train holding to it never brakes harder than its line's figure.
 *
 * A corner's radius is read from its samples: a run of short pieces each turning a little, the
 * radius a piece's length over the angle it turns. What would make that wrong is a corner sampled
 * in pieces longer than `CORNER_PIECE`, which would be read as straights.
 */
/** A piece shorter than this is part of a corner's arc; a longer one is a straight. */
const CORNER_PIECE = 10;

export class Track {
  readonly length: number;
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Distance along the track at each point. */
  readonly along: Float32Array;
  /** Each piece's own limit — its corner's, or the cruise — and the fastest at its start that
      can still brake for everything ahead. */
  readonly cap: Float32Array;
  readonly limit: Float32Array;

  constructor(
    points: readonly number[],
    curveAccel: number,
    private readonly brake: number,
    cruise: number,
  ) {
    /* Closed: a last point equal to the first is dropped, the loop closes itself. */
    let n = points.length / 3;
    const same = (a: number, b: number): boolean =>
      Math.abs((points[a * 3] as number) - (points[b * 3] as number)) < 1e-3 &&
      Math.abs((points[a * 3 + 2] as number) - (points[b * 3 + 2] as number)) < 1e-3;
    if (n > 1 && same(0, n - 1)) n--;
    this.count = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.along = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      this.x[i] = points[i * 3] as number;
      this.y[i] = points[i * 3 + 1] as number;
      this.z[i] = points[i * 3 + 2] as number;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.along[i + 1] =
        (this.along[i] as number) +
        Math.hypot(
          (this.x[j] as number) - (this.x[i] as number),
          (this.z[j] as number) - (this.z[i] as number),
        );
    }
    this.length = this.along[n] as number;
    /* A corner's radius at each point, from its turn and the piece after it. A corner piece takes
       the tighter of its two ends, so a tangent point, half a step onto a straight, reads right. */
    const radius = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n;
      const q = (i + 1) % n;
      const a1 = Math.atan2(
        (this.x[i] as number) - (this.x[p] as number),
        (this.z[i] as number) - (this.z[p] as number),
      );
      const a2 = Math.atan2(
        (this.x[q] as number) - (this.x[i] as number),
        (this.z[q] as number) - (this.z[i] as number),
      );
      const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      radius[i] = turn < 1e-4 ? Infinity : this.pieceLength(i) / turn;
    }
    this.cap = new Float32Array(n);
    this.limit = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r =
        this.pieceLength(i) < CORNER_PIECE
          ? Math.min(radius[i] as number, radius[(i + 1) % n] as number)
          : Infinity;
      this.cap[i] = Math.min(cruise, Math.sqrt(curveAccel * r));
      this.limit[i] = this.cap[i] as number;
    }
    /* Backward round the loop twice: the fastest at each piece's start that can still brake for
       every piece ahead. */
    for (let pass = 0; pass < 2; pass++) {
      for (let k = n - 1; k >= 0; k--) {
        const next = this.limit[(k + 1) % n] as number;
        const reach = Math.sqrt(next * next + 2 * brake * this.pieceLength(k));
        this.limit[k] = Math.min(this.cap[k] as number, reach);
      }
    }
  }

  /** The piece of track `s` lies on, and how far into it; `s` wraps round the loop. */
  pieceAt(s: number): number {
    const at = ((s % this.length) + this.length) % this.length;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.along[mid] as number) <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The limit at `s`: its piece's own, and no more than can still be braked for by the next
   * piece's start — continuous along the track, so a train that holds to it never has to brake
   * harder than its line's figure.
   */
  limitAt(s: number): number {
    const i = this.pieceAt(s);
    const at = ((s % this.length) + this.length) % this.length;
    const left = this.pieceLength(i) - (at - (this.along[i] as number));
    const next = this.limit[(i + 1) % this.count] as number;
    return Math.min(this.cap[i] as number, Math.sqrt(next * next + 2 * this.brake * left));
  }

  /** Where `s` is, into `out`: x, y, z, then the unit heading's x and z. */
  pointAt(s: number, out: Float32Array): void {
    const i = this.pieceAt(s);
    const j = (i + 1) % this.count;
    const at = ((s % this.length) + this.length) % this.length;
    const len = (this.along[i + 1] as number) - (this.along[i] as number);
    const f = len > 0 ? (at - (this.along[i] as number)) / len : 0;
    const dx = (this.x[j] as number) - (this.x[i] as number);
    const dz = (this.z[j] as number) - (this.z[i] as number);
    out[0] = (this.x[i] as number) + dx * f;
    out[1] = (this.y[i] as number) + ((this.y[j] as number) - (this.y[i] as number)) * f;
    out[2] = (this.z[i] as number) + dz * f;
    out[3] = len > 0 ? dx / len : 0;
    out[4] = len > 0 ? dz / len : 1;
  }

  private pieceLength(i: number): number {
    return (this.along[i + 1] as number) - (this.along[i] as number);
  }
}

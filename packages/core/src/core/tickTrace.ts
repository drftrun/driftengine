/**
 * What a fixed-step simulation produced, tick by tick.
 *
 * Replaying a recorded run means re-running the simulation, which is far too
 * expensive to do inside a frame and cannot be seeked into at all — an intent
 * stream has no keyframes, so reaching tick 4,000 means running the four
 * thousand before it. Running it *once*, up front, and keeping what each tick
 * produced turns a replay from a simulation into a lookup.
 *
 * A flat `Float32Array` of `channels` values per tick, plus one byte of flags for
 * the booleans that would otherwise cost four bytes each. Preallocate with
 * `capacity` when the length is known — a caller replaying a recording always
 * knows it — and nothing reallocates while the simulation is running.
 */
export interface TickTraceLike {
  readonly length: number;
  readonly channels: number;
  sample(tick: number, out: Float32Array): void;
  flagsAt(tick: number): number;
  channelAt(tick: number, channel: number): number;
  tickAtOrBefore(channel: number, value: number): number;
}

export class TickTrace implements TickTraceLike {
  readonly channels: number;

  private values: Float32Array;
  private flags: Uint8Array;
  private count = 0;

  constructor(channels: number, capacity = 256) {
    this.channels = Math.max(1, channels | 0);
    const slots = Math.max(1, capacity | 0);
    this.values = new Float32Array(slots * this.channels);
    this.flags = new Uint8Array(slots);
  }

  get length(): number {
    return this.count;
  }

  push(values: ArrayLike<number>, flags = 0): void {
    if ((this.count + 1) * this.channels > this.values.length) this.grow();
    const at = this.count * this.channels;
    for (let i = 0; i < this.channels; i++) this.values[at + i] = values[i] ?? 0;
    this.flags[this.count] = flags & 0xff;
    this.count++;
  }

  /**
   * The state at a tick, clamped to the range that exists.
   *
   * Clamped rather than refused because both ends are ordinary rather than
   * exceptional: a caller one tick past the end is a character who has finished, and
   * holding their last state is exactly what they should look like.
   */
  sample(tick: number, out: Float32Array): void {
    const at = this.clamp(tick) * this.channels;
    for (let i = 0; i < this.channels; i++) out[i] = this.values[at + i] ?? 0;
  }

  channelAt(tick: number, channel: number): number {
    return this.values[this.clamp(tick) * this.channels + channel] ?? 0;
  }

  flagsAt(tick: number): number {
    return this.flags[this.clamp(tick)] ?? 0;
  }

  /**
   * The last tick at which a non-decreasing channel was at or below `value`.
   *
   * This is how two runs of the same course are compared **at the same point on
   * the course** rather than at the same moment in time. Comparing by time drifts
   * the instant one character takes a wider line; comparing by distance does not,
   * which is what makes the difference a split rather than a guess.
   *
   * The **last** tick of a run of equal values, not the first, and that matters
   * wherever the channel can stall: a character who stopped for half a second has a
   * plateau, and answering its first tick would report them ahead by the whole
   * length of the stall.
   *
   * The channel must be non-decreasing. Binary search over anything else returns
   * an answer that is merely arbitrary rather than obviously wrong, so a caller
   * whose channel can go backwards must clamp it on the way in.
   *
   * `-1` on an empty trace: there is no tick to name, and 0 would be a lie about
   * a tick that does not exist.
   */
  tickAtOrBefore(channel: number, value: number): number {
    if (this.count === 0) return -1;

    let low = 0;
    let high = this.count - 1;
    if (this.channelAt(low, channel) > value) return 0;

    while (low < high) {
      // Biased upward, so `low` can actually reach `high` and the loop ends.
      const mid = (low + high + 1) >> 1;
      if (this.channelAt(mid, channel) <= value) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  private clamp(tick: number): number {
    if (this.count === 0) return 0;
    if (tick < 0) return 0;
    return tick >= this.count ? this.count - 1 : tick | 0;
  }

  /**
   * Both arrays double together.
   *
   * They are parallel and they are separate allocations, which is exactly how
   * they come apart: a values array that grew while the flags one did not would
   * read every flag past the old boundary as zero, and zero is a legal flag
   * rather than an error anybody would notice.
   */
  private grow(): void {
    const values = new Float32Array(this.values.length * 2);
    values.set(this.values);
    this.values = values;

    const flags = new Uint8Array(this.flags.length * 2);
    flags.set(this.flags);
    this.flags = flags;
  }
}

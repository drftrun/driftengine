/**
 * Where something heavy has just been: a small set of recent presses, decaying.
 *
 * For foliage. Grass a character has gone through should lie down and come back up,
 * and the two obvious ways to do that are both wrong for this engine. Re-uploading
 * the instance buffer would write megabytes a frame for an effect a metre wide, and
 * baking a texture would need a render target, a lookup and a resolution nobody can
 * defend. So the *field* is a handful of points, the flattening happens in the
 * vertex shader, and the per-frame cost is one `uniform4fv`.
 *
 * Generic on purpose: it knows about world positions and strengths, and nothing
 * about characters, grass or what a press means. The renderer hands it to whichever
 * shader wants to answer to it.
 */

/**
 * How many presses are remembered at once.
 *
 * Eight, and the number is a shader loop as much as a memory budget — every plant
 * vertex walks all of them. It is enough for a couple of seconds of trail at
 * running pace, which is what "it comes back up behind you" needs; a longer memory
 * would be a longer loop in the hottest shader in the game for footprints nobody is
 * looking at any more.
 */
export const TRAMPLE_SLOTS = 8;

/** Floats per press: world x, y, z, strength. */
const STRIDE = 4;

/**
 * How far apart two presses have to be before they take separate slots, metres.
 *
 * Without this a character standing still would spend every slot in a second on the
 * same square metre, and the trail behind them would vanish. Refreshing the nearest
 * press instead is also the truthful model: standing in one place presses that
 * place harder, not eight places once.
 */
const MERGE_RADIUS_M = 0.55;

export class TrampleField {
  /** `[x, y, z, strength]` per slot; strength 0 means empty. */
  readonly data = new Float32Array(TRAMPLE_SLOTS * STRIDE);

  /** Next slot to claim when every one of them is in use. */
  private cursor = 0;

  constructor(
    /**
     * Seconds for a press to fade away completely.
     *
     * Pressed foliage fades back to its original position after a few seconds:
     * long enough that a trail is visible behind a character at speed,
     * short enough that a field does not stay combed for the rest of the run.
     */
    private readonly recoverySec = 1.6,
  ) {}

  /**
   * Record a press, or deepen the one already there.
   *
   * Allocation-free: called every frame the character is on the ground.
   */
  press(x: number, y: number, z: number): void {
    let nearest = -1;
    let nearestDistSq = MERGE_RADIUS_M * MERGE_RADIUS_M;
    let emptySlot = -1;

    for (let i = 0; i < TRAMPLE_SLOTS; i++) {
      const o = i * STRIDE;
      if ((this.data[o + 3] ?? 0) <= 0) {
        if (emptySlot < 0) emptySlot = i;
        continue;
      }
      const dx = (this.data[o] ?? 0) - x;
      const dy = (this.data[o + 1] ?? 0) - y;
      const dz = (this.data[o + 2] ?? 0) - z;
      // Height is part of the distance, so a character on a bridge does not flatten
      // the grass under it.
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = i;
      }
    }

    if (nearest >= 0) {
      const o = nearest * STRIDE;
      // Follow the foot rather than holding the old centre: a character crossing a
      // patch slowly should leave one moving press, not a stutter of stale ones.
      this.data[o] = x;
      this.data[o + 1] = y;
      this.data[o + 2] = z;
      this.data[o + 3] = 1;
      return;
    }

    /*
     * A free slot if there is one, otherwise the oldest by rotation. Round-robin
     * rather than weakest-first: the weakest press is the one about to disappear
     * anyway, and taking it makes a fast trail eat its own tail.
     */
    const slot = emptySlot >= 0 ? emptySlot : this.cursor;
    this.cursor = (this.cursor + 1) % TRAMPLE_SLOTS;
    const o = slot * STRIDE;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = 1;
  }

  /** Let every press recover. Once per rendered frame. */
  update(frameDt: number): void {
    const drop = Math.max(frameDt, 0) / Math.max(this.recoverySec, 1e-3);
    for (let i = 0; i < TRAMPLE_SLOTS; i++) {
      const o = i * STRIDE + 3;
      const strength = this.data[o] ?? 0;
      if (strength <= 0) continue;
      this.data[o] = Math.max(strength - drop, 0);
    }
  }

  /** How pressed a point is, 0–1. For tests and for anything not on the GPU. */
  strengthAt(x: number, y: number, z: number, radiusM: number): number {
    let strongest = 0;
    for (let i = 0; i < TRAMPLE_SLOTS; i++) {
      const o = i * STRIDE;
      const strength = this.data[o + 3] ?? 0;
      if (strength <= 0) continue;
      const dx = (this.data[o] ?? 0) - x;
      const dy = (this.data[o + 1] ?? 0) - y;
      const dz = (this.data[o + 2] ?? 0) - z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist >= radiusM) continue;
      // Same falloff the shader applies, so a test measures what a player sees.
      const fade = 1 - dist / radiusM;
      strongest = Math.max(strongest, strength * fade * fade);
    }
    return strongest;
  }
}

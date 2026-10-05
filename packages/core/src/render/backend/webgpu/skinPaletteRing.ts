import { SkinPaletteTexture } from './skinPaletteTexture.ts';

/**
 * Every joint palette a frame sets, each in its own texture, reused frame after frame.
 *
 * **This exists for the reason `UniformRing` exists, and the fact is the same one.**
 * `queue.writeTexture` does not interleave with draw commands: writes are ordered on the queue
 * timeline and the frame's encoder is submitted *after* all of them, so two palettes uploaded into
 * one texture between two draws give **both** draws the last palette written. Not the first, not a
 * blend — the last, for every skinned draw in the frame.
 *
 * What that looks like is not a skinning bug. Every character in the frame stands in the pose, and
 * at the position, of whichever was drawn last, because a rig carries its placement in its palette
 * rather than in `uModel`. Measured in the product: a game drawing a ghost of an earlier run and
 * then the live character drew the ghost with the *character's* palette, so a translucent second body sat
 * exactly on top of the player and read as a transparency fault.
 *
 * **The other backend needs none of this and that is not an asymmetry of decision.** WebGL2's
 * `texSubImage2D` is a command in the same stream as the draws around it, so an upload between two
 * draws separates them there by construction. The decision — a palette belongs to a draw — is one;
 * only what it takes to honour it differs, which is what `skinPalette.ts` says a binder is for.
 *
 * **A palette set again with the same numbers is the slot it already has.** A rig is drawn in
 * every pass of a frame — the main pass, a reflection, three shadow layers — and each one used to
 * upload the same matrices into a slot of its own, so a crowd ran out five times sooner than it
 * had characters. The ring now remembers the slot each array last went into and compares what it
 * holds, so a rig posed once a frame spends one slot however many passes draw it. Identity alone
 * would be wrong: a caller may pose every rig into one scratch array, and that array then holds a
 * different rig at every set — the comparison is what tells the two apart.
 *
 * **It was capped at 128 until 4.8.6, and the cap declined draws.** A stage of three dozen idling
 * extras beside two fighters filled it in one frame and every skinned draw past it was refused, so
 * the consumer stood its crowd in the bind pose. The ring now holds as many palettes as a frame
 * holds draws (`RenderQuality.drawsPerFrame`), since no frame can bind more palettes than it draws;
 * a slot still allocates its texture only the first time a frame reaches it, so a scene with two
 * characters holds two. **What it costs** is a texture and a cached bind group a slot, 1.5 KB for a
 * 24-joint rig and 6 KB for a 96-joint humanoid. **What would make it wrong** is a crowd of
 * thousands, where a texture a palette is the expensive half; the fix is then one texture holding
 * every palette with a row offset per draw, which spends a per-draw uniform and a vertex-stage
 * change to stop spending textures.
 *
 * **A slot is written at most once per frame**, since a palette that differs from what a slot
 * holds always takes a fresh one. That is what makes the reallocation inside `SkinPaletteTexture`
 * safe: a joint count can only change a slot's texture between frames, never while a recorded draw
 * is still pointing at it.
 */
export class SkinPaletteRing {
  private readonly slots: SkinPaletteTexture[] = [];
  /** What each slot was last written with, for the comparison that lets a pass reuse it. */
  private readonly held: Float32Array[] = [];
  /** The slot each palette array last went into, by identity. Weak, so a caller's array can go. */
  private readonly lastSlot = new WeakMap<Float32Array, number>();
  private used = 0;
  private uploads = 0;
  private warnedFull = false;

  /** `capacity` is how many palettes one frame may hold: one per draw at most. */
  constructor(private readonly capacity: number) {}

  /** How many slots this frame has taken. */
  get count(): number {
    return this.used;
  }

  /** How many palettes have been written to the device since the ring was made. */
  get uploaded(): number {
    return this.uploads;
  }

  /**
   * Start a frame: every slot is free again.
   *
   * **Called where the frame's encoder is replaced and not a line earlier.** A slot may only be
   * re-let once the draws pointing at it have been submitted, which is exactly what `beginFrame`
   * has just done — including for anything drawn after the previous `endFrame`.
   */
  reset(): void {
    this.used = 0;
  }

  /** Where the ring stands, to hand back to `rewind`. See `UniformRing.rewind` for when it is safe. */
  mark(): number {
    return this.used;
  }

  /** Give back every slot taken since `mark`, once the commands reading them are submitted. */
  rewind(mark: number): void {
    if (mark < this.used) this.used = mark;
  }

  /**
   * The slot this frame holds for these numbers, uploading them into a fresh one where none does,
   * or null when the ring is full.
   *
   * **Null rather than reusing a slot that holds something else**, because that is the defect this
   * class is named after: the caller's character would silently take another character's pose. A
   * caller that runs out declines the draw and says so once.
   */
  take(device: GPUDevice, palette: Float32Array): number | null {
    const known = this.lastSlot.get(palette);
    if (known !== undefined && known < this.used && this.holds(known, palette)) return known;
    if (this.used >= this.capacity) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        console.warn(
          `WebGPU: more than ${this.capacity} distinct skin palettes in one frame, which is ` +
            'RenderQuality.drawsPerFrame; the rest of the skinned draws are declined this frame ' +
            'rather than drawn in another rig’s pose.',
        );
      }
      return null;
    }
    const at = this.used++;
    let slot = this.slots[at];
    if (slot === undefined) {
      slot = new SkinPaletteTexture();
      this.slots[at] = slot;
    }
    slot.update(device, palette);
    this.uploads += 1;
    let copy = this.held[at];
    if (copy === undefined || copy.length !== palette.length) {
      /* Once per slot and joint count, the way the slot's own texture is: never per frame. */
      copy = new Float32Array(palette.length);
      this.held[at] = copy;
    }
    copy.set(palette);
    this.lastSlot.set(palette, at);
    return at;
  }

  /** The view a draw binds for a slot, or null for a slot nothing has uploaded into. */
  view(slot: number): GPUTextureView | null {
    return this.slots[slot]?.view() ?? null;
  }

  dispose(): void {
    for (const slot of this.slots) slot.dispose();
    this.slots.length = 0;
    this.held.length = 0;
    this.used = 0;
  }

  /** Whether a slot was last written with exactly these numbers. */
  private holds(slot: number, palette: Float32Array): boolean {
    const copy = this.held[slot];
    if (copy === undefined || copy.length !== palette.length) return false;
    for (let i = 0; i < copy.length; i++) if (copy[i] !== palette[i]) return false;
    return true;
  }
}

import { SkinPaletteTexture } from './skinPaletteTexture.ts';

/**
 * How many palettes one frame may set before the ring is full.
 *
 * The arithmetic rather than a round number: a character's palette is uploaded once per *pass*
 * that draws it, and a full profile draws the same character five times — the main pass, a planar
 * reflection, and the static, peel and dynamic shadow layers. So this is twenty-five characters at
 * once, which is a crowd rather than a cast.
 *
 * **What it costs is nothing until it is used.** A slot allocates its texture on the first frame
 * that reaches it and keeps it, so a scene with two characters holds two: a 24-joint rig is 96
 * texels of `rgba32float`, which is 1.5 KB, and a 96-joint humanoid is 6 KB.
 *
 * **What would make it wrong** is a genuine crowd — a stadium, a swarm of rigged birds — and the
 * fix is then the one `skinPalette.ts` names: one texture holding every palette with a per-draw
 * row offset, which spends a uniform and a shader change to stop spending textures.
 */
export const MAX_SKIN_PALETTES = 128;

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
 * **A slot is written at most once per frame**, since every `setSkinPalette` takes a fresh one.
 * That is what makes the reallocation inside `SkinPaletteTexture` safe: a joint count can only
 * change a slot's texture between frames, never while a recorded draw is still pointing at it.
 */
export class SkinPaletteRing {
  private readonly slots: SkinPaletteTexture[] = [];
  private used = 0;
  private warnedFull = false;

  /** How many slots this frame has taken. */
  get count(): number {
    return this.used;
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

  /**
   * Upload a palette into a slot of its own and return that slot, or null when the ring is full.
   *
   * **Null rather than reusing a slot**, because reusing one is the defect this class is named
   * after: the caller's character would silently take another character's pose. A caller that runs
   * out declines the draw and says so once.
   */
  take(device: GPUDevice, palette: Float32Array): number | null {
    if (this.used >= MAX_SKIN_PALETTES) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        console.warn(
          `WebGPU: more than ${MAX_SKIN_PALETTES} skin palettes in one frame; the rest of the ` +
            'skinned draws are declined this frame rather than drawn in another rig’s pose. ' +
            'See MAX_SKIN_PALETTES.',
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
    return at;
  }

  /** The view a draw binds for a slot, or null for a slot nothing has uploaded into. */
  view(slot: number): GPUTextureView | null {
    return this.slots[slot]?.view() ?? null;
  }

  dispose(): void {
    for (const slot of this.slots) slot.dispose();
    this.slots.length = 0;
    this.used = 0;
  }
}

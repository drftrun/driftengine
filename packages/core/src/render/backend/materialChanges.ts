/**
 * What counts as a material change: the rule both backends count their `materials` line by.
 *
 * **A material is the shading state a draw reads that is not its own placement**, and the WebGPU
 * backend keeps it in a ring of per-frame slots: a draw copies the open material into a new slot
 * when something has changed it since the last draw, and otherwise shares the slot before it. So
 * the slots a frame takes are its material changes, and that is what the backend's ceiling
 * rations. WebGL2 sets the same state as loose uniforms and has nothing to run out of — but a
 * consumer developing there is building the frame the other backend will ration, so it counts the
 * same changes by the same rule, and draws them all.
 *
 * **What changes it**: a material setter; the start of a frame or of a mesh pass, which reopens
 * the pass's own material; a probe bake, which sets its own and puts the pass's back; and a draw
 * carrying options of its own (`ownsMaterial`), whose state is written for it and restored after
 * it, so that it and the draw after it each open one.
 *
 * What it gives up: a setter called with the value already set still counts, because it takes a
 * slot on the backend that keeps slots, and comparing every field would cost more than the slot.
 */

/** What of a draw's own options its material carries. */
export interface DrawMaterialOptions {
  readonly opacity: number;
  readonly lit: boolean;
  readonly fog: boolean;
  readonly toneMapped: boolean;
  /** Whether the draw refracts this time, which a backend decides by whether it has a snapshot. */
  readonly refracting: boolean;
}

/** Whether a draw's options differ from the pass's, so it takes a material and leaves one to restore. */
export function ownsMaterial(options: DrawMaterialOptions): boolean {
  return (
    options.opacity < 1 || !options.lit || !options.fog || !options.toneMapped || options.refracting
  );
}

/** Whether the next draw shares the open material or opens a new one. */
export class MaterialChanges {
  /**
   * The slot the open material occupies on a backend that keeps slots, or -1 when the next draw
   * opens one. A backend without slots writes 0 when it opens one.
   */
  slot = -1;

  get open(): boolean {
    return this.slot >= 0;
  }

  /** Something the material holds changed, or a pass reopened it: the next draw opens a new one. */
  dirty(): void {
    this.slot = -1;
  }
}

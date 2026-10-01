/**
 * How each surface of the district glows at night, by the kind of light it is.
 *
 * **The engine already keeps emission for the night**: a surface's emission is multiplied by the
 * environment's night factor in the shader, so by day nothing here shows. What this decides is how
 * strongly each kind glows once it does, and how it moves, through the material's `emissiveScale`:
 *
 * - **windows** come on across the evening, each material at its own point of the dusk, so a
 *   district lights up block by block rather than all at once;
 * - **screens** play: a slow swell, out of step with each other;
 * - **neon** hums steady and, now and then, one tube stutters;
 * - **lamps** burn steadily and brightest, past the bloom's threshold;
 * - **glass** carries what light its file gives it, dimly.
 *
 * The strengths are chosen against the bloom's threshold (`sky.ts`, 1.2): a lamp and a neon tube
 * clear it and halo softly, a window and a screen do not. They were half again as strong, and a
 * street under a deck of fluorescent tubes read as fog: what a viewer called "so glowy". Mutates the materials' own `emissiveScale` arrays in place,
 * so a frame allocates nothing.
 */
import type { SurfaceMaterial, SurfaceTextureHandle } from '../../packages/core/src/index';

import type { GlowKind } from './bake/materials';

const STRENGTH: Readonly<Record<GlowKind, number>> = {
  plain: 0.8,
  window: 0.75,
  screen: 1.3,
  neon: 2.2,
  lamp: 2.4,
  glass: 0.4,
};

/** A number in [0, 1) that is the same for the same row every run. */
const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class Glow {
  private kinds: GlowKind[] = [];
  private glows: number[] = [];

  take(rows: readonly { kind: GlowKind; glow: number }[]): void {
    this.kinds = rows.map((r) => r.kind);
    this.glows = rows.map((r) => r.glow);
  }

  /** Every row's glow at `night`, `seconds` into the visit, times `gain`. */
  apply(
    materials: readonly (SurfaceMaterial<SurfaceTextureHandle> | null)[],
    night: number,
    seconds: number,
    gain: number,
  ): void {
    for (let row = 0; row < materials.length; row++) {
      const material = materials[row];
      if (material === null || material === undefined || material.emissiveScale === undefined)
        continue;
      const kind = this.kinds[row] ?? 'plain';
      const seed = hash(row);
      let s = STRENGTH[kind] * gain;
      /* A file's own strength past one scales the kind's, softly: a lamp at 100 is not a sun. */
      const stated = this.glows[row] ?? 1;
      if (stated > 1) s *= 1 + 0.5 * Math.log10(stated);
      if (kind === 'window') {
        /* Each row comes on at its own point between a quarter and all of the way into the night. */
        const on = 0.25 + seed * 0.7;
        s *= Math.min(1, Math.max(0, (night - on) / 0.08));
      } else if (kind === 'screen') {
        s *= 0.82 + 0.18 * Math.sin(seconds * (0.6 + seed * 0.8) + seed * 6.28);
      } else if (kind === 'lamp' || kind === 'glass') {
        /* A lamp is switched off by day; a sign and a screen are not, and keep the sky's share. */
        s *= night;
      } else if (kind === 'neon') {
        /* A stutter: about one tube in six, for a beat in every few seconds. */
        const beat = Math.floor(seconds * 7 + seed * 50);
        if (seed < 0.16 && hash(beat + row * 13) < 0.12) s *= 0.15;
      }
      const scale = material.emissiveScale as unknown as number[];
      scale[0] = s;
      scale[1] = s;
      scale[2] = s;
    }
  }
}

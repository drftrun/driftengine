/**
 * What a burning thing looks like, written into somebody else's per-instance arrays.
 *
 * **Structural, like `smoke.ts`, and for the same reason**: this package imports no engine package
 * and `present/` must not be the thing that breaks it. A target is described by what it must have.
 *
 * Four of `§17`'s six mappings live here — char, glow, wetness and shrinkage — because all four are
 * per-parcel and per-frame and reading a parcel four times would be four passes over the same
 * columns. Smoke and flame are per-cell and per-fire, which is why they are elsewhere.
 */
import type { ParcelStore } from '../parcel/store.ts';
import { GLOW_MIN_TEMPERATURE, blackbodyRGB, glowIntensity } from './blackbody.ts';

/** Anything shaped like a block of per-instance material overrides. */
export interface SurfaceTarget {
  /** Linear RGB, three floats each. */
  albedos: Float32Array;
  /** Linear RGB, three floats each, already multiplied by intensity. */
  emissives: Float32Array;
  /** 0 to 1, where wet is smoother. */
  roughness: Float32Array;
  /** A uniform scale, 1 at the size it was spawned. */
  scales: Float32Array;
  count: number;
}

/**
 * Roughness a dry surface sits at, and how far a soaked one is pulled toward a mirror.
 *
 * `WET_FILM_FULL` is kilograms of water per square metre at which the film is continuous — about a
 * tenth of a millimetre of water, which is what a surface holds before it starts running off.
 */
const DRY_ROUGHNESS = 0.85;
const WET_ROUGHNESS = 0.15;
const WET_FILM_FULL = 0.1;

/* Scratch, module-level and reused: this runs per parcel per frame. */
const glow = new Float32Array(3);

/**
 * Write one entry per parcel, in the order given.
 *
 * **Every value is a reading.** Albedo lerps from the substance's own toward its own char colour by
 * char fraction; the emissive is Planck at the surface temperature times Stefan-Boltzmann;
 * roughness is the surface water film; scale is the cube root of what is left of the volume.
 *
 * **A substance with no `appearance` gets no albedo and no roughness written**, and the entry is
 * left exactly as the caller had it. Quietly recolouring a material the consumer described would be
 * the engine overwriting an artist. Scale and emissive are still written, because both are physics
 * rather than art.
 *
 * **`AGENTS.md`'s standing trap applies to `emissives`.** Emissive in this engine is gated on
 * `nightFactor`, so embers written here look right at dusk and dead at noon. A consumer who wants
 * them visible in daylight raises that gate; nothing in this function can do it for them.
 */
export function writeSurface(
  parcels: ParcelStore,
  handles: readonly number[],
  out: SurfaceTarget,
): number {
  let written = 0;
  for (let i = 0; i < handles.length; i++) {
    const parcel = handles[i] as number;
    if (!parcels.alive(parcel)) continue;
    const at = written * 3;
    const appearance = parcels.appearanceOf(parcel);

    if (appearance !== null) {
      const char = parcels.charFractionOf(parcel);
      const solid = char > 1 ? 1 : char;
      for (let c = 0; c < 3; c++) {
        out.albedos[at + c] =
          (appearance.albedo[c] as number) * (1 - solid) +
          (appearance.charAlbedo[c] as number) * solid;
      }
      const film = parcels.wetnessOf(parcel) / WET_FILM_FULL;
      const wet = film > 1 ? 1 : film;
      out.roughness[written] = DRY_ROUGHNESS * (1 - wet) + WET_ROUGHNESS * wet;
    }

    const surface = parcels.surfaceTemperatureOf(parcel);
    if (surface >= GLOW_MIN_TEMPERATURE) {
      blackbodyRGB(surface, glow);
      const intensity = glowIntensity(surface);
      for (let c = 0; c < 3; c++) out.emissives[at + c] = (glow[c] as number) * intensity;
    } else {
      out.emissives[at] = 0;
      out.emissives[at + 1] = 0;
      out.emissives[at + 2] = 0;
    }

    /*
     * The **cube root** of the volume ratio, because a scale is linear and a volume is not. Half the
     * mass is 0.794 of the size, which is a log visibly smaller and not half a log.
     *
     * `Math.cbrt`'s result is not pinned down by ECMAScript, which is why it is kept off the
     * simulation path entirely — `shellGeometry` says so. Here it is presentation, which does not
     * feed back into the state, so a last-bit difference between platforms is a pixel rather than a
     * divergence.
     */
    // determinism: build-time — presentation: a parcel's drawn scale, not its state
    out.scales[written] = Math.cbrt(parcels.volumeShareOf(parcel));
    written++;
  }
  out.count = written;
  return written;
}

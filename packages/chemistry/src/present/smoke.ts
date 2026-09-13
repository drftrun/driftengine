/**
 * The field made visible, written into somebody else's particle arrays.
 *
 * **This module names no core type and imports nothing.** The target is described by what it must
 * have, which is the `ragdollFromBones` arrangement: `@driftengine/core`'s `ParticleInstances`
 * satisfies `SmokeTarget` exactly, and neither package knows the other exists. That matters more
 * here than it did there, because this package imports **no** engine package at all and `present/`
 * must not be the thing that breaks it.
 */
import type { AtmosphereField } from '../field/atmosphere.ts';

/**
 * Anything shaped like a pool of particles.
 *
 * Declared structurally, per the header. `spins` and `capacity` are core's and are not required
 * here — a target that has them is fine, and one that does not still works, which is what
 * structural means.
 */
export interface SmokeTarget {
  positions: Float32Array;
  velocities: Float32Array;
  colors: Float32Array;
  alphas: Float32Array;
  sizes: Float32Array;
  ages: Float32Array;
  seeds: Float32Array;
  count: number;
  readonly capacity: number;
}

export interface SmokeOptions {
  /** kg of soot plus aerosol in a cell below which nothing is drawn. */
  readonly threshold: number;
  /** Metres across, which is also the path length opacity is computed over. */
  readonly size: number;
  /** The horizontal component a particle inherits, m/s. The vertical is the field's own. */
  readonly wind: number;
}

/** Linear albedo of soot, and of condensed water aerosol. `§17`. */
const SOOT_ALBEDO = 0.03;
const AEROSOL_ALBEDO = 0.92;

/** The extinction the field's own visibility is derived from, m²/kg. */
const SOOT_EXTINCTION = 8700;

/**
 * The colour of a mixture of soot and aerosol, by mass.
 *
 * **Nothing chose it.** Soot is near-black at an albedo around 0.03 and water aerosol is near-white,
 * so the ratio *is* the colour: a green log steams white, a rich fire smokes black, and a fire doing
 * both does both in the right places. Grey where they are equal, which is what wood smoke is.
 *
 * Writes into `out`, allocates nothing.
 */
export function smokeColour(soot: number, aerosol: number, out: Float32Array): void {
  const total = soot + aerosol;
  const albedo =
    total > 0 ? (soot * SOOT_ALBEDO + aerosol * AEROSOL_ALBEDO) / total : AEROSOL_ALBEDO;
  out[0] = albedo;
  out[1] = albedo;
  out[2] = albedo;
}

/* Scratch, module-level and reused, because this runs per cell per frame. */
const colour = new Float32Array(3);

/**
 * Write one particle per smoky cell in a box, and return how many were written.
 *
 * The box is `cells` cells on a side from `(x, y, z)` in cell coordinates, which is what a consumer
 * has: they know where their fire is, and scanning the whole live set to find it would cost the same
 * whether there was one fire or a hundred.
 *
 * **Every value is a reading rather than a parameter.** Position is the cell centre, velocity is the
 * caller's wind plus the field's own buoyant rise — the same function transport uses, so a particle
 * goes up at the speed the gas carrying it goes up — colour is the soot-to-aerosol ratio, and
 * opacity is extinction over the particle's own path length. `size` and `threshold` are the two
 * things a consumer genuinely decides.
 *
 * `count` is set rather than added to: a pool is refilled each frame, which is what makes this
 * allocation-free.
 */
export function emitSmoke(
  field: AtmosphereField,
  x: number,
  y: number,
  z: number,
  cells: number,
  out: SmokeTarget,
  options: SmokeOptions,
): number {
  let written = 0;
  const limit = out.alphas.length < out.capacity ? out.alphas.length : out.capacity;
  for (let ix = 0; ix < cells && written < limit; ix++) {
    for (let iy = 0; iy < cells && written < limit; iy++) {
      for (let iz = 0; iz < cells && written < limit; iz++) {
        const cx = x + ix + 0.5;
        const cy = y + iy + 0.5;
        const cz = z + iz + 0.5;
        const soot = field.sootAt(cx, cy, cz);
        const aerosol = field.aerosolAt(cx, cy, cz);
        if (soot + aerosol < options.threshold) continue;

        const at = written * 3;
        out.positions[at] = cx;
        out.positions[at + 1] = cy;
        out.positions[at + 2] = cz;
        out.velocities[at] = options.wind;
        out.velocities[at + 1] = field.riseAt(cx, cy, cz);
        out.velocities[at + 2] = 0;

        smokeColour(soot, aerosol, colour);
        out.colors[at] = colour[0] as number;
        out.colors[at + 1] = colour[1] as number;
        out.colors[at + 2] = colour[2] as number;

        /*
         * Opacity from extinction over the particle's own size, rather than from a curve.
         *
         * `1 − exp(−σd)` is the honest form and `exp` may not run here, so this is the first two
         * terms of it arranged as `σd / (1 + σd)` — which agrees to within a few percent over the
         * range that matters and saturates at one the way the exponential does, instead of
         * overshooting the way a truncated series would.
         */
        const extinction = field.smokeDensityAt(cx, cy, cz) * options.size;
        out.alphas[written] = extinction / (1 + extinction);
        out.sizes[written] = options.size;
        out.ages[written] = 0;
        /* Per-particle randomness with no entropy: the cell's own index, so neighbours differ and
           two runs agree. `§15`'s determinism rule reaches presentation too. */
        out.seeds[written] = (((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) % 1024) / 1024;
        written++;
      }
    }
  }
  out.count = written;
  return written;
}

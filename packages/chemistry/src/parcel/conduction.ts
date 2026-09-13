/**
 * One-dimensional conduction inward through a parcel's shells.
 *
 * **Explicit, sub-stepped, and in enthalpy rather than temperature** — and that last part is what
 * rules out the obvious alternative. A tridiagonal implicit solve would be unconditionally stable
 * and is twenty lines, but it solves for *temperature*, and on a phase plateau temperature does not
 * respond to heat at all. An implicit step there is asking a solver to invert an infinite heat
 * capacity. The enthalpy formulation is the reason this model works, so the integrator bends to it.
 *
 * **The plateau helps rather than hurts.** A shell part-way through melting absorbs heat without
 * changing temperature, which is the most stable thing a cell can do — the stiffness is all in the
 * dry segments, where the sub-step estimate below is what handles it.
 *
 * **Energy is conserved exactly, whatever the step does.** Conduction *moves* energy: whatever
 * leaves shell `i` enters shell `i + 1`, computed once and applied to both. An under-resolved step
 * can oscillate, and it can never gain or lose a joule. That is why an explicit integrator is safe
 * here, and `conduction.test.ts` asserts it over five thousand ticks rather than arguing it.
 *
 * **The interface conductivity is the harmonic mean**, because a boundary between two materials is
 * a series resistance and series resistances add reciprocals. It matters as soon as the two sides
 * differ — and they will: char is roughly half the conductivity of the wood beneath it, which is
 * the whole late-stage story of a burning log. An arithmetic mean would make the char blanket
 * insulate far less than it does.
 */
import { STANDARD_TEMPERATURE } from '../species/species.ts';
import { temperatureFromCapacity } from '../species/thermal.ts';
import type { SubstanceReactions } from '../reaction/solver.ts';
import type { ShellGeometry } from './shells.ts';
import { MAX_SHELLS } from './shells.ts';

/** W/(m·K): `k0` at the standard state, rising by `k1` per kelvin. */
export interface Conductivity {
  readonly k0: number;
  readonly k1: number;
}

/** Everything about conduction that is a property of the substance, resolved once at registration. */
export interface ConductionModel {
  readonly geometry: ShellGeometry;
  readonly conductivity: Conductivity | null;
}

/**
 * The most sub-steps one call will take.
 *
 * Past this the step is under-resolved, and what happens then is decided by the clamp below rather
 * than by this number: a pair may not exchange more heat than would equalise it, so an
 * under-resolved step relaxes toward the right answer instead of overshooting past it.
 *
 * **This note used to say the failure was a ring and that a ring was the right failure.** It is not.
 * A copper coin on the hearth in `demo/dev/chemistry.ts` — 400 W/(m·K) across a 0.3 mm shell, which
 * wants seven hundred sub-steps — reached 4,000 K on its first step and 100 K a minute later, and
 * *the energy was conserved the whole time*. Conservation is not enough: an ignition criterion reads
 * a surface temperature and `present/` draws a glow from one, so an oscillation nothing loses energy
 * to is still a fire that starts in the wrong place.
 */
const MAX_SUBSTEPS = 64;

/* Module-scope scratch, so a tick allocates nothing. Not reentrant, and nothing here nests. */
const temperature = new Float64Array(MAX_SHELLS);
const coefficient = new Float64Array(MAX_SHELLS);
/** Each shell's `dh/dT`, so the clamp knows what equalising a pair would cost. */
const capacity = new Float64Array(MAX_SHELLS);

/**
 * Move heat inward one step. `enthalpy` holds this parcel's shells at `offset`, in joules.
 *
 * @param shellMass kg in each shell — equal by construction, which is what equal-mass shells buy
 * @param area m² of exposed surface
 * @param depth m, the characteristic depth: `depthFactor × volume / area`
 */
export function conductShells(
  enthalpy: Float64Array,
  offset: number,
  model: ConductionModel,
  thermal: SubstanceReactions,
  composition: Float64Array,
  compositionOffset: number,
  shellMass: number,
  area: number,
  depth: number,
  dt: number,
): void {
  const { geometry, conductivity } = model;
  const count = geometry.count;
  if (count < 2 || conductivity === null || dt <= 0) return;

  /* Each shell's temperature from **its own** composition, which is what CH-6 bought: a shell part
     way through charring has a different heat capacity from the one beside it, and a single curve
     built at registration could not know. */
  const width = thermal.speciesCount;
  let smallestCapacity = Number.POSITIVE_INFINITY;
  const read = (): void => {
    smallestCapacity = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const base = compositionOffset + i * width;
      let A = 0;
      let B = 0;
      for (let s = 0; s < width; s++) {
        const mass = composition[base + s] as number;
        if (mass === 0) continue;
        A += mass * (thermal.cpA[s] as number);
        B += mass * (thermal.cpB[s] as number);
      }
      temperature[i] = temperatureFromCapacity(A, B, enthalpy[offset + i] as number);
      /* `dh/dT` at this shell's own temperature, which is `A + B·ΔT` for a `cp` linear in `T`. */
      const rise = (temperature[i] as number) - STANDARD_TEMPERATURE;
      const slope = A + B * rise;
      capacity[i] = slope > 0 ? slope : A > 0 ? A : shellMass;
      if (A > 0 && A < smallestCapacity) smallestCapacity = A;
    }
    if (!Number.isFinite(smallestCapacity)) smallestCapacity = shellMass;
  };

  /* Conductances, W/K, from the temperatures the step starts at. Recomputed per sub-step, because
     the whole point of a temperature-dependent `k` is that it moves as the front does. */
  const conductances = (): number => {
    let worst = 0;
    for (let i = 0; i < count - 1; i++) {
      const kHot =
        conductivity.k0 + conductivity.k1 * ((temperature[i] as number) - STANDARD_TEMPERATURE);
      const kCold =
        conductivity.k0 + conductivity.k1 * ((temperature[i + 1] as number) - STANDARD_TEMPERATURE);
      const total = kHot + kCold;
      const effective = total > 0 ? (2 * kHot * kCold) / total : 0;
      const face = area * (geometry.areaFactor[i] as number);
      const span =
        depth *
        (((geometry.thicknessFraction[i] as number) +
          (geometry.thicknessFraction[i + 1] as number)) /
          2);
      const conductance = span > 0 ? (effective * face) / span : 0;
      coefficient[i] = conductance;
      if (conductance > worst) worst = conductance;
    }
    return worst;
  };

  read();
  const worst = conductances();
  if (!(worst > 0)) return;

  /*
   * The explicit stability limit, as a sub-step count.
   *
   * A shell's temperature responds to a flux at `1 / (m·c)`, so a step is resolved while
   * `dt · conductance / (m · c) ≤ 1/2`. `minHeatCapacity` is the smallest `dh/dT` anywhere on the
   * substance's curve, which makes this conservative everywhere and exact at the worst point.
   */
  /* The sub-step estimate uses the smallest heat capacity actually present, which is the shell
     that responds fastest to a flux and therefore the one that sets the limit. */
  const limit = (2 * dt * worst) / smallestCapacity;
  const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(limit)));
  const step = dt / substeps;

  for (let pass = 0; pass < substeps; pass++) {
    if (pass > 0) {
      read();
      conductances();
    }
    for (let i = 0; i < count - 1; i++) {
      const gap = (temperature[i] as number) - (temperature[i + 1] as number);
      let joules = (coefficient[i] as number) * gap * step;
      /*
       * **Clamped at the point the two shells would be equal**, which is unconditionally stable and
       * changes nothing whenever the step was resolved anyway.
       *
       * Heat moves down a temperature difference until there is no difference left; a step that
       * would carry the cold shell *past* the hot one has moved more heat than exists to move, and
       * doing that repeatedly is the oscillation `MAX_SUBSTEPS` used to permit. The equalising
       * amount for two capacities in series is `ΔT · CaCb/(Ca+Cb)`, and it is the same arithmetic
       * two conductivities in series already use.
       */
      const ca = capacity[i] as number;
      const cb = capacity[i + 1] as number;
      const total = ca + cb;
      if (total > 0) {
        const equalising = (gap * ca * cb) / total;
        if (joules > 0 && joules > equalising) joules = equalising;
        else if (joules < 0 && joules < equalising) joules = equalising;
      }
      /* Computed once and applied to both, which is what makes conservation exact rather than
         approximate: the same double is subtracted here and added there. */
      enthalpy[offset + i] = (enthalpy[offset + i] as number) - joules;
      enthalpy[offset + i + 1] = (enthalpy[offset + i + 1] as number) + joules;
    }
  }
}

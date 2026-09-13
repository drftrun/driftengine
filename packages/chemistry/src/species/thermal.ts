/**
 * Temperature from enthalpy, in closed form, from whatever a thing is made of right now.
 *
 * **This replaces `§3`'s per-substance enthalpy curve, and the reversal is CH-6's opening move.**
 * That curve was built from a substance's *initial* composition, so the temperature it reported
 * drifted as reactions changed what was actually there — about 20% of the rise for cellulose
 * becoming char. Ignition is a surface temperature crossing 623 K, so nothing could be allowed to
 * read it.
 *
 * **The repair is smaller than the thing it repairs, because the latent heat was never sensible
 * enthalpy's job.** It is already in the formation enthalpies CH-0 stores: `H₂O(s) → H₂O(l)` comes
 * out of Hess's law at 333,611 J/kg against a literature 333,550. So a phase change is a *reaction*
 * with a temperature gate, its plateau emerges from the substep-and-clamp solver that already
 * exists, and what is left here is purely sensible heat:
 *
 *     h = A·ΔT + B·ΔT²/2          A = Σ mᵢ·cpAᵢ,  B = Σ mᵢ·cpBᵢ,  ΔT = T − 298.15
 *
 * A quadratic, so inverting it is a formula rather than a search:
 *
 *     ΔT = (−A + √(A² + 2·B·h)) / B
 *
 * **One square root, which is one of the two operations ECMAScript specifies exactly** — `§15`
 * permits it where it forbids `exp` and `pow`, and Track B's solver already leans on the same fact.
 * Cheaper than the 256-knot binary search it replaces, composition-aware by construction, and it
 * deletes machinery rather than adding to it.
 */
import { STANDARD_TEMPERATURE } from './species.ts';

/** K. Below this nothing in this engine is modelled, and a reading clamps rather than extrapolates. */
export const MIN_MODEL_TEMPERATURE = 100;

/** K. Above this likewise — past any flame this model produces. */
export const MAX_MODEL_TEMPERATURE = 4000;

/** Specific enthalpy of a species at a temperature, J/kg, zero at the standard state. */
export function sensibleEnthalpy(cpA: number, cpB: number, temperature: number): number {
  const dT = temperature - STANDARD_TEMPERATURE;
  return cpA * dT + (cpB * dT * dT) / 2;
}

/**
 * The temperature a body of heat capacity `A + B·ΔT` sits at holding `joules`.
 *
 * `A` and `B` are **absolute** — kilograms times specific heat, summed over whatever is present —
 * so `joules` is the total the thing holds rather than a specific value, and there is no division
 * before the inversion.
 *
 * Clamped at both ends rather than extrapolated, and answering the standard state for a body with
 * no heat capacity at all: a temperature is not a meaningful question about an empty shell, and
 * inventing one is worse than declining.
 */
export function temperatureFromCapacity(A: number, B: number, joules: number): number {
  if (!(A > 0)) return STANDARD_TEMPERATURE;

  let dT: number;
  if (B === 0) {
    dT = joules / A;
  } else {
    const discriminant = A * A + 2 * B * joules;
    if (!(discriminant >= 0)) {
      /* Past the turning point of the quadratic, which means past where a linear `cp` is a model of
         anything. The sign of `B` says which end it ran off. */
      return B > 0 ? MIN_MODEL_TEMPERATURE : MAX_MODEL_TEMPERATURE;
    }
    /* The branch through `ΔT = 0`, which is this root for either sign of `B`: at `h = 0` the
       discriminant is `A²`, the square root is `A`, and the numerator is zero. */
    dT = (-A + Math.sqrt(discriminant)) / B;
  }

  const temperature = STANDARD_TEMPERATURE + dT;
  if (temperature < MIN_MODEL_TEMPERATURE) return MIN_MODEL_TEMPERATURE;
  if (temperature > MAX_MODEL_TEMPERATURE) return MAX_MODEL_TEMPERATURE;
  return temperature;
}

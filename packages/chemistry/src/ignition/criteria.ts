/**
 * Ignition is a criterion, not a flag — and extinction is four of them.
 *
 * **There is no `ignite()` that sets a boolean and starts a fire**, and `§11` is the argument.
 * Ignition is what happens when the conditions for it are met, and there are five because there are
 * five real ones. `ignite` supplies a *pilot* for one tick; holding a match to wet wood does exactly
 * nothing, which is correct and is the API telling the truth about what a match is.
 *
 * **The mass flux is the real criterion and the temperature is the cheap proxy.** Ignition happens
 * when enough fuel is coming off the surface to make a flammable mixture above it; the surface
 * temperature is a correlate of that rather than a cause. Both are kept, because the temperature is
 * what a consumer reads in an interface — *this is getting hot* — and the flux is what decides.
 */

export interface IgnitionModel {
  /** K at which a surface will catch **given a pilot**. Wood: 623. */
  readonly pilotedSurfaceK: number;
  /** K at which it catches with no pilot at all. Wood: 773, and the gap is why a spark matters. */
  readonly autoSurfaceK: number;
  /** kg/(m²·s) of volatiles leaving the surface. Wood: about 0.0035, or 3.5 g/m²·s. */
  readonly criticalMassFlux: number;
  /** Volume fraction below which a flame cannot be sustained. About 0.14 for most solids. */
  readonly limitingOxygen?: number;
  /** And below which even a smoulder cannot. Far lower — about 0.05 — which is why smothering leaves embers. */
  readonly smoulderingOxygen?: number;
  /** Volume fractions between which this material's volatiles carry a flame. */
  readonly lowerFlammable?: number;
  readonly upperFlammable?: number;
}

export const DEFAULT_LIMITING_OXYGEN = 0.14;
export const DEFAULT_SMOULDERING_OXYGEN = 0.05;

/** m/s of local gas past a surface, beyond which a flame cannot anchor and is blown off. */
export const BLOW_OFF_SPEED = 8;

/**
 * How close a parcel is to catching, 0 to 1.
 *
 * The **minimum** of the five criteria's individual satisfactions, so it reads as "the nearest
 * thing to ready that everything is". A readout rather than a state: nothing branches on it, and a
 * consumer wanting a *this is about to catch* indicator reads one number instead of five.
 */
export function ignitionProgress(
  model: IgnitionModel,
  surfaceTemperature: number,
  fuelFlux: number,
  oxygenFraction: number,
  piloted: boolean,
): number {
  const threshold = piloted ? model.pilotedSurfaceK : model.autoSurfaceK;
  const limiting = model.limitingOxygen ?? DEFAULT_LIMITING_OXYGEN;

  const heat = ratio(surfaceTemperature - 293.15, threshold - 293.15);
  const fuel = ratio(fuelFlux, model.criticalMassFlux);
  const air = ratio(oxygenFraction, limiting);
  const smallest = Math.min(heat, fuel, air);
  return smallest < 0 ? 0 : smallest > 1 ? 1 : smallest;
}

function ratio(value: number, against: number): number {
  if (!(against > 0)) return value > 0 ? 1 : 0;
  return value / against;
}

/**
 * The fuel fraction **at the surface**, which is not the fuel fraction in the room.
 *
 * A flame sits in a boundary layer a few millimetres thick, and a cell in this model is a cubic
 * metre. Reading a cell average and calling it the mixture over a surface is a resolution error,
 * and it is one this phase made and measured: a log at 1,063 K pouring off nearly a kilogram per
 * square metre per second registered 1.7% combustible gas in the cell around it and never caught,
 * because the flame was being asked to burn the room rather than the boundary layer.
 *
 * What is right is the fuel's share of everything leaving the surface plus everything sweeping past:
 *
 *     C ≈ ṁ_fuel / (ṁ_total + v·ρ)
 *
 * so a strong flux is rich, a weak one is lean, and a wind thins it — the same mechanism that blows
 * a flame off, arriving here too and for the same reason.
 *
 * **The two fluxes are separate, and that is what a green log turns on.** `§21`: steam leaving a wet
 * surface dilutes the gas above it, so even once volatiles appear the mixture is below its lower
 * limit. With one flux standing in for both, water vapour counted as fuel and a log at 60% moisture
 * caught in front of a campfire — which it does not, and which this test said before this line
 * existed.
 */
export function surfaceFuelFraction(fuelFlux: number, totalFlux: number, gasSpeed: number): number {
  const sweep = (TRANSFER_VELOCITY + gasSpeed) * AIR_DENSITY;
  const total = totalFlux + sweep;
  return total > 0 ? fuelFlux / total : 0;
}

/** m/s of natural mass transfer past a surface in still air. */
const TRANSFER_VELOCITY = 0.02;

/** kg/m³. */
const AIR_DENSITY = 1.2;

/**
 * Whether all five conditions for flaming ignition hold.
 *
 * Surface hot enough, enough fuel coming off it, oxygen above the limiting index, the mixture **at
 * the surface** within its flammability limits, and — for the lower of the two temperatures — a
 * pilot.
 */
export function ignites(
  model: IgnitionModel,
  surfaceTemperature: number,
  fuelFlux: number,
  totalFlux: number,
  oxygenFraction: number,
  gasSpeed: number,
  piloted: boolean,
): boolean {
  const threshold = piloted ? model.pilotedSurfaceK : model.autoSurfaceK;
  if (surfaceTemperature < threshold) return false;
  /* The critical mass flux is a flux of **fuel**, which is what the measured figure means. */
  if (fuelFlux < model.criticalMassFlux) return false;
  if (oxygenFraction < (model.limitingOxygen ?? DEFAULT_LIMITING_OXYGEN)) return false;
  const mixture = surfaceFuelFraction(fuelFlux, totalFlux, gasSpeed);
  if (mixture < (model.lowerFlammable ?? DEFAULT_LOWER_FLAMMABLE)) return false;
  if (mixture > (model.upperFlammable ?? DEFAULT_UPPER_FLAMMABLE)) return false;
  return true;
}

/** Volume fractions between which a lumped volatile mixture will carry a flame. */
export const DEFAULT_LOWER_FLAMMABLE = 0.03;
export const DEFAULT_UPPER_FLAMMABLE = 0.95;

/** Why a flame went out, or `-1` where it did not. The order is the order they are checked in. */
export const EXTINCT_NONE = -1;
export const EXTINCT_FUEL = 0;
export const EXTINCT_OXYGEN = 1;
export const EXTINCT_COOLED = 2;
export const EXTINCT_BLOWN_OFF = 3;

/**
 * Whether a flame stops, and which of the four reasons it was.
 *
 * **Blow-off is the one that reads oddly and is right.** Blowing on a candle puts it out because
 * the gas moves faster than the flame can propagate back into it; blowing on embers makes them
 * brighter, because there is no flame to blow off and more oxygen arrives. Both come out of this
 * function returning a reason for one and not for the other.
 */
export function extinguishes(
  model: IgnitionModel,
  fuelFlux: number,
  oxygenFraction: number,
  surfaceTemperature: number,
  gasSpeed: number,
): number {
  if (fuelFlux < model.criticalMassFlux) return EXTINCT_FUEL;
  if (oxygenFraction < (model.limitingOxygen ?? DEFAULT_LIMITING_OXYGEN)) return EXTINCT_OXYGEN;
  /* A surface below its own piloted ignition point is no longer feeding a flame it could relight. */
  if (surfaceTemperature < model.pilotedSurfaceK) return EXTINCT_COOLED;
  if (gasSpeed > BLOW_OFF_SPEED) return EXTINCT_BLOWN_OFF;
  return EXTINCT_NONE;
}

/**
 * Whether a smoulder can persist: char present, and oxygen above the far lower index it needs.
 *
 * A smoulder needs no flammable mixture and no pilot, because there is no gas-phase flame at all —
 * oxygen meets solid carbon at the surface. That is why it survives conditions a flame cannot, and
 * why it is the half of a fire that reignites a room after the flames are out.
 */
export function smoulders(
  model: IgnitionModel,
  charFraction: number,
  oxygenFraction: number,
  surfaceTemperature: number,
): boolean {
  if (!(charFraction > 0)) return false;
  if (oxygenFraction < (model.smoulderingOxygen ?? DEFAULT_SMOULDERING_OXYGEN)) return false;
  return surfaceTemperature > 600;
}

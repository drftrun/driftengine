/**
 * A fire as three numbers, and **this package never touches `@driftengine/audio`**.
 *
 * `§17` is deliberate about that: what a fire sounds like is a consumer's decision made with
 * quantities the model already has, and a chemistry package that reached for a mix bus would have
 * imported an engine package for the first time to play a sound.
 *
 * All three are *rates and levels* rather than volumes. A consumer maps them to whatever their mix
 * wants; nothing here knows what a decibel is worth in their game.
 */

/** Bursts per second per unit rate, at one square metre. A gain, and the only one in this file. */
const CRACKLE_GAIN = 900;
const HISS_GAIN = 40;

/**
 * How fast it crackles, from the volatile release rate and the area releasing them.
 *
 * **Crackling is pockets of gas bursting out of the wood**, so it tracks pyrolysis rather than a
 * flag — which means it starts before the flame does, peaks while the log is gasifying hardest, and
 * fades on its own as the volatiles run out. A loop played while `burning` is true does none of that.
 *
 * @param fuelFlux kg/(m²·s) of combustible gas leaving the surface.
 * @param area m² of that surface.
 */
export function crackleRate(fuelFlux: number, area: number): number {
  return fuelFlux > 0 ? fuelFlux * area * CRACKLE_GAIN : 0;
}

/**
 * How hard it hisses, from the steam leaving rather than the fuel.
 *
 * The difference between the two fluxes is the whole reason both are stored: a green log hisses and
 * does not crackle, a seasoned one crackles and does not hiss, and a log part-way through does both
 * in the proportion its own drying front is at.
 *
 * @param steamFlux kg/(m²·s) of water vapour leaving the surface.
 */
export function hissRate(steamFlux: number, area: number): number {
  return steamFlux > 0 ? steamFlux * area * HISS_GAIN : 0;
}

/**
 * How loud it roars, from the air it entrains.
 *
 * A fire's roar is the sound of air being pulled into the plume, so it goes with the plume's own
 * velocity — and as the **square** of it, because acoustic power does. That is why a large fire is
 * disproportionately louder rather than proportionally louder.
 *
 * @param entrainedSpeed m/s of gas rising in the plume, which the field reports as `riseAt`.
 */
export function roarLevel(entrainedSpeed: number): number {
  return entrainedSpeed > 0 ? entrainedSpeed * entrainedSpeed : 0;
}

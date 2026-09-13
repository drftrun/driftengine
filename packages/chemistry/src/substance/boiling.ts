/**
 * Where a liquid boils at a pressure that is not one atmosphere.
 *
 * Clausius-Clapeyron, integrated with the latent heat held constant over the range:
 *
 *     1/T = 1/T0 - (R / L_molar) * ln(P / P0)
 *
 * **Why it matters is `§8.1` and `§22`.** A boiling point is the ceiling a wet surface's
 * temperature is pinned at, so moving it moves what the surface can do. At 3,000 metres water boils
 * near 90 C, a stew there cannot reach the 140 C Maillard browning needs, and food genuinely does
 * not brown in a pot at altitude. Under two atmospheres it boils near 121 C, which is a pressure
 * cooker and is also why an autoclave sterilises at that number.
 *
 * **Authoring-time only, and that is a rule rather than a note.** This calls `log`, and `§7` bans
 * transcendentals from the tick — they are the easiest place in the engine to lose determinism
 * between platforms. CH-4 supplies a per-cell pressure, and when it does this is tabulated the way
 * every rate law already is. Until then a caller passes a pressure at setup.
 *
 * Constant latent heat is the approximation, and it is a good one over the range a game covers:
 * water's `L` falls about 6% between 100 C and 120 C, which moves the answer by a few tenths of a
 * kelvin. It breaks down approaching the critical point, which nothing here goes near.
 */

/** J/(mol·K). */
const GAS_CONSTANT = 8.314462618;

/** Pa. The standard atmosphere every reference temperature in this package is quoted at. */
const REFERENCE_PRESSURE = 101325;

/**
 * @param referenceTemperature K, where this liquid boils at `referencePressure`
 * @param latentHeat J **per kilogram** of the species that changes phase
 * @param molarMass kg/mol, matching `SpeciesRegistry.molarMass`
 * @param pressure Pa
 */
export function boilingPoint(
  referenceTemperature: number,
  latentHeat: number,
  molarMass: number,
  pressure: number,
  referencePressure: number = REFERENCE_PRESSURE,
): number {
  if (!(pressure > 0)) {
    throw new Error(`boiling point asked at a pressure of ${pressure} Pa`);
  }
  if (!(referencePressure > 0)) {
    throw new Error(`boiling point asked against a reference pressure of ${referencePressure} Pa`);
  }
  if (!(latentHeat > 0)) {
    throw new Error(`latent heat is ${latentHeat}, which is not positive`);
  }
  if (!(molarMass > 0)) {
    throw new Error(`molar mass is ${molarMass}, which is not positive`);
  }

  const molarLatentHeat = latentHeat * molarMass;
  // determinism: build-time — a boiling point derived at registration, from constants
  const logPressureRatio = Math.log(pressure / referencePressure);
  const inverse = 1 / referenceTemperature - (GAS_CONSTANT / molarLatentHeat) * logPressureRatio;
  if (!(inverse > 0)) {
    throw new Error(`a pressure of ${pressure} Pa puts this liquid past its critical point`);
  }
  return 1 / inverse;
}

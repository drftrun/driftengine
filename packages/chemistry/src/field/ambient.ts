/**
 * The far field: what the air is where nothing has happened to it.
 *
 * A consumer's constant, and everything downstream adjusts to it without a feature. A low-oxygen
 * atmosphere makes fire hard to start and easy to put out; a high-oxygen one makes everything
 * terrifying; a thin one lowers every boiling point in the world. None of those needed code.
 */
import type { SpeciesRegistry } from '../species/registry.ts';

/** Pa. */
export const STANDARD_PRESSURE_PA = 101325;

/** J/(mol·K). */
export const GAS_CONSTANT = 8.314462618;

export interface AmbientState {
  readonly temperature: number;
  readonly pressure: number;
  /** Relative humidity, 0..1. Added to the dry composition when a cell is filled. */
  readonly humidity: number;
  /** Dry mass fractions over gas species, summing to one. */
  readonly composition: Readonly<Record<string, number>>;
}

/**
 * Dry air at 20 °C and one atmosphere, at 50% relative humidity.
 *
 * **Argon is lumped into nitrogen**, per the species table's own note: it is 0.93% of air and
 * chemically inert, so all it contributes is heat capacity and dilution. What that costs is
 * measurable and small — the mean molar mass comes out at 28.86 g/mol against air's real 28.96,
 * which is 0.4% — and what it buys is not carrying a sixteenth element for a gas that never reacts.
 *
 * The mass fractions are chosen so the *volume* fraction of oxygen comes back at 20.95%, because
 * that is the number every extinction criterion in `§12` is written against.
 */
export const STANDARD_AIR: AmbientState = {
  temperature: 293.15,
  pressure: STANDARD_PRESSURE_PA,
  humidity: 0.5,
  composition: { N2: 0.767074, O2: 0.232285, CO2: 0.000641 },
};

/** The gas species a field tracks unless a consumer names its own. */
export const STANDARD_FIELD_SPECIES: readonly string[] = [
  'O2',
  'N2',
  'CO2',
  'H2O(g)',
  'CO',
  'CH4',
  'H2',
  'C2H4',
  'NH3',
  'HCN',
  'HCl',
  'SO2',
];

/**
 * Saturation vapour pressure of water, Pa, by the Magnus form.
 *
 * Authoring-time: it calls `exp`, and `§7` keeps transcendentals off the tick. A field fills a new
 * cell from the ambient, which is a discrete event rather than a per-tick one, and CH-5's
 * evaporation will need this tabulated the way every rate already is.
 */
export function saturationVapourPressure(temperature: number): number {
  const celsius = temperature - 273.15;
  // determinism: build-time — a field fills a new cell from the ambient, which is a discrete event
  return 610.94 * Math.exp((17.625 * celsius) / (celsius + 243.04));
}

/**
 * Mass of each tracked species in one cell of ambient air, kg.
 *
 * From the ideal gas law at the ambient temperature and pressure, with the humidity turned into
 * water vapour by its partial pressure. Writes into `out`, one entry per field species.
 */
export function ambientCellMass(
  registry: SpeciesRegistry,
  fieldSpecies: Int32Array,
  ambient: AmbientState,
  volume: number,
  out: Float64Array,
): void {
  const vapourPressure = ambient.humidity * saturationVapourPressure(ambient.temperature);
  const dryPressure = Math.max(0, ambient.pressure - vapourPressure);
  const totalMoles = (ambient.pressure * volume) / (GAS_CONSTANT * ambient.temperature);
  const vapourMoles = (vapourPressure * volume) / (GAS_CONSTANT * ambient.temperature);
  const dryMoles = totalMoles - vapourMoles;

  /* The dry composition is by mass, so its mean molar mass is what converts moles to kilograms. */
  let inverseMean = 0;
  for (const [id, fraction] of Object.entries(ambient.composition)) {
    const species = registry.indexOf(id);
    if (species < 0) throw new Error(`ambient names "${id}", which is not a registered species`);
    inverseMean += fraction / registry.molarMass(species);
  }
  const meanMolarMass = 1 / inverseMean;
  const dryMass = dryMoles * meanMolarMass;

  out.fill(0);
  for (let i = 0; i < fieldSpecies.length; i++) {
    const id = registry.idOf(fieldSpecies[i] as number);
    const fraction = ambient.composition[id];
    if (fraction !== undefined) out[i] = fraction * dryMass;
    if (id === 'H2O(g)') {
      out[i] = (out[i] as number) + vapourMoles * registry.molarMass(fieldSpecies[i] as number);
    }
  }
  void dryPressure;
}

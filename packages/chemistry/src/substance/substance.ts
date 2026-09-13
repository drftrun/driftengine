/**
 * What a material is, thermally: a composition, a density, and the transitions it passes through.
 *
 * CH-1's half of `Substance`. The design's `§5` describes the whole of it — conductivity,
 * emissivity, porosity, shells, reactions, ignition, appearance — and each field arrives with the
 * phase that reads it. Declaring them all here with nothing reading them would be the speculative
 * abstraction `AGENTS.md` §Module rules forbids.
 */
import { ELEMENT_COUNT } from '../element/elements.ts';
import type { SpeciesRegistry } from '../species/registry.ts';
import { type Composition, massFractions } from './composition.ts';
import type { Conductivity } from '../parcel/conduction.ts';
import type { Shape } from '../parcel/shells.ts';
import type { IgnitionModel } from '../ignition/criteria.ts';

/*
 * **`PhaseTransition` is gone, and `phaseChange` in `reaction/reaction.ts` is where it went.**
 *
 * It described melting and boiling as shape in a per-substance enthalpy curve, and CH-6 retired
 * that curve: the latent heat is already in the formation enthalpies CH-0 stores, so a phase change
 * is a reaction with a temperature gate and its plateau emerges from the solver everything else
 * already uses. A substance declares it in `reactions` like anything else it can do.
 */

export interface SubstanceThermal {
  readonly id: string;
  /**
   * What it is made of **at the bottom of the curve**, as mass fractions summing to one.
   *
   * The rule matters and is not obvious: transitions are applied in ascending temperature order, so
   * a substance is authored as its coldest form. Water is `H2O(s)` with two transitions, not
   * `H2O(l)` with one in each direction. A transition whose source species is absent when it is
   * reached is refused, naming both, rather than silently doing nothing.
   */
  readonly composition: Composition;
  /** kg/m³ of the dry matter. */
  readonly density: number;
  /**
   * W/(m·K), rising with temperature. **Optional, and conduction refuses a substance without one**,
   * naming it — a thermal conductivity nobody stated is a number somebody invented, and it decides
   * whether a log takes twenty seconds or twenty minutes.
   */
  readonly conductivity?: Conductivity;
  /** How many nested shells of equal mass. Four by default; see `§4` for why not one and why not sixteen. */
  readonly shells?: number;
  /** What it is shaped like, which decides how those shells divide. A cylinder by default: a log. */
  readonly shape?: Shape;
  /**
   * Void fraction, 0..1. What decides how freely gas moves between this material and the air.
   *
   * A charcoal briquette breathes and a pane of glass does not, and that is most of the difference
   * between something that smoulders and something that does not. Zero by default, which means a
   * substance exchanges no gas at all until somebody says how open it is.
   */
  readonly porosity?: number;
  /** How readily it radiates and absorbs, 0..1. Most non-metals sit near 0.9, which is the default. */
  readonly emissivity?: number;
  /**
   * Reactions this material can undergo, by id.
   *
   * A substance's parcels track masses for its composition species **plus every species these
   * reactions touch**, so declaring one is what makes room for its products. Wood that pyrolyses
   * holds char and steam it did not start with.
   */
  readonly reactions?: readonly string[];
  /**
   * When this material catches and when it stops.
   *
   * Absent means it never catches at all, which is the right default: a substance nobody described
   * as flammable should not be, and inventing an ignition temperature for glass is worse than
   * declining to have one.
   */
  readonly ignition?: IgnitionModel;
  /**
   * What it looks like, and every field is a measurable property of the material rather than a
   * choice about how to draw it.
   *
   * Absent means a consumer supplies their own colours, which is the right default: a substance
   * nobody described the appearance of should not have one invented for it. `present/` refuses to
   * write an albedo it was never given rather than writing grey.
   */
  readonly appearance?: AppearanceModel;
}

/**
 * `§17`'s three numbers: what a material looks like before it burns, after it burns, and how dirty
 * its smoke is on the way.
 *
 * **Soot yield belongs on the substance and `§8.4` says why**: polystyrene sooting heavily and
 * methanol burning invisibly are the two ends of a scale, and which end a fuel sits at is a property
 * of the fuel. It is the one number that decides whether a fire is seen at all in daylight.
 */
export interface AppearanceModel {
  /** Linear RGB before anything happens to it. */
  readonly albedo: readonly [number, number, number];
  /** Linear RGB when it is entirely char. Near-black for anything that chars at all. */
  readonly charAlbedo: readonly [number, number, number];
  /** kg of soot per kg of volatiles burnt. Wood is about 0.015; polystyrene is 0.16. */
  readonly sootYield: number;
}

/**
 * A composition with dry-basis moisture folded into it.
 *
 * **"12% moisture content" means 12 kg of water per 100 kg of *dry* matter**, so water is
 * `m / (1 + m)` of the whole and every dry component is scaled by `1 / (1 + m)`. Treating the
 * figure as a wet-basis fraction is wrong by 1.4 points at 12% and by 33 points for green wood at
 * 60%, which is exactly the range where it decides whether a log catches fire at all.
 *
 * Water the composition already held is added to rather than replaced, because a substance can be
 * authored wet: a stew is mostly water before anybody adds moisture to it.
 */
export function wetComposition(
  registry: SpeciesRegistry,
  dry: Composition,
  moisture: number,
): Composition {
  if (!Number.isFinite(moisture) || moisture < 0) {
    throw new Error(`moisture content is ${moisture}, which is not a non-negative number`);
  }
  if (moisture === 0) return dry;

  const scale = 1 / (1 + moisture);
  const entries: Record<string, number> = {};
  for (let i = 0; i < dry.species.length; i++) {
    entries[registry.idOf(dry.species[i] as number)] = (dry.fraction[i] as number) * scale;
  }
  const water = 'H2O(l)';
  entries[water] = (entries[water] ?? 0) + moisture * scale;
  return massFractions(registry, entries);
}

/** Moles of each element in one kilogram of a composition. Writes into `out`, allocates nothing. */
export function compositionElements(
  registry: SpeciesRegistry,
  composition: Composition,
  out: Float64Array,
): void {
  if (out.length !== ELEMENT_COUNT) {
    throw new Error(`a totals vector is ${ELEMENT_COUNT} wide, not ${out.length}`);
  }
  out.fill(0);
  for (let i = 0; i < composition.species.length; i++) {
    const species = composition.species[i] as number;
    const kilograms = composition.fraction[i] as number;
    registry.elements.addScaledRow(species, kilograms / registry.molarMass(species), out);
  }
}

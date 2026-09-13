/**
 * Packing a reaction network against one owner's species set.
 *
 * Both a substance and the atmosphere run reactions, and both need the same thing: the network
 * rewritten so its species are **local slots** into the few species that owner actually holds,
 * rather than indices into all sixty-eight. A shell's composition is then a dense run and the
 * solver's inner loop is a walk rather than a lookup.
 *
 * One implementation, used by both, because two would be two things to keep in step — and the
 * second would be discovered wrong on the day a reaction behaved differently in a cell than in the
 * shell beside it.
 */
import type { SpeciesRegistry } from '../species/registry.ts';
import type { ReactionRegistry } from './registry.ts';
import type { RateTable } from './rates.ts';
import { MAX_SUBSTANCE_REACTIONS, type SubstanceReactions } from './solver.ts';

export function localiseReactions(
  species: SpeciesRegistry,
  reactions: ReactionRegistry | undefined,
  ids: readonly string[],
  set: Int32Array,
  owner: string,
): SubstanceReactions {
  if (ids.length > MAX_SUBSTANCE_REACTIONS) {
    throw new Error(
      `${owner} declares ${ids.length} reactions; the limit is ${MAX_SUBSTANCE_REACTIONS}`,
    );
  }

  const local = new Int32Array(species.count).fill(-1);
  for (let i = 0; i < set.length; i++) local[set[i] as number] = i;

  const molarMass = new Float64Array(set.length);
  const cpA = new Float64Array(set.length);
  const cpB = new Float64Array(set.length);
  for (let i = 0; i < set.length; i++) {
    const global = set[i] as number;
    molarMass[i] = species.molarMass(global);
    /* `cp(T) = cpA + cpB·(T − 298.15)`, recovered from the registry's own linear model. */
    cpA[i] = species.heatCapacityOf(global, 298.15);
    cpB[i] = species.heatCapacityOf(global, 299.15) - (cpA[i] as number);
  }

  const indices: number[] = [];
  for (const id of ids) {
    if (reactions === undefined) {
      throw new Error(`${owner} declares reaction "${id}", and no reaction registry was supplied`);
    }
    const at = reactions.indexOf(id);
    if (at < 0) throw new Error(`${owner} declares reaction "${id}", which is not registered`);
    indices.push(at);
  }

  const reactantStart = new Int32Array(indices.length + 1);
  const productStart = new Int32Array(indices.length + 1);
  const reactantLocal: number[] = [];
  const reactantMoles: number[] = [];
  const productLocal: number[] = [];
  const productMoles: number[] = [];
  const enthalpy = new Float64Array(indices.length);
  const minTemperature = new Float64Array(indices.length);
  const maxTemperature = new Float64Array(indices.length);
  const gateWidth = new Float64Array(indices.length);
  const transportLimit = new Float64Array(indices.length);
  const table: (RateTable | null)[] = [];

  const slot = (global: number, id: string): number => {
    const at = local[global] as number;
    if (at < 0) {
      throw new Error(
        `${owner} declares reaction "${id}", which touches "${species.idOf(global)}" — ` +
          'a species it does not carry',
      );
    }
    return at;
  };

  for (let r = 0; r < indices.length; r++) {
    const registry = reactions as ReactionRegistry;
    const global = indices[r] as number;
    const id = ids[r] as string;
    reactantStart[r] = reactantLocal.length;
    const rs = registry.reactantSpecies(global);
    const rm = registry.reactantMoles(global);
    for (let i = 0; i < rs.length; i++) {
      reactantLocal.push(slot(rs[i] as number, id));
      reactantMoles.push(rm[i] as number);
    }
    productStart[r] = productLocal.length;
    const ps = registry.productSpecies(global);
    const pm = registry.productMoles(global);
    for (let i = 0; i < ps.length; i++) {
      productLocal.push(slot(ps[i] as number, id));
      productMoles.push(pm[i] as number);
    }
    enthalpy[r] = registry.enthalpyOf(global);
    minTemperature[r] = registry.minTemperatureOf(global);
    maxTemperature[r] = registry.maxTemperatureOf(global);
    gateWidth[r] = registry.gateWidthOf(global);
    transportLimit[r] = registry.transportLimitOf(global);
    table.push(registry.rateTableOrNull(global));
  }
  reactantStart[indices.length] = reactantLocal.length;
  productStart[indices.length] = productLocal.length;

  return {
    count: indices.length,
    speciesCount: set.length,
    molarMass,
    cpA,
    cpB,
    minTemperature,
    maxTemperature,
    gateWidth,
    transportLimit,
    reactantStart,
    reactantLocal: Int32Array.from(reactantLocal),
    reactantMoles: Float64Array.from(reactantMoles),
    productStart,
    productLocal: Int32Array.from(productLocal),
    productMoles: Float64Array.from(productMoles),
    enthalpy,
    table,
  };
}

/**
 * What a substance family is, and how one is installed.
 *
 * **`§2` of the design applies the payload rule to *data*, which this engine has not had to do
 * before.** A substance is about forty numbers, a composition and a reaction list; forty of them is
 * a real payload and most games use ten. So each family is its own entry point, and a consumer who
 * defines three substances of their own imports none of these and pays for none of them.
 *
 * **Substances are a function of the registry rather than constants.** A composition is mass
 * fractions over species *indices*, and there are no indices until something is registered — so the
 * only honest shape is a function called once, at init, with the registry that will hold them.
 *
 * **A library may register species of its own**, and two of them do. That is better than growing
 * `species/standard.ts`: `tar` is meaningless outside a wood fire and molten wax outside a candle,
 * so putting either in the standard table would charge every consumer in the engine for both.
 */
import type { SpeciesDefinition } from '../species/species.ts';
import type { SpeciesRegistry } from '../species/registry.ts';
import type { Reaction } from '../reaction/reaction.ts';
import type { ReactionRegistry } from '../reaction/registry.ts';
import type { SubstanceRegistry } from '../substance/registry.ts';
import type { SubstanceThermal } from '../substance/substance.ts';

export interface SubstanceLibrary {
  readonly id: string;
  /** Species this family needs that the standard table does not carry. Usually none. */
  readonly species: readonly SpeciesDefinition[];
  readonly reactions: readonly Reaction[];
  substances(species: SpeciesRegistry): readonly SubstanceThermal[];
}

/**
 * Species, then reactions, then substances — **skipping whatever is already registered**.
 *
 * The skipping is the whole reason this is not three loops of `register`. Gas-phase combustion
 * belongs to every family that burns, and registering an id twice throws by design, so a consumer
 * installing `organic` and `fuel` together would otherwise fail at init on the first reaction they
 * share. Skipping also makes installing a family twice a no-op rather than a crash, which is what a
 * consumer assembling a world out of several libraries will do by accident sooner or later.
 *
 * **It does not check that the existing registration matches.** Two libraries declaring different
 * reactions under one id would silently take the first, and nothing here would say so — but every
 * id in these libraries is defined in exactly one place, and a consumer who shadows one has said
 * something deliberate. Refusing it would mean comparing stoichiometry and kinetics for equality,
 * which is a real cost at init for a case the libraries themselves cannot produce.
 */
export function installLibrary(
  library: SubstanceLibrary,
  species: SpeciesRegistry,
  reactions: ReactionRegistry,
  substances: SubstanceRegistry,
): void {
  for (const definition of library.species) {
    if (species.indexOf(definition.id) < 0) species.register(definition);
  }
  for (const reaction of library.reactions) {
    if (reactions.indexOf(reaction.id) < 0) reactions.register(reaction);
  }
  for (const substance of library.substances(species)) {
    if (substances.indexOf(substance.id) < 0) substances.define(substance);
  }
}

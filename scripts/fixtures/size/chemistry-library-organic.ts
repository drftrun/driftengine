/**
 * The model plus the `organic` family, and nothing else.
 *
 * **This is `§2`'s payload rule applied to *data*, measured.** A substance is about forty numbers, a
 * composition and a reaction list; seven families of them is a real payload and most games use one.
 * The claim is that a consumer pays only for the families they import, and the difference between
 * this figure and `chemistry-only` is what this one costs.
 */
import {
  ParcelStore,
  ReactionRegistry,
  SpeciesRegistry,
  SubstanceRegistry,
  installLibrary,
  registerStandardSpecies,
} from '@driftengine/chemistry';
import { ORGANIC } from '@driftengine/chemistry/library/organic';

/** Install the family, spawn one of everything in it, and run a tick. */
export function organic(): number {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(ORGANIC, species, reactions, substances);

  const parcels = new ParcelStore(substances);
  let total = 0;
  for (let i = 0; i < substances.count; i++) {
    const parcel = parcels.spawn({ substance: i, mass: 1, temperature: 293.15, area: 0.1 });
    parcels.addSurfaceHeat(parcel, 5000);
    parcels.conduct(parcel, 1 / 60);
    parcels.react(parcel, 1 / 60);
    total += parcels.surfaceTemperatureOf(parcel) + parcels.massFluxOf(parcel);
  }
  return total;
}

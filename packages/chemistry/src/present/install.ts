/**
 * `installChemistry` — three lines, and a consumer's oak is oak.
 *
 * **`§16` is honest about what "free" means and this file is where it lands.** Free of *authoring*:
 * a consumer never writes a reaction, never tunes an ignition temperature, never writes a state
 * machine for fire. Not free of *importing*: core does not depend on chemistry and a game with no
 * fire in it pays zero bytes, which is `ARCHITECTURE.md` §5's payload rule and this track does not
 * get an exception to it.
 *
 * So the work goes into making the wiring free, and this is it.
 */
import { ReactionRegistry } from '../reaction/registry.ts';
import { KIND_COMBUSTION, KIND_PHASE_CHANGE } from '../reaction/reaction.ts';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ParcelStore } from '../parcel/store.ts';
import { AtmosphereField } from '../field/atmosphere.ts';
import { STANDARD_AIR, STANDARD_FIELD_SPECIES, type AmbientState } from '../field/ambient.ts';
import { ChemistryWorld } from '../transport/world.ts';
import { type SubstanceLibrary, installLibrary } from '../library/library.ts';

export interface ChemistryOptions {
  /** The families this game uses. Everything else is optional. */
  readonly libraries: readonly SubstanceLibrary[];
  /** Metres per gas cell. One by default, which is a room-scale fire. */
  readonly cellSize?: number;
  readonly ambient?: AmbientState;
  /** How many 8³ chunks of air may be live at once. */
  readonly maxChunks?: number;
}

/** What a material name resolved to, and what did not resolve at all. */
export interface MatchReport {
  /** One index per name asked about, in order. `-1` where nothing matched. */
  readonly substances: readonly number[];
  readonly matched: number;
  /** Every name that matched nothing, in the order given. */
  readonly unmatched: readonly string[];
}

export interface InstalledChemistry {
  readonly species: SpeciesRegistry;
  readonly reactions: ReactionRegistry;
  readonly substances: SubstanceRegistry;
  readonly parcels: ParcelStore;
  readonly air: AtmosphereField;
  readonly world: ChemistryWorld;
  /** The gas-phase steps the installed families brought, which the air is already running. */
  readonly gasReactions: readonly string[];
  /**
   * Resolve material names to substances, **exactly**.
   *
   * **There is no synonym table and there will not be one.** `AGENTS.md` records the decision for
   * retargeting — matching is exact and there is no name database, because a table of synonyms rots
   * silently and its failure is a limb that does not move. The failure here is worse: a
   * `pine_bark_02` quietly matching `pine` is a material with the wrong ignition temperature, and
   * nobody will ever notice.
   *
   * So unmatched names come back in a list with a count, and the consumer decides.
   */
  match(names: readonly string[]): MatchReport;
}

/**
 * A world with the given families in it, and everything wired to everything else.
 *
 * **Every option after `libraries` removes a capability when omitted rather than breaking.** No
 * ambient: standard air. No cell size: one metre. That is `§16`'s arrangement, and the reason none
 * of them is required is that a consumer who has not decided yet should still get a fire.
 *
 * **The gas-phase reactions come from the libraries rather than from the caller.** A family knows
 * what its own volatiles are, and a consumer who forgot to pass `burn-tar` would have a fire that
 * made smoke and no flame — which is a silent wrong answer rather than an error.
 */
export function installChemistry(options: ChemistryOptions): InstalledChemistry {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  for (const library of options.libraries) {
    installLibrary(library, species, reactions, substances);
  }

  /*
   * Every combustion step any installed family declared, which is what a flame is made of — and the
   * species those steps touch, which is what the air has to be able to carry.
   *
   * **Both are derived rather than asked for.** A consumer who installed `organic` and then forgot
   * to name `burn-tar` would have a fire that made smoke and no flame, and one who named the
   * reaction but not the `tar` species would be refused at init with a message about a field they
   * never configured. Neither is a decision worth exposing.
   */
  const gasReactions: string[] = [];
  const carried = new Set<string>(STANDARD_FIELD_SPECIES);
  for (let r = 0; r < reactions.count; r++) {
    if (reactions.kindOf(r) !== KIND_COMBUSTION) continue;
    gasReactions.push(reactions.idOf(r));
    for (const s of reactions.reactantSpecies(r)) carried.add(species.idOf(s));
    for (const s of reactions.productSpecies(r)) carried.add(species.idOf(s));
  }

  /*
   * **And every phase change whose reactants the air already holds, which is what condenses smoke.**
   *
   * Combustion alone left a hole: `library/organic` condenses tar to droplets below its dew point,
   * which is a `KIND_PHASE_CHANGE` and is the only thing that happens to the volatiles off a
   * *smouldering* surface — no flame over it, so nothing burns and nothing cracks. Without this the
   * pale smoke a smoulder makes has no source and the tar drifts away invisible.
   *
   * **Derived by the same rule as the line above rather than declared**, and the rule is one
   * sentence: a reaction the air can run is one whose inputs are already in the air. That admits
   * `condense-tar`, because a combustion step above put `tar` in the set, and then `evaporate-tar`,
   * because the first one put `tar(l)` there — which is why this is a fixpoint and not a pass. It
   * declines `melt-ice` and `boil-water` and every `vaporise-*` in `library/fuel`, because a lump of
   * ice and a puddle of diesel are not things the air holds, and the combustion steps burn the
   * *vapours* rather than the liquids they come from. And it would admit `boil-water` the day
   * something put liquid water into a cell, which is right: a droplet suspended in warm air really
   * does evaporate.
   *
   * The alternative was a `gasReactions` list on `SubstanceLibrary`, which this file already argues
   * against for combustion: a library author who forgot to add one would ship a fire whose smoke
   * never whitened, and nothing would say so. The cost of deriving is that the set is a closure a
   * consumer cannot read off their own library — so `gasReactions` is returned, and the demo panel
   * prints it.
   */
  for (let grew = true; grew;) {
    grew = false;
    for (let r = 0; r < reactions.count; r++) {
      if (reactions.kindOf(r) !== KIND_PHASE_CHANGE) continue;
      const id = reactions.idOf(r);
      if (gasReactions.includes(id)) continue;
      let inTheAir = true;
      for (const s of reactions.reactantSpecies(r)) {
        if (!carried.has(species.idOf(s))) inTheAir = false;
      }
      if (!inTheAir) continue;
      gasReactions.push(id);
      for (const s of reactions.productSpecies(r)) carried.add(species.idOf(s));
      grew = true;
    }
  }

  const parcels = new ParcelStore(substances);
  const air = new AtmosphereField(species, {
    cellSize: options.cellSize ?? 1,
    ambient: options.ambient ?? STANDARD_AIR,
    maxChunks: options.maxChunks,
    species: [...carried],
    reactions,
    reactionIds: gasReactions,
  });
  const world = new ChemistryWorld(parcels, air);

  return {
    species,
    reactions,
    substances,
    parcels,
    air,
    world,
    gasReactions,
    match(names: readonly string[]): MatchReport {
      const resolved: number[] = [];
      const unmatched: string[] = [];
      let matched = 0;
      for (const name of names) {
        const index = substances.indexOf(name);
        resolved.push(index);
        if (index >= 0) matched++;
        else unmatched.push(name);
      }
      return { substances: resolved, matched, unmatched };
    },
  };
}

/** Mass, volume, area and characteristic thickness, from a box. */
export interface ParcelBox {
  readonly mass: number;
  readonly volume: number;
  readonly area: number;
  /** Volume over area, which is the depth conduction divides into shells. */
  readonly thickness: number;
}

/**
 * Sensible parcel numbers from a bounding box and a density.
 *
 * **`§16`'s third mechanism**: a consumer with meshes gets parcels without measuring anything, and a
 * consumer who cares supplies real numbers instead. The area is all six faces, which is right for
 * something in the open and generous for something lying on a hearth — and being generous is the
 * safe direction, because it makes things heat slightly faster rather than mysteriously refusing to.
 */
export function parcelFromBounds(
  width: number,
  height: number,
  depth: number,
  density: number,
): ParcelBox {
  const volume = width * height * depth;
  const area = 2 * (width * height + height * depth + depth * width);
  return {
    mass: volume * density,
    volume,
    area,
    thickness: area > 0 ? volume / area : 0,
  };
}

/**
 * The substances a world knows about, and the enthalpy curve each one resolves through.
 *
 * A curve is expensive to build and constant for the life of a substance, so it is built once here
 * rather than per parcel. Two hundred oak logs share one curve, which is what makes the whole
 * approach affordable: the per-parcel cost of a temperature is a binary search over 256 knots and
 * nothing else.
 *
 * A substance is an `i32` index after registration, the convention CH-0 established for a species
 * and `drift/physics` established for a body.
 */
import { type ConductionModel } from '../parcel/conduction.ts';
import { SHAPE_CYLINDER, shellGeometry } from '../parcel/shells.ts';
import type { SpeciesRegistry } from '../species/registry.ts';
import type { AppearanceModel, SubstanceThermal } from './substance.ts';
import type { IgnitionModel } from '../ignition/criteria.ts';
import type { ReactionRegistry } from '../reaction/registry.ts';
import { MAX_SUBSTANCE_SPECIES, type SubstanceReactions } from '../reaction/solver.ts';
import { localiseReactions } from '../reaction/localise.ts';

export class SubstanceRegistry {
  private readonly ids: string[] = [];
  private readonly byId = new Map<string, number>();
  private readonly definitions: SubstanceThermal[] = [];
  private readonly conduction: ConductionModel[] = [];
  /**
   * One conduction model per shell count a tier can reduce this substance to, indexed by that count.
   *
   * **Built at registration, because `shellGeometry` calls `Math.cbrt`** and `§15` keeps that off the
   * simulation path entirely — its result is not pinned down by ECMAScript. A level-of-detail tier
   * that computed geometry when it changed would have put it back there. Four shapes and at most
   * sixteen counts is nothing to precompute and the alternative is a determinism hole.
   */
  private readonly byShellCount: (ConductionModel | null)[][] = [];
  private readonly reactionModels: SubstanceReactions[] = [];
  /** Global species indices this substance's parcels track, ascending. */
  private readonly speciesSets: Int32Array[] = [];
  /** Global species index to local slot, or -1. One row per substance. */
  private readonly localSlots: Int32Array[] = [];
  private readonly densities: number[] = [];
  private readonly porosities: number[] = [];
  private readonly emissivities: number[] = [];
  private readonly ignitions: (IgnitionModel | null)[] = [];
  private readonly appearances: (AppearanceModel | null)[] = [];

  constructor(
    readonly species: SpeciesRegistry,
    private readonly reactions?: ReactionRegistry,
  ) {}

  get count(): number {
    return this.ids.length;
  }

  define(substance: SubstanceThermal): number {
    if (this.byId.has(substance.id)) {
      throw new Error(`substance "${substance.id}" is already registered`);
    }
    if (!(substance.density > 0)) {
      throw new Error(`substance "${substance.id}" has a density of ${substance.density}`);
    }
    /* The shell geometry is a pure function of a shape and a count, so it is resolved here once and
       multiplied by a parcel's own depth at use — which keeps `Math.cbrt`, whose result ECMAScript
       does not pin down, off the simulation path entirely. */
    const geometry = shellGeometry(substance.shape ?? SHAPE_CYLINDER, substance.shells ?? 4);

    const { set, local, model } = this.buildReactions(substance);

    const index = this.ids.length;
    this.speciesSets.push(set);
    this.localSlots.push(local);
    this.reactionModels.push(model);
    const conductivity = substance.conductivity ?? null;
    this.conduction.push({ geometry, conductivity });
    const shape = substance.shape ?? SHAPE_CYLINDER;
    const perCount: (ConductionModel | null)[] = [null];
    for (let count = 1; count <= geometry.count; count++) {
      perCount.push({ geometry: shellGeometry(shape, count), conductivity });
    }
    this.byShellCount.push(perCount);
    this.ids.push(substance.id);
    this.byId.set(substance.id, index);
    this.definitions.push(substance);
    this.densities.push(substance.density);
    this.porosities.push(substance.porosity ?? 0);
    this.emissivities.push(substance.emissivity ?? 0.9);
    this.ignitions.push(substance.ignition ?? null);
    this.appearances.push(substance.appearance ?? null);
    return index;
  }

  indexOf(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  idOf(substance: number): string {
    return this.ids[this.check(substance)] as string;
  }

  conductionOf(substance: number): ConductionModel {
    return this.conduction[this.check(substance)] as ConductionModel;
  }

  /**
   * The conduction model for a substance resolved to `shells`, which a tier may have reduced it to.
   *
   * Precomputed at registration; see `byShellCount` for why it is not derived on demand.
   */
  conductionAt(substance: number, shells: number): ConductionModel {
    const row = this.byShellCount[this.check(substance)] as (ConductionModel | null)[];
    const model = shells >= 1 && shells < row.length ? row[shells] : null;
    return model ?? (this.conduction[substance] as ConductionModel);
  }

  densityOf(substance: number): number {
    return this.densities[this.check(substance)] as number;
  }

  /** Void fraction, 0..1. Zero means it exchanges no gas with the air at all. */
  porosityOf(substance: number): number {
    return this.porosities[this.check(substance)] as number;
  }

  /** How readily it radiates and absorbs, 0..1. */
  emissivityOf(substance: number): number {
    return this.emissivities[this.check(substance)] as number;
  }

  /** When this material catches, or `null` where nobody said it does. */
  ignitionOf(substance: number): IgnitionModel | null {
    return this.ignitions[this.check(substance)] as IgnitionModel | null;
  }

  /**
   * What it looks like, or `null` where nobody said.
   *
   * `null` rather than a grey default: `present/` writes nothing for a substance with no appearance
   * rather than inventing one, so a consumer sees their own material unchanged instead of finding
   * the engine has quietly recoloured it.
   */
  appearanceOf(substance: number): AppearanceModel | null {
    return this.appearances[this.check(substance)] as AppearanceModel | null;
  }

  definitionOf(substance: number): SubstanceThermal {
    return this.definitions[this.check(substance)] as SubstanceThermal;
  }

  /** Global species indices this substance's parcels carry, ascending. */
  speciesSetOf(substance: number): Int32Array {
    return this.speciesSets[this.check(substance)] as Int32Array;
  }

  /** The local slot a global species occupies for this substance, or -1. */
  localSlotOf(substance: number, species: number): number {
    const row = this.localSlots[this.check(substance)] as Int32Array;
    return species >= 0 && species < row.length ? (row[species] as number) : -1;
  }

  reactionsOf(substance: number): SubstanceReactions {
    return this.reactionModels[this.check(substance)] as SubstanceReactions;
  }

  /**
   * The species set and the localised, packed reaction network.
   *
   * The set is the composition's species plus everything its reactions touch, so a shell's
   * composition is a dense run of the few species it can hold rather than a row over all
   * sixty-eight. Built here, once, because it is a property of the substance.
   */
  private buildReactions(substance: SubstanceThermal): {
    set: Int32Array;
    local: Int32Array;
    model: SubstanceReactions;
  } {
    const ids = substance.reactions ?? [];

    const present = new Set<number>();
    for (const s of substance.composition.species) present.add(s);
    if (this.reactions !== undefined) {
      for (const id of ids) {
        const r = this.reactions.indexOf(id);
        if (r < 0)
          throw new Error(
            `substance "${substance.id}" declares reaction "${id}", which is not registered`,
          );
        for (const sp of this.reactions.reactantSpecies(r)) present.add(sp);
        for (const sp of this.reactions.productSpecies(r)) present.add(sp);
      }
    } else if (ids.length > 0) {
      throw new Error(
        `substance "${substance.id}" declares reactions, and this registry was built with none`,
      );
    }
    const set = Int32Array.from([...present].sort((a, b) => a - b));
    if (set.length > MAX_SUBSTANCE_SPECIES) {
      throw new Error(
        `substance "${substance.id}" would track ${set.length} species; the limit is ${MAX_SUBSTANCE_SPECIES}`,
      );
    }
    const local = new Int32Array(this.species.count).fill(-1);
    for (let i = 0; i < set.length; i++) local[set[i] as number] = i;

    return {
      set,
      local,
      model: localiseReactions(
        this.species,
        this.reactions,
        ids,
        set,
        `substance "${substance.id}"`,
      ),
    };
  }

  private check(substance: number): number {
    if (!Number.isInteger(substance) || substance < 0 || substance >= this.ids.length) {
      throw new Error(`substance ${substance} is outside a registry of ${this.ids.length}`);
    }
    return substance;
  }
}

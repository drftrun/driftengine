/**
 * Parcels: lumps of matter with an identity, in structure-of-arrays typed columns.
 *
 * A parcel is a log, a steak, a puddle, a wall panel, a barrel of oil. It is **not** a mesh, a body
 * or an entity — it is bound to one by a handle the consumer keeps, and it knows nothing about what
 * it is bound to. That is what lets the package import no other engine package.
 *
 * **Enthalpy in joules, mass in kilograms, and temperature is neither.** The store holds a total
 * and the curve holds a specific value, so two kilograms at one temperature hold twice the enthalpy
 * of one and `temperatureOf` divides before it looks up. Every column is `Float64Array`, per `§15`:
 * enthalpy differences across a burn span twelve orders of magnitude and `Float32Array` loses the
 * small ones, which is not an optimisation to revisit later.
 *
 * **One lump, one temperature, until CH-2.** The design's parcel has a depth stack of shells, and
 * without it a thick log heats through as fast as a twig — which is the single most important thing
 * a fire model has to get right. That is CH-2's, and this store is shaped to grow into it: a shell
 * is another stride on the enthalpy column and nothing above it changes.
 *
 * **A destroyed handle is never reused.** Physics numbers bodies the same way, and reuse without a
 * generation lets a stale handle address a live parcel. Compaction is a budget question and belongs
 * with the rest of them in CH-6; until then a destroyed parcel costs its columns and nothing else.
 */
import { sensibleEnthalpy, temperatureFromCapacity } from '../species/thermal.ts';
import type { SubstanceRegistry } from '../substance/registry.ts';
import { conductShells } from './conduction.ts';
import { MAX_SUBSTANCE_SPECIES, reactShell } from '../reaction/solver.ts';
import { ELEMENT_COUNT } from '../element/elements.ts';
import { MAX_SHELLS, shellGeometry } from './shells.ts';
import {
  TIER_CADENCE,
  TIER_HERO,
  TIER_SHELLS,
  TIER_SUBSTEPS,
  type Tier,
  foldShare,
  foldSpan,
} from './tier.ts';
import { PHASE_GAS, PHASE_LIQUID, PHASE_SOLID } from '../species/species.ts';
import type { AppearanceModel } from '../substance/substance.ts';
import type { IgnitionModel } from '../ignition/criteria.ts';

/** Parcels held before the first growth. Doubles from here. */
const INITIAL_CAPACITY = 64;

/* Scratch for a fold, module-level so a tier change on a hot path allocates nothing. */
const foldScratch = new Float64Array(MAX_SHELLS * MAX_SUBSTANCE_SPECIES);
const foldEnthalpy = new Float64Array(MAX_SHELLS);

/**
 * A parcel made of more than one phase at once, which is most of them.
 *
 * Not a `Phase`, because it is not one: wet wood is a solid and a liquid together, and the design's
 * `§20.3` gives it its own value rather than making a consumer guess which half was reported.
 */
export const PHASE_MIXED = 3;

/** Share of a parcel's mass one phase must hold before that phase is the answer. */
const PHASE_DOMINANT = 0.95;

/** Share of a shell's mass that must be char before the shell counts as charred through. */
const CHAR_SHELL_FRACTION = 0.5;

const FLAG_BURNING = 1;
const FLAG_SMOULDERING = 2;
const FLAG_PILOT = 4;
const FLAG_SLEEPING = 8;

/**
 * Ticks a parcel must be still for before it sleeps, and how still "still" is.
 *
 * `§14`: "a parcel whose net flux is below a threshold, whose composition changed by less than a
 * threshold last tick, and which has been that way for `N` ticks, sleeps." The counter is what stops
 * a parcel that is merely between two events from being put to sleep and woken every other tick,
 * which would cost more than never sleeping it.
 *
 * The flux threshold is three orders of magnitude below the critical mass flux at piloted ignition,
 * so nothing anywhere near catching is ever asleep.
 */
const QUIET_TICKS = 30;
const QUIET_FLUX = 1e-6;
/** Joules per second of reaction output below which a parcel counts as chemically still. */
const QUIET_RELEASE = 1e-3;

/**
 * What a parcel is made of and how big it is. An object rather than seven positional arguments,
 * which is how `PhysicsWorld.addBody` takes a body and for the same reason.
 */
export interface ParcelSpec {
  readonly substance: number;
  readonly mass: number;
  /** K. Every shell starts here. */
  readonly temperature: number;
  /**
   * Exposed surface area, m². Optional, and **conduction refuses a parcel without one**, naming it:
   * a characteristic depth is volume over area, so a parcel with no area has no depth and there is
   * no honest default to invent. `parcelFromBounds` supplies it from a bounding box in CH-9.
   */
  readonly area?: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

export class ParcelStore {
  private substance = new Int32Array(INITIAL_CAPACITY);
  private mass = new Float64Array(INITIAL_CAPACITY);
  /** Strided by `MAX_SHELLS`: shell `s` of parcel `p` is at `p * MAX_SHELLS + s`, in joules. */
  private enthalpy = new Float64Array(INITIAL_CAPACITY * MAX_SHELLS);
  private area = new Float64Array(INITIAL_CAPACITY);
  private x = new Float64Array(INITIAL_CAPACITY);
  private y = new Float64Array(INITIAL_CAPACITY);
  private z = new Float64Array(INITIAL_CAPACITY);
  private live = new Uint8Array(INITIAL_CAPACITY);
  /** `FLAG_BURNING | FLAG_SMOULDERING | FLAG_PILOT`. */
  private flags = new Uint8Array(INITIAL_CAPACITY);
  /** kg/(m²·s) of gas leaving the surface, and of the combustible part of it. */
  private flux = new Float64Array(INITIAL_CAPACITY);
  private fuelFlux = new Float64Array(INITIAL_CAPACITY);
  /**
   * Watts the reactions put into this parcel over the last `react`, and it is a *readout*.
   *
   * **A fire's size is its heat release rate**, not its temperature — every fire-engineering figure
   * in the design is quoted in kilowatts — and it cannot be recovered from outside, because
   * conduction and a radiative source change the same enthalpy in the same tick. So it is measured
   * where only reactions are running, by summing the thermal enthalpy either side of them. That sum
   * is one pass over at most sixteen shells, which is nothing against the reaction step it brackets.
   */
  private release = new Float64Array(INITIAL_CAPACITY);
  /** Which of `§14`'s four tiers each parcel is being simulated at. */
  private tier = new Uint8Array(INITIAL_CAPACITY);
  /** Shells actually resolved right now, which a tier may reduce below what the substance declared. */
  private shells = new Int32Array(INITIAL_CAPACITY);
  /** Seconds owed to a parcel its cadence has been skipping, handed over when its turn comes. */
  private owed = new Float64Array(INITIAL_CAPACITY);
  /** Consecutive ticks a parcel has been still. At `QUIET_TICKS` it sleeps. */
  private quiet = new Int32Array(INITIAL_CAPACITY);
  /**
   * Where each parcel's composition block starts, and the block itself.
   *
   * A block is `shells × the substance's own species count` kilograms — **dense over the few
   * species that substance can hold**, not a row over all sixty-eight. Blocks are appended and
   * never moved, which is what makes an offset stable; compaction is a budget question and belongs
   * with the rest of them in CH-6.
   */
  private compositionOffset = new Int32Array(INITIAL_CAPACITY);
  private composition = new Float64Array(INITIAL_CAPACITY * 8);
  private compositionUsed = 0;
  private used = 0;

  constructor(
    private readonly substances: SubstanceRegistry,
    private readonly species = substances.species,
  ) {}

  /** Handles ever issued, live or not. A destroyed parcel still occupies its index. */
  get count(): number {
    return this.used;
  }

  spawn(spec: ParcelSpec): number {
    const { substance, mass, temperature } = spec;
    if (!(mass > 0) || !Number.isFinite(mass)) {
      throw new Error(`a parcel was spawned with a mass of ${mass}`);
    }
    const area = spec.area ?? 0;
    if (area < 0 || !Number.isFinite(area)) {
      throw new Error(`a parcel was spawned with a surface area of ${spec.area}`);
    }
    /* Resolves the substance, which refuses an index this registry never issued. */
    const thermal = this.substances.reactionsOf(substance);
    if (this.used === this.substance.length) this.grow();

    const parcel = this.used++;
    this.substance[parcel] = substance;
    this.mass[parcel] = mass;
    const count = this.substances.conductionOf(substance).geometry.count;
    const shellMass = mass / count;

    /* The composition block: every shell starts as the substance says it is made. */
    const set = this.substances.speciesSetOf(substance);
    const block = count * set.length;
    while (this.compositionUsed + block > this.composition.length) {
      const grown = new Float64Array(this.composition.length * 2);
      grown.set(this.composition);
      this.composition = grown;
    }
    this.compositionOffset[parcel] = this.compositionUsed;
    this.composition.fill(0, this.compositionUsed, this.compositionUsed + block);
    const source = this.substances.definitionOf(substance).composition;
    for (let i = 0; i < source.species.length; i++) {
      const local = this.substances.localSlotOf(substance, source.species[i] as number);
      const kilograms = (source.fraction[i] as number) * shellMass;
      for (let shell = 0; shell < count; shell++) {
        this.composition[this.compositionUsed + shell * set.length + local] = kilograms;
      }
    }

    /* Enthalpy from what the shell actually holds, at the temperature asked for. Written after the
       composition rather than before, because with CH-6's model it is a function of it. */
    for (let shell = 0; shell < count; shell++) {
      const base = this.compositionUsed + shell * set.length;
      let joules = 0;
      for (let i = 0; i < set.length; i++) {
        const kilograms = this.composition[base + i] as number;
        if (kilograms === 0) continue;
        joules +=
          kilograms *
          sensibleEnthalpy(thermal.cpA[i] as number, thermal.cpB[i] as number, temperature);
      }
      this.enthalpy[parcel * MAX_SHELLS + shell] = joules;
    }
    this.compositionUsed += block;
    this.area[parcel] = area;
    this.x[parcel] = spec.x ?? 0;
    this.y[parcel] = spec.y ?? 0;
    this.z[parcel] = spec.z ?? 0;
    this.live[parcel] = 1;
    this.flags[parcel] = 0;
    this.flux[parcel] = 0;
    this.fuelFlux[parcel] = 0;
    this.release[parcel] = 0;
    this.tier[parcel] = TIER_HERO;
    this.shells[parcel] = count;
    this.owed[parcel] = 0;
    this.quiet[parcel] = 0;
    return parcel;
  }

  /** m², what the environment touches. Zero means the caller has not said, and conduction refuses. */
  areaOf(parcel: number): number {
    return this.area[this.check(parcel)] as number;
  }

  destroy(parcel: number): void {
    this.live[this.check(parcel)] = 0;
  }

  alive(parcel: number): boolean {
    if (!Number.isInteger(parcel) || parcel < 0 || parcel >= this.used) return false;
    return this.live[parcel] === 1;
  }

  substanceOf(parcel: number): number {
    return this.substance[this.check(parcel)] as number;
  }

  massOf(parcel: number): number {
    return this.mass[this.check(parcel)] as number;
  }

  /** m³, from mass and the substance's density. Shrinks as mass leaves, which is why a log burns down. */
  volumeOf(parcel: number): number {
    const at = this.check(parcel);
    return (this.mass[at] as number) / this.substances.densityOf(this.substance[at] as number);
  }

  /** How many shells this parcel's substance divides it into. */
  /**
   * Shells resolved right now, which a level-of-detail tier may have reduced.
   *
   * Everything that walks a parcel's depth reads this rather than the substance's declared count, so
   * a `Distant` log is one shell everywhere at once and nothing has to be told which tier it is at.
   */
  shellCount(parcel: number): number {
    return this.shells[this.check(parcel)] as number;
  }

  /** What the substance asked for, which is the resolution `Hero` restores to. */
  declaredShellsOf(parcel: number): number {
    return this.substances.conductionOf(this.substance[this.check(parcel)] as number).geometry
      .count;
  }

  tierOf(parcel: number): Tier {
    return this.tier[this.check(parcel)] as Tier;
  }

  /** Ticks between updates at this parcel's tier. `§14`'s cadence column. */
  cadenceOf(parcel: number): number {
    return TIER_CADENCE[this.tier[this.check(parcel)] as number] as number;
  }

  /** The most sub-steps a reaction solve will take at this parcel's tier. */
  substepsOf(parcel: number): number {
    return TIER_SUBSTEPS[this.tier[this.check(parcel)] as number] as number;
  }

  /**
   * Move a parcel to a tier, **conserving mass, every element and enthalpy exactly**.
   *
   * `§14`: "a tier change does not lose or gain mass or energy... which is the property that makes
   * the LOD safe to apply to a burning object mid-burn." Shells are equal-mass by construction, so a
   * fold is a proportional redistribution — target `j` takes source shells `[j·n/m, (j+1)·n/m)`,
   * splitting one where the ratio is not an integer — and the targets come out equal-mass too.
   *
   * **What it loses is the profile inside a fold**, which is the point of a tier: two shells at
   * 400 K and 300 K become one at their mass-weighted mean, and going back up hands each of them the
   * same mean. Resolution in depth is what a distant object gives away.
   */
  setTier(parcel: number, tier: Tier): void {
    const at = this.check(parcel);
    const declared = this.declaredShellsOf(at);
    const wanted = Math.min(declared, TIER_SHELLS[tier] as number);
    this.tier[at] = tier;
    const current = this.shells[at] as number;
    if (wanted === current) return;
    this.refold(at, current, wanted);
    this.shells[at] = wanted;
  }

  /**
   * Redistribute a parcel's `from` shells into `to`, exactly.
   *
   * One pass into scratch and one pass back, because a fold reads every source before it has written
   * any target and doing it in place would read a slot it had already overwritten.
   */
  private refold(at: number, from: number, to: number): void {
    const substance = this.substance[at] as number;
    const width = this.substances.speciesSetOf(substance).length;
    const start = this.compositionOffset[at] as number;

    for (let j = 0; j < to; j++) {
      const span = foldSpan(from, to, j);
      let joules = 0;
      for (let s = 0; s < width; s++) foldScratch[j * MAX_SUBSTANCE_SPECIES + s] = 0;
      for (let i = 0; i < from; i++) {
        const share = foldShare(i, span.start, span.end);
        if (share === 0) continue;
        for (let s = 0; s < width; s++) {
          foldScratch[j * MAX_SUBSTANCE_SPECIES + s] =
            (foldScratch[j * MAX_SUBSTANCE_SPECIES + s] as number) +
            (this.composition[start + i * width + s] as number) * share;
        }
        joules += (this.enthalpy[at * MAX_SHELLS + i] as number) * share;
      }
      foldEnthalpy[j] = joules;
    }

    for (let j = 0; j < to; j++) {
      for (let s = 0; s < width; s++) {
        this.composition[start + j * width + s] = foldScratch[
          j * MAX_SUBSTANCE_SPECIES + s
        ] as number;
      }
      this.enthalpy[at * MAX_SHELLS + j] = foldEnthalpy[j] as number;
    }
    /* Beyond the new count nothing is read, and leaving stale values there would show up the day
       somebody added a loop over `MAX_SHELLS` instead of over `shellCount`. */
    for (let j = to; j < from; j++) {
      for (let s = 0; s < width; s++) this.composition[start + j * width + s] = 0;
      this.enthalpy[at * MAX_SHELLS + j] = 0;
    }
  }

  /** Total joules held across every shell, not joules per kilogram. */
  enthalpyOf(parcel: number): number {
    const at = this.check(parcel);
    const count = this.shellCount(at);
    let total = 0;
    for (let i = 0; i < count; i++) total += this.enthalpy[at * MAX_SHELLS + i] as number;
    return total;
  }

  shellEnthalpyOf(parcel: number, shell: number): number {
    return this.enthalpy[
      this.check(parcel) * MAX_SHELLS + this.checkShell(parcel, shell)
    ] as number;
  }

  /**
   * The temperature of one shell, K. Shell 0 is the surface and the last is the core.
   *
   * **`surfaceTemperatureOf` is what decides ignition and `coreTemperatureOf` is what decides
   * doneness**, and the gap between them is the whole reason shells exist.
   */
  shellTemperatureOf(parcel: number, shell: number): number {
    const at = this.check(parcel);
    const index = this.checkShell(at, shell);
    const substance = this.substance[at] as number;
    const thermal = this.substances.reactionsOf(substance);
    const width = this.substances.speciesSetOf(substance).length;
    const base = (this.compositionOffset[at] as number) + index * width;
    let A = 0;
    let B = 0;
    for (let i = 0; i < width; i++) {
      const kilograms = this.composition[base + i] as number;
      if (kilograms === 0) continue;
      A += kilograms * (thermal.cpA[i] as number);
      B += kilograms * (thermal.cpB[i] as number);
    }
    return temperatureFromCapacity(A, B, this.enthalpy[at * MAX_SHELLS + index] as number);
  }

  surfaceTemperatureOf(parcel: number): number {
    return this.shellTemperatureOf(parcel, 0);
  }

  coreTemperatureOf(parcel: number): number {
    return this.shellTemperatureOf(parcel, this.shellCount(parcel) - 1);
  }

  positionX(parcel: number): number {
    return this.x[this.check(parcel)] as number;
  }

  positionY(parcel: number): number {
    return this.y[this.check(parcel)] as number;
  }

  positionZ(parcel: number): number {
    return this.z[this.check(parcel)] as number;
  }

  move(parcel: number, x: number, y: number, z: number): void {
    const at = this.check(parcel);
    this.x[at] = x;
    this.y[at] = y;
    this.z[at] = z;
  }

  /**
   * The temperature this parcel would have if it were stirred, K.
   *
   * A read rather than a stored field, and that is the design. Nothing writes a temperature except
   * `setTemperature`, which writes the enthalpy that produces one — so a parcel on a plateau simply
   * does not move, and no code anywhere had to know a plateau exists.
   *
   * **The temperature of the total enthalpy**, not the mean of the shell temperatures. The two
   * differ wherever the curve bends, and only this one has the property that matters: heat in,
   * temperature out, with nothing lost between them.
   */
  temperatureOf(parcel: number): number {
    const at = this.check(parcel);
    const substance = this.substance[at] as number;
    const thermal = this.substances.reactionsOf(substance);
    const width = this.substances.speciesSetOf(substance).length;
    const count = this.shellCount(at);
    const start = this.compositionOffset[at] as number;
    let A = 0;
    let B = 0;
    for (let shell = 0; shell < count; shell++) {
      const base = start + shell * width;
      for (let i = 0; i < width; i++) {
        const kilograms = this.composition[base + i] as number;
        if (kilograms === 0) continue;
        A += kilograms * (thermal.cpA[i] as number);
        B += kilograms * (thermal.cpB[i] as number);
      }
    }
    return temperatureFromCapacity(A, B, this.enthalpyOf(at));
  }

  /** Joules in, spread evenly through the depth. Negative cools. A microwave, or a stirred pot. */
  addHeat(parcel: number, joules: number): void {
    const at = this.check(parcel);
    this.wake(at);
    const count = this.shellCount(at);
    const share = joules / count;
    for (let i = 0; i < count; i++) {
      this.enthalpy[at * MAX_SHELLS + i] = (this.enthalpy[at * MAX_SHELLS + i] as number) + share;
    }
  }

  /**
   * Joules into shell 0 alone, which is what a flux from outside actually does.
   *
   * Every radiative, convective and contact term in CH-5 lands here. The difference between this
   * and `addHeat` is the difference between a log in front of a fire and a log in an oven.
   */
  addSurfaceHeat(parcel: number, joules: number): void {
    const at = this.check(parcel);
    this.wake(at);
    this.enthalpy[at * MAX_SHELLS] = (this.enthalpy[at * MAX_SHELLS] as number) + joules;
  }

  /**
   * Conduct heat inward one step of `dt` seconds.
   *
   * Conserves this parcel's total enthalpy exactly — the arithmetic is in `conduction.ts` and so is
   * the reason.
   */
  conduct(parcel: number, dt: number): void {
    const at = this.check(parcel);
    const substance = this.substance[at] as number;
    /* The geometry for the shells this parcel is *currently* resolved to, which its tier decides. */
    const model = this.substances.conductionAt(substance, this.shells[at] as number);
    if (model.geometry.count < 2) return;
    if (model.conductivity === null) {
      throw new Error(
        `substance "${this.substances.idOf(substance)}" has no conductivity, so it cannot conduct`,
      );
    }
    const area = this.area[at] as number;
    if (!(area > 0)) {
      throw new Error(
        `parcel ${parcel} has no surface area, and a characteristic depth is volume over area`,
      );
    }
    const volume = (this.mass[at] as number) / this.substances.densityOf(substance);
    const depth = (model.geometry.depthFactor * volume) / area;
    conductShells(
      this.enthalpy,
      at * MAX_SHELLS,
      model,
      this.substances.reactionsOf(substance),
      this.composition,
      this.compositionOffset[at] as number,
      (this.mass[at] as number) / model.geometry.count,
      area,
      depth,
      dt,
    );
  }

  /**
   * Force a temperature by writing the enthalpy that produces it.
   *
   * For authoring and for tests. **Not for a tick**: it discards whatever enthalpy the parcel held,
   * so a boiling parcel set to its own boiling point loses however much of the plateau it had
   * crossed, and the energy budget does not close across the call.
   */
  setTemperature(parcel: number, temperature: number): void {
    const at = this.check(parcel);
    const count = this.shellCount(at);
    for (let i = 0; i < count; i++) this.setShellTemperature(at, i, temperature);
  }

  /** Force one shell's temperature. Authoring and tests only, for the reason above. */
  setShellTemperature(parcel: number, shell: number, temperature: number): void {
    const at = this.check(parcel);
    const index = this.checkShell(at, shell);
    const substance = this.substance[at] as number;
    const thermal = this.substances.reactionsOf(substance);
    const width = this.substances.speciesSetOf(substance).length;
    const base = (this.compositionOffset[at] as number) + index * width;
    let joules = 0;
    for (let i = 0; i < width; i++) {
      const kilograms = this.composition[base + i] as number;
      if (kilograms === 0) continue;
      joules +=
        kilograms *
        sensibleEnthalpy(thermal.cpA[i] as number, thermal.cpB[i] as number, temperature);
    }
    this.enthalpy[at * MAX_SHELLS + index] = joules;
  }

  /** Kilograms of one species in one shell. Zero where the substance cannot hold it at all. */
  speciesMassOf(parcel: number, shell: number, species: number): number {
    const at = this.check(parcel);
    const index = this.checkShell(at, shell);
    const substance = this.substance[at] as number;
    const local = this.substances.localSlotOf(substance, species);
    if (local < 0) return 0;
    const width = this.substances.speciesSetOf(substance).length;
    return this.composition[
      (this.compositionOffset[at] as number) + index * width + local
    ] as number;
  }

  /** The same, summed over every shell. */
  parcelSpeciesMass(parcel: number, species: number): number {
    const at = this.check(parcel);
    const count = this.shellCount(at);
    let total = 0;
    for (let shell = 0; shell < count; shell++) total += this.speciesMassOf(at, shell, species);
    return total;
  }

  /** Kilograms in one shell, summed over its species. Invariant under reaction. */
  shellMassOf(parcel: number, shell: number): number {
    const at = this.check(parcel);
    const index = this.checkShell(at, shell);
    const substance = this.substance[at] as number;
    const width = this.substances.speciesSetOf(substance).length;
    const start = (this.compositionOffset[at] as number) + index * width;
    let total = 0;
    for (let i = 0; i < width; i++) total += this.composition[start + i] as number;
    return total;
  }

  /** Moles of each element this parcel holds. Writes into `out`, allocates nothing. */
  elementTotalsOf(parcel: number, out: Float64Array): void {
    if (out.length !== ELEMENT_COUNT) {
      throw new Error(`a totals vector is ${ELEMENT_COUNT} wide, not ${out.length}`);
    }
    const at = this.check(parcel);
    const substance = this.substance[at] as number;
    const set = this.substances.speciesSetOf(substance);
    const model = this.substances.reactionsOf(substance);
    const count = this.shellCount(at);
    const start = this.compositionOffset[at] as number;
    out.fill(0);
    for (let shell = 0; shell < count; shell++) {
      for (let i = 0; i < set.length; i++) {
        const kilograms = this.composition[start + shell * set.length + i] as number;
        if (kilograms === 0) continue;
        this.species.elements.addScaledRow(
          set[i] as number,
          kilograms / (model.molarMass[i] as number),
          out,
        );
      }
    }
  }

  /**
   * Energy locked in this parcel's chemical bonds, J.
   *
   * Neither this nor the thermal enthalpy is conserved on its own — a reaction moves energy between
   * them. **Their sum is**, exactly, because the same number is added to one and taken from the
   * other in `reactShell`.
   */
  chemicalEnergyOf(parcel: number): number {
    const at = this.check(parcel);
    const substance = this.substance[at] as number;
    const set = this.substances.speciesSetOf(substance);
    const model = this.substances.reactionsOf(substance);
    const count = this.shellCount(at);
    const start = this.compositionOffset[at] as number;
    let total = 0;
    for (let shell = 0; shell < count; shell++) {
      for (let i = 0; i < set.length; i++) {
        const kilograms = this.composition[start + shell * set.length + i] as number;
        if (kilograms === 0) continue;
        total +=
          (kilograms / (model.molarMass[i] as number)) *
          this.species.formationEnthalpyOf(set[i] as number);
      }
    }
    return total;
  }

  /** Run this parcel's reactions in every shell for `dt` seconds. */
  react(parcel: number, dt: number, transportFactor = 1): void {
    const at = this.check(parcel);
    const substance = this.substance[at] as number;
    const model = this.substances.reactionsOf(substance);
    if (model.count === 0) {
      this.release[at] = 0;
      return;
    }
    const count = this.shellCount(at);
    /* Bracketing the reaction step is the only place heat release can honestly be read: outside it,
       conduction and a radiative source have moved the same joules in the same tick. */
    const before = this.thermalEnthalpy(at, count);
    const width = this.substances.speciesSetOf(substance).length;
    const start = this.compositionOffset[at] as number;
    const shellMass = (this.mass[at] as number) / count;
    for (let shell = 0; shell < count; shell++) {
      reactShell(
        this.composition,
        start + shell * width,
        this.enthalpy,
        at * MAX_SHELLS + shell,
        model,
        shellMass,
        dt,
        transportFactor,
      );
    }
    this.release[at] = dt > 0 ? (this.thermalEnthalpy(at, count) - before) / dt : 0;
  }

  /** Joules of sensible heat across a parcel's shells. One pass over at most sixteen doubles. */
  private thermalEnthalpy(at: number, count: number): number {
    let total = 0;
    for (let shell = 0; shell < count; shell++) {
      total += this.enthalpy[at * MAX_SHELLS + shell] as number;
    }
    return total;
  }

  /**
   * Whether this parcel is being skipped entirely.
   *
   * `§14`'s thermal quiescence, and the vocabulary is deliberately Track B's. A cold stone floor is a
   * thousand of these and costs a bounded scan.
   */
  sleeping(parcel: number): boolean {
    return ((this.flags[this.check(parcel)] as number) & FLAG_SLEEPING) !== 0;
  }

  /**
   * Wake it, and reset the count that would put it back.
   *
   * **Called by everything that could change what a parcel is**: heat arriving, water poured on,
   * mass added, a contact, or a source coming within range. Cheap enough — a flag and an integer —
   * that a caller never has to decide whether it is worth it.
   */
  wake(parcel: number): void {
    const at = this.check(parcel);
    this.flags[at] = (this.flags[at] as number) & ~FLAG_SLEEPING;
    this.quiet[at] = 0;
  }

  /**
   * Decide whether this parcel is still enough to sleep, and put it to sleep if it has been for long
   * enough. Returns whether it is now asleep.
   *
   * **A burning or smouldering parcel never sleeps, whatever its numbers say.** A steady flame is a
   * *steady* parcel by every measure here, and sleeping one would put out a fire by optimising it.
   */
  settle(parcel: number): boolean {
    const at = this.check(parcel);
    if (((this.flags[at] as number) & (FLAG_BURNING | FLAG_SMOULDERING)) !== 0) {
      this.quiet[at] = 0;
      return false;
    }
    const still =
      (this.flux[at] as number) < QUIET_FLUX &&
      Math.abs(this.release[at] as number) < QUIET_RELEASE;
    if (!still) {
      this.quiet[at] = 0;
      this.flags[at] = (this.flags[at] as number) & ~FLAG_SLEEPING;
      return false;
    }
    const count = (this.quiet[at] as number) + 1;
    this.quiet[at] = count;
    if (count < QUIET_TICKS) return false;
    this.flags[at] = (this.flags[at] as number) | FLAG_SLEEPING;
    return true;
  }

  /**
   * Seconds this parcel is owed by its cadence, and whether its turn has come.
   *
   * A `Far` parcel is stepped every fourth tick with four ticks of `dt`, so the same seconds are
   * integrated either way — which is what makes a cadence conserving for free rather than by care.
   */
  accrue(parcel: number, dt: number): number {
    const at = this.check(parcel);
    const owed = (this.owed[at] as number) + dt;
    const cadence = TIER_CADENCE[this.tier[at] as number] as number;
    if (cadence <= 1 || owed >= dt * cadence * 0.999999) {
      this.owed[at] = 0;
      return owed;
    }
    this.owed[at] = owed;
    return 0;
  }

  /** Whether a flame stands over this parcel. */
  burning(parcel: number): boolean {
    return ((this.flags[this.check(parcel)] as number) & FLAG_BURNING) !== 0;
  }

  /** Whether its char is glowing, which needs no flame and far less oxygen. */
  smouldering(parcel: number): boolean {
    return ((this.flags[this.check(parcel)] as number) & FLAG_SMOULDERING) !== 0;
  }

  /** Whether a pilot is present this tick. */
  piloted(parcel: number): boolean {
    return ((this.flags[this.check(parcel)] as number) & FLAG_PILOT) !== 0;
  }

  /**
   * Supply a pilot for one tick. **This does not start a fire**, and `§11` is why.
   *
   * Ignition is five conditions, and a pilot is one of them. Holding a match to wet wood does
   * exactly nothing here, which is correct and is the API telling the truth about what a match is.
   */
  ignite(parcel: number): void {
    this.wake(parcel);
    this.flags[this.check(parcel)] = (this.flags[parcel] as number) | FLAG_PILOT;
  }

  /** Put the flame out. Embers survive, which is the point — see `§12`. */
  douse(parcel: number): void {
    this.flags[this.check(parcel)] = (this.flags[parcel] as number) & ~FLAG_BURNING;
  }

  setBurning(parcel: number, burning: boolean): void {
    const at = this.check(parcel);
    this.flags[at] = burning
      ? (this.flags[at] as number) | FLAG_BURNING
      : (this.flags[at] as number) & ~FLAG_BURNING;
  }

  setSmouldering(parcel: number, smouldering: boolean): void {
    const at = this.check(parcel);
    this.flags[at] = smouldering
      ? (this.flags[at] as number) | FLAG_SMOULDERING
      : (this.flags[at] as number) & ~FLAG_SMOULDERING;
  }

  clearPilot(parcel: number): void {
    this.flags[this.check(parcel)] = (this.flags[parcel] as number) & ~FLAG_PILOT;
  }

  /** kg/(m²·s) of gas leaving the surface, all of it. */
  massFluxOf(parcel: number): number {
    return this.flux[this.check(parcel)] as number;
  }

  /**
   * And of the part of it that can burn — which is the criterion ignition turns on.
   *
   * The two differ by exactly what a wet log gives off. Steam leaving a surface counts toward
   * diluting the mixture above it and not toward feeding it, which is why 60% moisture stops a log
   * catching in front of a fire that lights a seasoned one in eighty seconds.
   */
  fuelFluxOf(parcel: number): number {
    return this.fuelFlux[this.check(parcel)] as number;
  }

  setMassFlux(parcel: number, total: number, fuel: number): void {
    const at = this.check(parcel);
    this.flux[at] = total > 0 ? total : 0;
    this.fuelFlux[at] = fuel > 0 ? fuel : 0;
  }

  /**
   * Watts the reactions released last step: positive exothermic, negative endothermic.
   *
   * **A fire's size is its heat release rate**, which is what every figure in the design is quoted
   * against and is not the temperature. A pyrolysing surface reads *negative* here while it is
   * gasifying, which is right and is why a flame has to keep feeding heat back to sustain one.
   */
  heatReleaseOf(parcel: number): number {
    return this.release[this.check(parcel)] as number;
  }

  /**
   * Kilograms of water per kilogram of dry matter — **the dry basis, which is how it is quoted**.
   *
   * "12% moisture content" means twelve kilograms of water per hundred of dry wood, and
   * `wetComposition` folded that into a wet-basis 0.107 to store it. Undoing the same conversion
   * here is what makes a script comparing against the 0.25 that decides whether a log is worth
   * burning read the quantity the author wrote.
   *
   * Ice counts as water. A frozen log is not a dry one.
   */
  moistureOf(parcel: number): number {
    const at = this.check(parcel);
    const liquid = this.species.indexOf('H2O(l)');
    const solid = this.species.indexOf('H2O(s)');
    let water = 0;
    if (liquid >= 0) water += this.parcelSpeciesMass(at, liquid);
    if (solid >= 0) water += this.parcelSpeciesMass(at, solid);
    const dry = (this.mass[at] as number) - water;
    return dry > 0 ? water / dry : 0;
  }

  /**
   * `PHASE_SOLID`, `PHASE_LIQUID`, `PHASE_GAS`, or `PHASE_MIXED` where no one of them dominates.
   *
   * Mixed is a real answer rather than a failure to decide: wet wood is wood and water at once, and
   * calling it either would be a lie a consumer would then draw.
   */
  parcelPhaseOf(parcel: number): number {
    const at = this.check(parcel);
    const substance = this.substance[at] as number;
    const set = this.substances.speciesSetOf(substance);
    const count = this.shellCount(at);
    const start = this.compositionOffset[at] as number;
    let total = 0;
    let solid = 0;
    let liquid = 0;
    let gas = 0;
    for (let shell = 0; shell < count; shell++) {
      for (let i = 0; i < set.length; i++) {
        const kilograms = this.composition[start + shell * set.length + i] as number;
        if (kilograms === 0) continue;
        total += kilograms;
        const phase = this.species.phaseOf(set[i] as number);
        if (phase === PHASE_SOLID) solid += kilograms;
        else if (phase === PHASE_LIQUID) liquid += kilograms;
        else gas += kilograms;
      }
    }
    if (!(total > 0)) return PHASE_MIXED;
    const dominant = PHASE_DOMINANT * total;
    if (solid >= dominant) return PHASE_SOLID;
    if (liquid >= dominant) return PHASE_LIQUID;
    if (gas >= dominant) return PHASE_GAS;
    return PHASE_MIXED;
  }

  /**
   * Kilograms of **free** water on the surface, per square metre of it.
   *
   * **Free, meaning beyond what the material holds as its own moisture**, and that distinction is
   * the whole reading. A seasoned oak log carries 12% water on a dry basis and is not glossy; a log
   * somebody threw a bucket over is. Reporting the shell's total water would make the two identical
   * and every piece of wood in a scene look rained on.
   *
   * **Derived rather than a column**, because `wet` puts real water in the surface shell rather than
   * setting a flag — so `§17`'s wet-film roughness reads a quantity the boiling reaction is
   * simultaneously consuming, which is what makes drying visible.
   */
  wetnessOf(parcel: number): number {
    const at = this.check(parcel);
    const area = this.area[at] as number;
    if (!(area > 0)) return 0;
    const water = this.species.indexOf('H2O(l)');
    if (water < 0) return 0;

    /*
     * Measured **on a dry basis against the shell's own dry matter**, which is the one formulation
     * that is stable under pouring water on it. Against a fraction of the shell's *total* mass, the
     * baseline would grow with every drop added and a bucket would read as a third of itself.
     */
    const substance = this.substance[at] as number;
    const composition = this.substances.definitionOf(substance).composition;
    let wetBasis = 0;
    for (let i = 0; i < composition.species.length; i++) {
      if (composition.species[i] === water) wetBasis = composition.fraction[i] as number;
    }
    if (!(wetBasis < 1)) return 0;
    const held = this.speciesMassOf(at, 0, water);
    const dry = this.shellMassOf(at, 0) - held;
    const authored = dry * (wetBasis / (1 - wetBasis));
    const free = held - authored;
    return free > 0 ? free / area : 0;
  }

  /**
   * Pour water on it: liquid water into the surface shell, where the boiling reaction will find it.
   *
   * **Not a flag, and that is the whole point.** The heat sink `§12` describes is the same
   * 2.44 MJ/kg every other drop of water in this model carries, so a doused fire goes out for the
   * reason a real one does and a light sprinkling on a hot ember does not.
   *
   * Refused, naming the substance, where that substance cannot hold water at all — which means it
   * declares no reaction that touches it. Silently doing nothing would make "I poured a bucket on
   * it" and "this material has no water in its model" indistinguishable.
   */
  wet(parcel: number, kilograms: number): void {
    const at = this.check(parcel);
    this.wake(at);
    if (!(kilograms > 0)) return;
    const water = this.species.indexOf('H2O(l)');
    const substance = this.substance[at] as number;
    if (water < 0 || this.substances.localSlotOf(substance, water) < 0) {
      throw new Error(
        `parcel ${parcel} is ${this.substances.idOf(substance)}, which holds no liquid water — ` +
          'declare a reaction that touches `H2O(l)`, such as `boil-water`, to make it wettable',
      );
    }
    this.addSpeciesMass(at, 0, water, kilograms);
    this.mass[at] = (this.mass[at] as number) + kilograms;
  }

  /** Take surface water away: a cloth, a hot dry pan, or wind. Never below what is there. */
  dry(parcel: number, kilograms: number): void {
    const at = this.check(parcel);
    if (!(kilograms > 0)) return;
    const water = this.species.indexOf('H2O(l)');
    if (water < 0 || this.substances.localSlotOf(this.substance[at] as number, water) < 0) return;
    const held = this.speciesMassOf(at, 0, water);
    const taken = kilograms < held ? kilograms : held;
    this.addSpeciesMass(at, 0, water, -taken);
    this.mass[at] = (this.mass[at] as number) - taken;
  }

  /**
   * Metres of char measured inward from the surface.
   *
   * The shells that are mostly carbon, summed by their own thickness. A shell counts once it is past
   * half char, which is a threshold on a continuum and is said out loud: a finer answer needs a char
   * *front* within a shell, which is a sub-shell quantity this model does not carry.
   */
  charDepthOf(parcel: number): number {
    const at = this.check(parcel);
    const char = this.species.indexOf('C(char)');
    if (char < 0) return 0;
    const count = this.shellCount(at);
    let depth = 0;
    for (let shell = 0; shell < count; shell++) {
      const mass = this.shellMassOf(at, shell);
      if (!(mass > 0)) continue;
      if (this.speciesMassOf(at, shell, char) / mass < CHAR_SHELL_FRACTION) break;
      depth += this.shellDepthOf(at, shell);
    }
    return depth;
  }

  /**
   * How much of this parcel is still load-bearing, 1 down to 0.
   *
   * **`§18` refuses structural failure in writing and this is the refusal reporting.** A beam whose
   * char depth has eaten a fraction of its thickness has lost that fraction of its strength, and
   * what happens next — a joint releasing, a body splitting, a building coming down — belongs to
   * whoever owns the solver. This package writes the scalar, emits an event at a threshold, and
   * breaks nothing.
   */
  structuralIntegrityOf(parcel: number): number {
    const at = this.check(parcel);
    const count = this.shellCount(at);
    let thickness = 0;
    for (let shell = 0; shell < count; shell++) thickness += this.shellDepthOf(at, shell);
    if (!(thickness > 0)) return 1;
    const left = 1 - this.charDepthOf(at) / thickness;
    return left > 0 ? (left < 1 ? left : 1) : 0;
  }

  /**
   * Pour `from` into `into`; `from` is consumed. Mass, elements and enthalpy all conserved exactly.
   *
   * **Both must be the same substance, and two that are not are refused naming both.** Two
   * substances are two species sets and two shell counts, so mixing them would silently discard
   * whichever set was narrower — and a stew is not a substance change. What a consumer combining two
   * genuinely different materials wants is a third substance that is the mixture, authored as one.
   */
  mix(from: number, into: number): void {
    const a = this.check(from);
    const b = this.check(into);
    if (a === b) return;
    const substance = this.substance[a] as number;
    if (substance !== (this.substance[b] as number)) {
      throw new Error(
        `cannot mix ${this.substances.idOf(substance)} into ` +
          `${this.substances.idOf(this.substance[b] as number)}: two substances are two species ` +
          'sets, and a mixture of them is a third substance rather than either',
      );
    }
    const set = this.substances.speciesSetOf(substance);
    const countA = this.shellCount(a);
    const countB = this.shellCount(b);
    const startA = this.compositionOffset[a] as number;
    const startB = this.compositionOffset[b] as number;

    /* Spread over the receiver's shells in proportion to what each already holds, so a hot core
       stays hotter than a cold surface rather than being averaged flat. */
    const massB = this.mass[b] as number;
    for (let shell = 0; shell < countB; shell++) {
      const share = massB > 0 ? this.shellMassOf(b, shell) / massB : 1 / countB;
      for (let i = 0; i < set.length; i++) {
        let incoming = 0;
        for (let s = 0; s < countA; s++)
          incoming += this.composition[startA + s * set.length + i] as number;
        this.composition[startB + shell * set.length + i] =
          (this.composition[startB + shell * set.length + i] as number) + incoming * share;
      }
      let joules = 0;
      for (let s = 0; s < countA; s++) joules += this.enthalpy[a * MAX_SHELLS + s] as number;
      this.enthalpy[b * MAX_SHELLS + shell] =
        (this.enthalpy[b * MAX_SHELLS + shell] as number) + joules * share;
    }
    this.mass[b] = massB + (this.mass[a] as number);
    this.destroy(a);
  }

  /**
   * Joules into one named shell.
   *
   * The difference between this and `addSurfaceHeat` is a microwave and an oven: one deposits where
   * the field penetrates to, the other at the surface. Nothing here decides which is physical.
   */
  addShellHeat(parcel: number, shell: number, joules: number): void {
    const at = this.check(parcel);
    this.wake(at);
    const index = this.checkShell(at, shell);
    this.enthalpy[at * MAX_SHELLS + index] =
      (this.enthalpy[at * MAX_SHELLS + index] as number) + joules;
  }

  /**
   * What fraction of its original volume is left, as mass leaves it.
   *
   * **The number a shrinking log is drawn from.** A parcel's volume is its mass over its substance's
   * density, and the density does not change — so this is simply what share of the mass is still
   * here, which falls as volatiles leave and rises for nothing.
   */
  volumeShareOf(parcel: number): number {
    const at = this.check(parcel);
    let held = 0;
    const count = this.shellCount(at);
    for (let shell = 0; shell < count; shell++) held += this.shellMassOf(at, shell);
    const original = this.mass[at] as number;
    return original > 0 ? held / original : 0;
  }

  /**
   * Joules per kelvin of the surface shell, from what it is made of right now.
   *
   * **What every explicit surface term has to be bounded against.** A flux times an area times a
   * step is joules, and joules into a small enough shell is an arbitrarily large temperature change
   * — so a term that does not know this number cannot tell the difference between heating something
   * and destroying it. `ChemistryWorld` uses it to stop a radiative or convective step carrying a
   * surface past the thing driving it.
   */
  surfaceHeatCapacityOf(parcel: number): number {
    const at = this.check(parcel);
    const substance = this.substance[at] as number;
    const set = this.substances.speciesSetOf(substance);
    const model = this.substances.reactionsOf(substance);
    const start = this.compositionOffset[at] as number;
    const temperature = this.shellTemperatureOf(at, 0);
    let capacity = 0;
    for (let i = 0; i < set.length; i++) {
      const kilograms = this.composition[start + i] as number;
      if (kilograms === 0) continue;
      capacity +=
        kilograms * ((model.cpA[i] as number) + (model.cpB[i] as number) * (temperature - 273.15));
    }
    return capacity;
  }

  /** What this parcel's substance looks like, or `null` where nobody said. */
  appearanceOf(parcel: number): AppearanceModel | null {
    return this.substances.appearanceOf(this.substance[this.check(parcel)] as number);
  }

  /** Share of this parcel's mass that is char, 0..1. */
  charFractionOf(parcel: number): number {
    const at = this.check(parcel);
    const char = this.species.indexOf('C(char)');
    if (char < 0) return 0;
    const mass = this.mass[at] as number;
    return mass > 0 ? this.parcelSpeciesMass(at, char) / mass : 0;
  }

  /** Add (or with a negative value, remove) mass of one species in one shell. */
  addSpeciesMass(parcel: number, shell: number, species: number, kilograms: number): void {
    const at = this.check(parcel);
    this.wake(at);
    const index = this.checkShell(at, shell);
    const substance = this.substance[at] as number;
    const local = this.substances.localSlotOf(substance, species);
    if (local < 0) {
      throw new Error(
        `parcel ${parcel} is ${this.substances.idOf(substance)}, which cannot hold ` +
          `"${this.species.idOf(species)}"`,
      );
    }
    const width = this.substances.speciesSetOf(substance).length;
    const slot = (this.compositionOffset[at] as number) + index * width + local;
    const next = (this.composition[slot] as number) + kilograms;
    this.composition[slot] = next > 0 ? next : 0;
  }

  /** How many substances this store's registry holds. `fingerprintChemistry` covers all of them. */
  get substanceCount(): number {
    return this.substances.count;
  }

  /**
   * A number standing for what a registered substance *is*, for the fingerprint.
   *
   * Its density, porosity, emissivity, shell count and the species it can hold — enough that two
   * libraries differing anywhere disagree here, and cheap enough to compute once a tick. `§15` asks
   * for the registry to be covered because two worlds with different substances are different
   * worlds, and a replay crossing them should say so rather than diverge later.
   */
  substanceDigestOf(substance: number): number {
    const set = this.substances.speciesSetOf(substance);
    let digest =
      this.substances.densityOf(substance) +
      this.substances.porosityOf(substance) * 7 +
      this.substances.emissivityOf(substance) * 13 +
      set.length * 31;
    for (let i = 0; i < set.length; i++) digest += (set[i] as number) * (i + 1);
    return digest;
  }

  /** Global species indices this parcel's substance can hold. */
  speciesSetOf(substance: number): Int32Array {
    return this.substances.speciesSetOf(substance);
  }

  idOfSpecies(species: number): string {
    return this.species.idOf(species);
  }

  phaseOf(species: number): number {
    return this.species.phaseOf(species);
  }

  emissivityOf(parcel: number): number {
    return this.substances.emissivityOf(this.substance[this.check(parcel)] as number);
  }

  /** When this parcel's substance catches, or `null` where nobody said it does. */
  ignitionOf(substance: number): IgnitionModel | null {
    return this.substances.ignitionOf(substance);
  }

  porosityOf(parcel: number): number {
    return this.substances.porosityOf(this.substance[this.check(parcel)] as number);
  }

  /** W/(m·K) at a temperature, or zero where the substance never said. */
  conductivityOf(parcel: number, temperature: number): number {
    const model = this.substances.conductionOf(this.substance[this.check(parcel)] as number);
    const k = model.conductivity;
    if (k === null) return 0;
    const value = k.k0 + k.k1 * (temperature - 298.15);
    return value > 0 ? value : 0;
  }

  /** Metres from the outside of shell `shell` to the inside of it. */
  shellDepthOf(parcel: number, shell: number): number {
    const at = this.check(parcel);
    const index = this.checkShell(at, shell);
    const substance = this.substance[at] as number;
    /* At the shells this parcel is currently resolved to: a `Distant` log is one thick shell, and a
       depth read against the declared four would be a quarter of the real thing. */
    const model = this.substances.conductionAt(substance, this.shells[at] as number);
    const area = this.area[at] as number;
    if (!(area > 0)) return 0;
    const volume = (this.mass[at] as number) / this.substances.densityOf(substance);
    const depth = (model.geometry.depthFactor * volume) / area;
    return depth * (model.geometry.thicknessFraction[index] as number);
  }

  private checkShell(parcel: number, shell: number): number {
    const count = this.shellCount(parcel);
    if (!Number.isInteger(shell) || shell < 0 || shell >= count) {
      throw new Error(`shell ${shell} is outside a parcel of ${count}`);
    }
    return shell;
  }

  private grow(): void {
    const size = this.substance.length * 2;
    const substance = new Int32Array(size);
    substance.set(this.substance);
    this.substance = substance;
    /* Explicitly `Float64Array<ArrayBuffer>` rather than inferred: TypeScript 7 parameterises a
       typed array by its buffer, and an unannotated parameter widens to `ArrayBufferLike` — which
       includes `SharedArrayBuffer` and so will not assign back to the fields. */
    const grow64 = (from: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> => {
      const to = new Float64Array(size);
      to.set(from);
      return to;
    };
    this.mass = grow64(this.mass);
    this.area = grow64(this.area);
    const enthalpy = new Float64Array(size * MAX_SHELLS);
    enthalpy.set(this.enthalpy);
    this.enthalpy = enthalpy;
    this.x = grow64(this.x);
    this.y = grow64(this.y);
    this.z = grow64(this.z);
    const live = new Uint8Array(size);
    live.set(this.live);
    this.live = live;
    const flags = new Uint8Array(size);
    flags.set(this.flags);
    this.flags = flags;
    this.flux = grow64(this.flux);
    this.fuelFlux = grow64(this.fuelFlux);
    this.release = grow64(this.release);
    this.owed = grow64(this.owed);
    const tier = new Uint8Array(size);
    tier.set(this.tier);
    this.tier = tier;
    const shells = new Int32Array(size);
    shells.set(this.shells);
    this.shells = shells;
    const quiet = new Int32Array(size);
    quiet.set(this.quiet);
    this.quiet = quiet;
    const offsets = new Int32Array(size);
    offsets.set(this.compositionOffset);
    this.compositionOffset = offsets;
  }

  private check(parcel: number): number {
    if (!Number.isInteger(parcel) || parcel < 0 || parcel >= this.used) {
      throw new Error(`parcel ${parcel} is outside a store of ${this.used}`);
    }
    if (this.live[parcel] !== 1) {
      throw new Error(`parcel ${parcel} was destroyed`);
    }
    return parcel;
  }
}

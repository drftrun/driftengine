/**
 * One atmosphere, sampled by everything that breathes, burns or smokes.
 *
 * `AGENTS.md` has a section called *One wind, sampled once*, whose argument is that a second wind
 * is a scene that does not cohere. **The same argument applies with more force to the air**, which
 * is what carries oxygen to a fire and smoke away from it: two disagreeing airs give a fire that is
 * starved in one system and rich in another, and nobody can see why.
 *
 * **Sparse chunks of 8³ cells, and empty space costs nothing.** A chunk exists only where something
 * has put matter into it; everywhere else reads from the far field, which is a constant. A read of
 * empty air creates nothing, so a world with one campfire in it holds one chunk.
 *
 * **Masses rather than moles**, which is the same choice a parcel makes and for a better reason
 * than consistency: it lets the gas-phase network run through **the same solver a shell does**.
 * `§8.4`'s combustion is not a second implementation of `§7`'s substep-and-clamp — it is that one,
 * given a cell instead of a shell.
 *
 * **What this is not, and `§1` says it in writing:** not computational fluid dynamics. There is no
 * pressure projection and no incompressibility constraint. A plume rises, bends and spreads, and it
 * does not curl into the vortex rings a real one makes.
 */
import { ELEMENT_COUNT } from '../element/elements.ts';
import type { SpeciesRegistry } from '../species/registry.ts';
import { PHASE_LIQUID } from '../species/species.ts';
import { localiseReactions } from '../reaction/localise.ts';
import type { ReactionRegistry } from '../reaction/registry.ts';
import { type SubstanceReactions, reactShell } from '../reaction/solver.ts';
import {
  type AmbientState,
  GAS_CONSTANT,
  STANDARD_AIR,
  STANDARD_FIELD_SPECIES,
  ambientCellMass,
  saturationVapourPressure,
} from './ambient.ts';

/** Cells along one edge of a chunk. */
export const CHUNK_CELLS = 8;

/** Metres along one edge of a chunk, at the default cell size. */
export const CHUNK_SIZE = 8;

/**
 * Extinction per kilogram of soot per cubic metre, m²/kg.
 *
 * Smoke's mass-specific extinction coefficient, which is what turns a soot concentration into a
 * visibility. The value is the one measured for flaming-fire smoke; smouldering smoke scatters
 * rather than absorbs and runs lower.
 */
const SOOT_EXTINCTION = 8700;

/** Koschmieder's constant: the contrast threshold that defines "can no longer see it". */
const VISIBILITY_CONSTANT = 3.912;

/**
 * The saturation vapour pressure table: 256 knots over 200-500 K.
 *
 * Below 200 K there is no liquid water to be in equilibrium with and above 500 K saturation is well
 * past any pressure this model runs at, so both ends clamp rather than extrapolate. Linear over a
 * curve whose logarithm changes by 6% per kelvin costs under a tenth of a percent at this spacing,
 * which is inside the spread of the Magnus coefficients themselves.
 */
const SATURATION_MIN = 200;
const SATURATION_MAX = 500;
const SATURATION_KNOTS = 256;

const CELLS_PER_CHUNK = CHUNK_CELLS * CHUNK_CELLS * CHUNK_CELLS;

/** m/s². */
const GRAVITY = 9.80665;

/**
 * How long a buoyant parcel accelerates before drag holds it, seconds.
 *
 * Half a second gives a cell at 800 K a rise of about 3 m/s, which is what a real fire plume does.
 * A proper answer would come from an entrainment model; this is the one number standing in for one.
 */
const BUOYANT_TIME = 0.5;

/** m/s. Past this a plume is moving faster than anything this model resolves. */
const MAX_BUOYANT_SPEED = 12;

/** How fast a pressure difference across a face equalises, per second. */
const PRESSURE_RELAX = 8;

/**
 * The most of a cell one face may move in one sub-step.
 *
 * **A tenth, and the number is a conservation constraint rather than a taste.** Faces are computed
 * independently and summed into the delta, so a cell has three faces that can drain it by bulk flow
 * and six that can drain it by diffusion. At the 0.4 this started at, those together could take
 * more than the cell held — and the non-negativity clamp in the apply pass would quietly absorb the
 * difference, which is mass created from nothing.
 *
 * It was found by an element-conservation assertion sitting at 8.6e-9 instead of at zero, which is
 * exactly the class of bug that assertion exists for: too small to see, and not going away.
 * 3 × 0.1 by bulk plus 6 × 0.1 by diffusion is 0.9, so the clamp is now a backstop that never fires.
 */
const MAX_FACE_FRACTION = 0.1;

const MAX_TRANSPORT_SUBSTEPS = 16;

/** kg. Below this a cell is the outdoors as far as spreading is concerned. */
const AMBIENT_EPSILON = 1e-9;

/** J. The same idea for heat: a tenth of a joule in a cubic metre of air is not a plume. */
const ENTHALPY_EPSILON = 0.1;

export interface AtmosphereOptions {
  /** Metres per cell. One by default, which makes a chunk eight metres across. */
  readonly cellSize?: number;
  readonly ambient?: AmbientState;
  /** Gas species to track. Twelve by default; a consumer may name fewer and pay less. */
  readonly species?: readonly string[];
  /**
   * How many chunks the live set may grow to before its edge becomes far field.
   *
   * A plume growing the live set is correct — smoke really does reach new ground — and unbounded
   * growth is not. Past the cap a boundary face vents to the ambient instead of creating a
   * neighbour, which degrades a plume into a dissipating one rather than failing.
   */
  readonly maxChunks?: number;
  /** How fast an open boundary equalises with the far field, per second. */
  readonly openness?: number;
  /** Diffusivity between neighbouring cells, m²/s. */
  readonly diffusivity?: number;
  /** Where `reactionIds` are looked up. */
  readonly reactions?: ReactionRegistry;
  /**
   * Gas-phase reactions to run in every cell, by id.
   *
   * `§8.4`'s combustion, and it is **not a second implementation** of the solver a shell uses — it
   * is that one, given a cell. Which is what makes a flame stand off a surface rather than sit on
   * it: burning is something the *air* does, in the place where the mixture is right.
   */
  readonly reactionIds?: readonly string[];
}

export class AtmosphereField {
  readonly cellSize: number;
  readonly cellVolume: number;
  readonly ambient: AmbientState;
  /** Global species indices this field tracks, in storage order. */
  readonly species: Int32Array;

  /** kg per species per cell, then one enthalpy per cell, then soot and aerosol. */
  private readonly chunks: Float64Array[] = [];
  private readonly blocked: Uint8Array[] = [];
  private readonly coords: Int32Array[] = [];
  private readonly byKey = new Map<number, number>();
  /** Each chunk's packed `key(cx, cy, cz)`, parallel to `chunks`. */
  private readonly keys: number[] = [];
  /**
   * Chunk indices in **key order**, which is the order every sweep and every reduction walks.
   *
   * **`chunks` is in creation order and creation order is history.** Two runs of one world that
   * realise their chunks in a different sequence — a consumer spawning two logs the other way round
   * is enough — hold identical per-cell state in differently-ordered arrays, and every `+=` over
   * them then lands in a different order. Floating-point addition is not associative, so the answer
   * differs in the last bit, and `fingerprintChemistry` reports a divergence that did not happen.
   *
   * Worse than the report: the sweep accumulates into shared `deltas`, so the *state* diverges too
   * and a stiff exponential rate law grows the difference. Measured before this existed: two logs
   * eight metres apart, spawned in the other order, left **1,202 cells** differing after sixty
   * ticks.
   *
   * `key` is a pure function of the chunk's coordinates, so this order is a fact about geometry and
   * nothing else. Maintained by insertion at creation, which is rare; the sweeps pay one indirection
   * per chunk, not per cell.
   */
  private readonly order: number[] = [];
  /** Scratch for one sweep round, so the walk does not observe chunks created during it. */
  private round: Int32Array;
  /** Which sweep last visited each chunk, so a chunk created mid-sweep is swept exactly once. */
  private readonly sweptAt: number[] = [];
  private pass = 0;
  private readonly stride: number;
  private readonly enthalpySlot: number;
  private readonly sootSlot: number;
  private readonly aerosolSlot: number;
  /** Where `C(soot)` sits among the tracked species, or -1 where this field does not carry it. */
  private readonly sootSpecies: number;
  /** Slots of every carried species in the liquid phase: droplets, which is what an aerosol is. */
  private readonly aerosolSpecies: Int32Array;

  /** One cell of untouched air, filled once and copied into every new cell. */
  readonly maxChunks: number;
  private readonly openness: number;
  private readonly diffusivity: number;
  /** Deltas for one step, so no cell sees a neighbour a previous cell already changed. */
  private readonly deltas: Float64Array[] = [];
  /** What has left through an open boundary: per species, then enthalpy, soot and aerosol. */
  private readonly vented: Float64Array;
  private ventedEnthalpyTotal = 0;

  private readonly ambientCell: Float64Array;
  private readonly ambientEnthalpy: number;
  private readonly ambientMass: number;
  /**
   * The ambient temperature **as `cellTemperature` computes it**, not as it was authored.
   *
   * The same arithmetic over the same doubles in the same order, so a cell that has been realised
   * and one that has not report the identical number. See `temperatureAt`.
   */
  private readonly ambientTemperatureExact: number;
  /** `saturationVapourPressure` sampled once, so `exp` never runs on a query. */
  private readonly saturationTable = new Float64Array(SATURATION_KNOTS);
  private readonly network: SubstanceReactions | null;
  private readonly combustible: Int32Array;
  private readonly molarMass: Float64Array;
  /** J/(kg·K) at the standard state, one per tracked species. Resolved once. */
  private readonly heatCapacity: Float64Array;
  private readonly localOf: Int32Array;

  constructor(
    private readonly registry: SpeciesRegistry,
    options: AtmosphereOptions = {},
  ) {
    this.cellSize = options.cellSize ?? 1;
    if (!(this.cellSize > 0)) throw new Error(`a cell is ${this.cellSize} m across`);
    this.cellVolume = this.cellSize * this.cellSize * this.cellSize;
    this.ambient = options.ambient ?? STANDARD_AIR;

    const ids = options.species ?? STANDARD_FIELD_SPECIES;
    this.species = new Int32Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const at = registry.indexOf(ids[i] as string);
      if (at < 0) throw new Error(`the field names "${ids[i]}", which is not a registered species`);
      this.species[i] = at;
    }
    this.localOf = new Int32Array(registry.count).fill(-1);
    for (let i = 0; i < this.species.length; i++) this.localOf[this.species[i] as number] = i;

    this.molarMass = new Float64Array(this.species.length);
    for (let i = 0; i < this.species.length; i++) {
      this.molarMass[i] = registry.molarMass(this.species[i] as number);
    }

    this.heatCapacity = new Float64Array(this.species.length);
    for (let i = 0; i < this.species.length; i++) {
      this.heatCapacity[i] = registry.heatCapacityOf(this.species[i] as number, 298.15);
    }

    this.enthalpySlot = this.species.length;
    this.sootSlot = this.enthalpySlot + 1;
    this.aerosolSlot = this.sootSlot + 1;
    /* `localOf` is the species-index-to-slot map built just above, and `-1` where absent. */
    const soot = registry.indexOf('C(soot)');
    this.sootSpecies = soot >= 0 ? (this.localOf[soot] as number) : -1;
    this.stride = this.aerosolSlot + 1;

    /*
     * **A liquid in a gas cell is a droplet, and a cloud of droplets is an aerosol.** Resolved from
     * the phase rather than from a list of ids, because the field would otherwise have to name
     * `tar(l)` — a species `library/organic` registers and every other consumer has never heard of —
     * and a core file naming a library's species is the direction this package does not import in.
     *
     * So the rule is the physical one and it costs nothing to state: any carried species whose phase
     * is liquid is suspended matter. Wood tar condensing out of a smouldering plume is what this was
     * built for; a consumer whose own library condenses something else gets the same treatment with
     * no entry added anywhere.
     *
     * **Soot is not here and must not be**, though it is equally suspended: it is the *black* half
     * of smoke and this is the pale half, and `§17` colours a plume from the ratio between them.
     */
    const aerosol: number[] = [];
    for (let i = 0; i < this.species.length; i++) {
      if (registry.phaseOf(this.species[i] as number) === PHASE_LIQUID) aerosol.push(i);
    }
    this.aerosolSpecies = Int32Array.from(aerosol);

    this.maxChunks = options.maxChunks ?? 512;
    this.openness = options.openness ?? 1.5;
    this.diffusivity = options.diffusivity ?? 0.02;
    this.vented = new Float64Array(this.species.length + 3);
    this.round = new Int32Array(this.maxChunks);

    /* The tracked species that can burn, resolved once. */
    const combustible: number[] = [];
    for (const id of ['CH4', 'CO', 'H2', 'C2H4', 'C2H6', 'NH3', 'HCN']) {
      const at = registry.indexOf(id);
      if (at >= 0 && this.slotOf(at) >= 0) combustible.push(at);
    }
    this.combustible = Int32Array.from(combustible);

    this.ambientCell = new Float64Array(this.species.length);
    ambientCellMass(registry, this.species, this.ambient, this.cellVolume, this.ambientCell);

    /*
     * Enthalpy is measured from the standard state, so ambient air at 293.15 K sits a little below
     * zero. Computed once here rather than per cell.
     *
     * **`this.heatCapacity`, which is `cp` at 298.15 — the same array `cellTemperature` divides
     * by — rather than `cp` at the ambient temperature.** The two disagree for any species whose
     * `cp` rises with temperature, and the field's own model is a constant `cp` at the datum: a cell
     * *is* an enthalpy divided by that array. Building the ambient with a different `cp` made a
     * freshly filled cell read back 8e-5 K away from the temperature it was filled at — small, and
     * an inconsistency between how a number is written and how it is read is the kind that grows.
     *
     * The linear-`cp` refinement is the *parcel's* model, where `sensibleEnthalpy` integrates it
     * properly. The field trades that for a cell temperature that is one divide.
     */
    let enthalpy = 0;
    for (let i = 0; i < this.species.length; i++) {
      enthalpy +=
        (this.ambientCell[i] as number) *
        (this.heatCapacity[i] as number) *
        (this.ambient.temperature - 298.15);
    }
    this.ambientEnthalpy = enthalpy;
    let ambientMass = 0;
    for (let i = 0; i < this.species.length; i++) ambientMass += this.ambientCell[i] as number;
    this.ambientMass = ambientMass;
    let ambientCapacity = 0;
    for (let i = 0; i < this.species.length; i++) {
      ambientCapacity += (this.ambientCell[i] as number) * (this.heatCapacity[i] as number);
    }
    this.ambientTemperatureExact =
      ambientCapacity > 0
        ? 298.15 + this.ambientEnthalpy / ambientCapacity
        : this.ambient.temperature;
    for (let i = 0; i < SATURATION_KNOTS; i++) {
      const temperature =
        SATURATION_MIN + ((SATURATION_MAX - SATURATION_MIN) * i) / (SATURATION_KNOTS - 1);
      this.saturationTable[i] = saturationVapourPressure(temperature);
    }

    const reactionIds = options.reactionIds ?? [];
    this.network =
      reactionIds.length === 0
        ? null
        : localiseReactions(registry, options.reactions, reactionIds, this.species, 'the field');
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /** How many species this field tracks. */
  get speciesCount(): number {
    return this.species.length;
  }

  /** The local slot a global species occupies, or -1. */
  slotOf(species: number): number {
    return species >= 0 && species < this.localOf.length ? (this.localOf[species] as number) : -1;
  }

  private key(cx: number, cy: number, cz: number): number {
    /* Offset so negatives pack, then base-2048 in three digits. Supports ±1024 chunks, which at
       eight metres is ±8 km — past any scene this engine draws. */
    return ((cx + 1024) * 2048 + (cy + 1024)) * 2048 + (cz + 1024);
  }

  /** The chunk holding a point, creating it if `create`. `-1` where none exists. */
  private chunkAt(x: number, y: number, z: number, create: boolean): number {
    const span = CHUNK_CELLS * this.cellSize;
    const cx = Math.floor(x / span);
    const cy = Math.floor(y / span);
    const cz = Math.floor(z / span);
    const key = this.key(cx, cy, cz);
    const found = this.byKey.get(key);
    if (found !== undefined) return found;
    if (!create || this.chunks.length >= this.maxChunks) return -1;
    return this.createChunk(cx, cy, cz);
  }

  private createChunk(cx: number, cy: number, cz: number): number {
    const key = this.key(cx, cy, cz);
    const cells = CELLS_PER_CHUNK;
    const data = new Float64Array(cells * this.stride);
    for (let cell = 0; cell < cells; cell++) {
      const base = cell * this.stride;
      for (let i = 0; i < this.species.length; i++) data[base + i] = this.ambientCell[i] as number;
      data[base + this.enthalpySlot] = this.ambientEnthalpy;
    }
    /* A new chunk is air drawn in from the far field, so the ledger records it as having come
       from outside. That is what makes `totalMass() + ventedTotalMass()` invariant under chunk
       creation as well as under transport. */
    for (let i = 0; i < this.species.length; i++) {
      this.vented[i] = (this.vented[i] as number) - (this.ambientCell[i] as number) * cells;
    }
    this.ventedEnthalpyTotal -= this.ambientEnthalpy * cells;

    const index = this.chunks.length;
    this.chunks.push(data);
    this.deltas.push(new Float64Array(cells * this.stride));
    this.blocked.push(new Uint8Array(cells));
    this.coords.push(Int32Array.from([cx, cy, cz]));
    this.keys.push(key);
    this.sweptAt.push(-1);
    this.byKey.set(key, index);

    /* Into `order` at its sorted position, so the walk is geometry rather than history. See the
       field on the class. A binary search and a splice, on a path that runs once per chunk. */
    let low = 0;
    let high = this.order.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.keys[this.order[mid] as number] as number) < key) low = mid + 1;
      else high = mid;
    }
    this.order.splice(low, 0, index);
    return index;
  }

  /** Index of the cell containing a point within its chunk. */
  private cellIn(x: number, y: number, z: number): number {
    const lx = ((Math.floor(x / this.cellSize) % CHUNK_CELLS) + CHUNK_CELLS) % CHUNK_CELLS;
    const ly = ((Math.floor(y / this.cellSize) % CHUNK_CELLS) + CHUNK_CELLS) % CHUNK_CELLS;
    const lz = ((Math.floor(z / this.cellSize) % CHUNK_CELLS) + CHUNK_CELLS) % CHUNK_CELLS;
    return (lx * CHUNK_CELLS + ly) * CHUNK_CELLS + lz;
  }

  /** The base offset of the cell containing a point, or `-1` where no chunk exists. */
  private baseAt(x: number, y: number, z: number, create: boolean): number {
    const chunk = this.chunkAt(x, y, z, create);
    if (chunk < 0) return -1;
    return this.cellIn(x, y, z) * this.stride;
  }

  private dataAt(x: number, y: number, z: number, create: boolean): Float64Array | null {
    const chunk = this.chunkAt(x, y, z, create);
    return chunk < 0 ? null : (this.chunks[chunk] as Float64Array);
  }

  /** Add (or with a negative value, remove) mass of one species at a point. */
  addSpecies(x: number, y: number, z: number, species: number, kilograms: number): void {
    const slot = this.slotOf(species);
    if (slot < 0) {
      throw new Error(
        `the field does not carry "${this.registry.idOf(species)}", so it cannot hold any`,
      );
    }
    const data = this.dataAt(x, y, z, true);
    if (data === null) return;
    const base = this.baseAt(x, y, z, true);
    const next = (data[base + slot] as number) + kilograms;
    data[base + slot] = next > 0 ? next : 0;
  }

  addHeat(x: number, y: number, z: number, joules: number): void {
    const data = this.dataAt(x, y, z, true);
    if (data === null) return;
    const base = this.baseAt(x, y, z, true);
    data[base + this.enthalpySlot] = (data[base + this.enthalpySlot] as number) + joules;
  }

  addSoot(x: number, y: number, z: number, kilograms: number): void {
    const data = this.dataAt(x, y, z, true);
    if (data === null) return;
    const base = this.baseAt(x, y, z, true);
    const next = (data[base + this.sootSlot] as number) + kilograms;
    data[base + this.sootSlot] = next > 0 ? next : 0;
  }

  addAerosol(x: number, y: number, z: number, kilograms: number): void {
    const data = this.dataAt(x, y, z, true);
    if (data === null) return;
    const base = this.baseAt(x, y, z, true);
    const next = (data[base + this.aerosolSlot] as number) + kilograms;
    data[base + this.aerosolSlot] = next > 0 ? next : 0;
  }

  /** Mark a cell as occupied by geometry. A blocked face transports nothing. */
  setBlocked(x: number, y: number, z: number, blocked: boolean): void {
    const chunk = this.chunkAt(x, y, z, true);
    if (chunk < 0) return;
    (this.blocked[chunk] as Uint8Array)[this.cellIn(x, y, z)] = blocked ? 1 : 0;
  }

  isBlocked(x: number, y: number, z: number): boolean {
    const chunk = this.chunkAt(x, y, z, false);
    if (chunk < 0) return false;
    return (this.blocked[chunk] as Uint8Array)[this.cellIn(x, y, z)] === 1;
  }

  speciesMassAt(x: number, y: number, z: number, species: number): number {
    const slot = this.slotOf(species);
    if (slot < 0) return 0;
    const data = this.dataAt(x, y, z, false);
    if (data === null) return this.ambientCell[slot] as number;
    return data[this.cellIn(x, y, z) * this.stride + slot] as number;
  }

  /**
   * Kilograms of soot in the cell: the `C(soot)` its own chemistry made, plus anything added.
   *
   * **Two sources on purpose.** Soot a fire produced is the `C(soot)` *species*, which keeps its
   * carbon inside `elementTotals` — a channel carrying mass outside the ledger would make the most
   * valuable assertion in the track quietly wrong every time something smoked. The channel is for a
   * consumer who wants smoke without chemistry behind it: a smoke grenade, a chimney, a dust cloud.
   */
  sootAt(x: number, y: number, z: number): number {
    const data = this.dataAt(x, y, z, false);
    if (data === null) return 0;
    const cell = this.cellIn(x, y, z) * this.stride;
    const added = data[cell + this.sootSlot] as number;
    const slot = this.sootSpecies;
    return slot < 0 ? added : added + (data[cell + slot] as number);
  }

  /**
   * Kilograms of suspended droplets in the cell — the pale half of smoke.
   *
   * Soot is near-black and a droplet is near-white, so the *ratio* between them is what colours a
   * plume: `§17` reads it, and a wet fire steams white where a rich one smokes black with neither
   * being chosen. Symmetric with `sootAt`, and for the same two reasons.
   *
   * **Two sources, exactly as soot has.** Anything the chemistry condensed is a *species* — wood tar
   * coming out of a cooling plume is the case this was built for — so its mass stays inside
   * `elementTotals` and the most valuable assertion in the track keeps covering it. The channel
   * `addAerosol` writes is for a consumer who wants steam without a boiler behind it: a kettle
   * dressed for a scene, a waterfall's spray, a breath on a cold morning.
   */
  aerosolAt(x: number, y: number, z: number): number {
    const data = this.dataAt(x, y, z, false);
    if (data === null) return 0;
    const cell = this.cellIn(x, y, z) * this.stride;
    let total = data[cell + this.aerosolSlot] as number;
    for (let i = 0; i < this.aerosolSpecies.length; i++) {
      total += data[cell + (this.aerosolSpecies[i] as number)] as number;
    }
    return total;
  }

  /**
   * The upward speed this cell's own lightness gives it, m/s.
   *
   * **The field's own number rather than a second one.** `§17` gives a smoke particle its velocity
   * from "the cell's advected plus buoyant velocity", and this is the buoyant half — the same
   * function transport uses, so a particle rises at the speed the gas carrying it actually rises at
   * rather than at a rate chosen to look right.
   */
  riseAt(x: number, y: number, z: number): number {
    const data = this.dataAt(x, y, z, false);
    if (data === null) return 0;
    return this.buoyantSpeed(data, this.cellIn(x, y, z) * this.stride);
  }

  /** Total moles of gas in the cell containing a point. */
  molesAt(x: number, y: number, z: number): number {
    const data = this.dataAt(x, y, z, false);
    let total = 0;
    if (data === null) {
      for (let i = 0; i < this.species.length; i++) {
        total += (this.ambientCell[i] as number) / (this.molarMass[i] as number);
      }
      return total;
    }
    const base = this.cellIn(x, y, z) * this.stride;
    for (let i = 0; i < this.species.length; i++) {
      total += (data[base + i] as number) / (this.molarMass[i] as number);
    }
    return total;
  }

  /** Joules held by the cell containing a point. */
  enthalpyAt(x: number, y: number, z: number): number {
    const data = this.dataAt(x, y, z, false);
    if (data === null) return this.ambientEnthalpy;
    return data[this.cellIn(x, y, z) * this.stride + this.enthalpySlot] as number;
  }

  /** kg of gas in the cell containing a point. */
  massAt(x: number, y: number, z: number): number {
    const data = this.dataAt(x, y, z, false);
    let total = 0;
    if (data === null) {
      for (let i = 0; i < this.species.length; i++) total += this.ambientCell[i] as number;
      return total;
    }
    const base = this.cellIn(x, y, z) * this.stride;
    for (let i = 0; i < this.species.length; i++) total += data[base + i] as number;
    return total;
  }

  /**
   * K, from the cell's enthalpy and the heat capacity of what is in it.
   *
   * A gas mixture has no phase plateau, so this is a division rather than the curve inversion a
   * parcel needs — and it is evaluated at the standard state's heat capacity, which is where the
   * mixture's `cp` is anchored.
   */
  /**
   * K of the cell containing a point.
   *
   * **`ambientTemperatureExact` rather than `this.ambient.temperature`, and the difference is a
   * determinism bug rather than a rounding nicety.** A cell nobody has touched is not stored; one a
   * neighbour realised is. Returning the *authored* 293.15 for the first and the *derived*
   * 293.15000000000003 for the second made a cell's reported temperature depend on whether some
   * other parcel had happened to create the chunk first — which put an order dependence into
   * convection, and from there into whether a log ignites on tick N or tick N+1.
   *
   * Found by `world/fingerprint.test.ts`: two logs spawned the other way round diverged in the
   * eleventh digit on their very first tick, and nothing about them was different.
   */
  temperatureAt(x: number, y: number, z: number): number {
    const data = this.dataAt(x, y, z, false);
    if (data === null) return this.ambientTemperatureExact;
    return this.cellTemperature(data, this.cellIn(x, y, z) * this.stride);
  }

  private cellTemperature(data: Float64Array, base: number): number {
    let capacity = 0;
    for (let i = 0; i < this.species.length; i++) {
      capacity += (data[base + i] as number) * (this.heatCapacity[i] as number);
    }
    if (!(capacity > 0)) return this.ambientTemperatureExact;
    return 298.15 + (data[base + this.enthalpySlot] as number) / capacity;
  }

  /** Volume fraction of one species, which for a gas is its mole fraction. */
  volumeFractionAt(x: number, y: number, z: number, species: number): number {
    const slot = this.slotOf(species);
    if (slot < 0) return 0;
    const total = this.molesAt(x, y, z);
    if (!(total > 0)) return 0;
    return this.speciesMassAt(x, y, z, species) / (this.molarMass[slot] as number) / total;
  }

  /**
   * Volume fraction of the cell that is gas which can burn.
   *
   * What a flammability limit is checked against. Below the lower limit there is not enough fuel to
   * carry a flame; above the upper there is not enough air, which is why a fuel-soaked rag smokes
   * rather than flames until it thins out.
   */
  fuelFractionAt(x: number, y: number, z: number): number {
    let total = 0;
    for (const species of this.combustible) total += this.volumeFractionAt(x, y, z, species);
    return total;
  }

  oxygenFractionAt(x: number, y: number, z: number): number {
    return this.volumeFractionAt(x, y, z, this.registry.indexOf('O2'));
  }

  /** Parts per million by volume, which is the reading a game acts on. */
  concentrationAt(x: number, y: number, z: number, species: number): number {
    return this.volumeFractionAt(x, y, z, species) * 1e6;
  }

  /** kg/m³. */
  densityAt(x: number, y: number, z: number): number {
    return this.massAt(x, y, z) / this.cellVolume;
  }

  /** Pa, by the ideal gas law over what the cell holds at the temperature it is. */
  pressureAt(x: number, y: number, z: number): number {
    return (this.molesAt(x, y, z) * GAS_CONSTANT * this.temperatureAt(x, y, z)) / this.cellVolume;
  }

  /**
   * How thick the smoke is, as an extinction coefficient in inverse metres.
   *
   * **The quantity `visibilityAt` is derived from**, and the one a consumer attenuating a light
   * along a ray actually needs: metres of visibility is one answer to it and `exp(−σ·d)` is another.
   * Exporting only the first would have every consumer inverting Koschmieder to get back here.
   */
  smokeDensityAt(x: number, y: number, z: number): number {
    return (this.sootAt(x, y, z) / this.cellVolume) * SOOT_EXTINCTION;
  }

  /**
   * How far you can see, metres.
   *
   * Koschmieder over the soot's extinction. Clamped at ten kilometres, past which the answer stops
   * being about the smoke.
   */
  visibilityAt(x: number, y: number, z: number): number {
    const extinction = this.smokeDensityAt(x, y, z);
    if (!(extinction > 0)) return 10000;
    return Math.min(10000, VISIBILITY_CONSTANT / extinction);
  }

  /**
   * Relative humidity, 0 to 1: the water vapour present against what this air could hold.
   *
   * **The reading that decides whether anything dries.** `§8.1`'s evaporation is driven by the
   * vapour pressure *deficit*, so washing dries in wind and nothing dries in fog — and the same
   * number is why a fire dries a room out while removing no water at all: warm air could hold more,
   * so the same vapour is a smaller fraction of saturation.
   *
   * **Saturation is tabulated**, per `§7`'s rule, because it is `exp` of a rational function of
   * temperature and this is a query a script may make every frame. 256 knots over 200-500 K, where
   * linear interpolation is under a tenth of a percent.
   */
  humidityAt(x: number, y: number, z: number): number {
    const vapour = this.registry.indexOf('H2O(g)');
    if (vapour < 0) return 0;
    const partial = this.volumeFractionAt(x, y, z, vapour) * this.pressureAt(x, y, z);
    const saturation = this.saturation(this.temperatureAt(x, y, z));
    return saturation > 0 ? partial / saturation : 0;
  }

  /** Pa, off the table `SATURATION_KNOTS` describes. Clamped at both ends rather than extrapolated. */
  private saturation(temperature: number): number {
    if (temperature <= SATURATION_MIN) return this.saturationTable[0] as number;
    if (temperature >= SATURATION_MAX) return this.saturationTable[SATURATION_KNOTS - 1] as number;
    const position =
      ((temperature - SATURATION_MIN) / (SATURATION_MAX - SATURATION_MIN)) * (SATURATION_KNOTS - 1);
    const low = Math.floor(position);
    const at = position - low;
    return (
      (this.saturationTable[low] as number) * (1 - at) +
      (this.saturationTable[low + 1] as number) * at
    );
  }

  /** Kilograms of one species above what the ambient would have held. Diagnostics and tests. */
  totalAdded(species: number): number {
    const slot = this.slotOf(species);
    if (slot < 0) return 0;
    const cells = CHUNK_CELLS * CHUNK_CELLS * CHUNK_CELLS;
    let total = 0;
    for (let o = 0; o < this.order.length; o++) {
      const data = this.chunks[this.order[o] as number] as Float64Array;
      for (let cell = 0; cell < cells; cell++) {
        total += (data[cell * this.stride + slot] as number) - (this.ambientCell[slot] as number);
      }
    }
    return total;
  }

  /**
   * Advance the field one step: expansion, buoyancy, wind, diffusion and the far field.
   *
   * **Every transfer is flux-form and conservative** — computed once for a face and applied to both
   * sides — which is a departure from `§9` worth recording. The design chose semi-Lagrangian
   * advection for unconditional stability; semi-Lagrangian is **not conservative**, and
   * conservation is the invariant this whole track is asserted on. Upwind flux has a CFL limit
   * instead, and a CFL limit is handled here the same way stiffness is handled in the reaction
   * solver: by sub-stepping. That is the trade taken deliberately.
   *
   * **Deltas are accumulated and applied afterwards**, so no cell sees a neighbour that an earlier
   * cell in the sweep already changed. A Gauss-Seidel sweep would give an answer that depended on
   * chunk allocation order, which is a determinism hole with no symptom until two runs allocate
   * differently.
   *
   * `windX` and `windZ` come from the one `WindField`, sampled once per frame by the caller.
   */
  step(dt: number, windX = 0, windZ = 0): void {
    if (!(dt > 0) || this.chunks.length === 0) return;

    /* The CFL limit over wind and the fastest a buoyant cell can rise. */
    const fastest = Math.max(Math.abs(windX), Math.abs(windZ), MAX_BUOYANT_SPEED);
    const substeps = Math.min(
      MAX_TRANSPORT_SUBSTEPS,
      Math.max(1, Math.ceil((fastest * dt) / (this.cellSize * MAX_FACE_FRACTION))),
    );
    const step = dt / substeps;
    for (let pass = 0; pass < substeps; pass++) this.sweep(step, windX, windZ);
    this.react(dt);
  }

  /**
   * Run the gas-phase network in every live cell.
   *
   * After transport rather than before, so a cell burns the mixture it actually ended the step
   * with — which is what makes a flame follow the fuel rather than lag a step behind it.
   */
  private react(dt: number): void {
    const network = this.network;
    if (network === null) return;
    /* In key order, like every other full walk. A cell's reaction reads and writes only itself, so
       this one is order-independent already — but a second convention here is a second thing to get
       wrong, and the cost is one indirection per chunk. */
    for (let o = 0; o < this.order.length; o++) {
      const chunk = this.order[o] as number;
      const data = this.chunks[chunk] as Float64Array;
      const blocked = this.blocked[chunk] as Uint8Array;
      for (let cell = 0; cell < CELLS_PER_CHUNK; cell++) {
        if (blocked[cell] === 1) continue;
        const base = cell * this.stride;
        let mass = 0;
        for (let i = 0; i < this.species.length; i++) mass += data[base + i] as number;
        if (!(mass > 0)) continue;
        reactShell(data, base, data, base + this.enthalpySlot, network, mass, dt);
      }
    }
  }

  /** The upward speed a cell's own lightness gives it, m/s. */
  private buoyantSpeed(data: Float64Array, base: number): number {
    let mass = 0;
    for (let i = 0; i < this.species.length; i++) mass += data[base + i] as number;
    const density = mass / this.cellVolume;
    const ambientDensity = this.ambientMass / this.cellVolume;
    if (!(ambientDensity > 0)) return 0;
    const speed = GRAVITY * ((ambientDensity - density) / ambientDensity) * BUOYANT_TIME;
    return speed > MAX_BUOYANT_SPEED
      ? MAX_BUOYANT_SPEED
      : speed < -MAX_BUOYANT_SPEED
        ? -MAX_BUOYANT_SPEED
        : speed;
  }

  /** Resolve a world cell to a packed chunk-and-cell, or -1. */
  private resolve(wx: number, wy: number, wz: number, create: boolean): number {
    const cx = Math.floor(wx / CHUNK_CELLS);
    const cy = Math.floor(wy / CHUNK_CELLS);
    const cz = Math.floor(wz / CHUNK_CELLS);
    const key = this.key(cx, cy, cz);
    let chunk = this.byKey.get(key);
    if (chunk === undefined) {
      if (!create || this.chunks.length >= this.maxChunks) return -1;
      chunk = this.createChunk(cx, cy, cz);
    }
    const lx = wx - cx * CHUNK_CELLS;
    const ly = wy - cy * CHUNK_CELLS;
    const lz = wz - cz * CHUNK_CELLS;
    return chunk * CELLS_PER_CHUNK + (lx * CHUNK_CELLS + ly) * CHUNK_CELLS + lz;
  }

  private sweep(dt: number, windX: number, windZ: number): void {
    for (const delta of this.deltas) delta.fill(0);

    const diffusion = Math.min(
      MAX_FACE_FRACTION,
      (this.diffusivity * dt) / (this.cellSize * this.cellSize),
    );
    const vent = Math.min(0.5, this.openness * dt);
    const expansion = Math.min(MAX_FACE_FRACTION, PRESSURE_RELAX * dt);

    /*
     * **In rounds over `order`, which is key order, rather than along `chunks`, which is creation
     * order.** A face may create the chunk beyond it, and a chunk created this sweep is swept in the
     * same pass — correct, because it starts as ambient and can only receive until it is. Walking
     * `chunks.length` afresh gave that for free and paid for it in determinism: the visit order was
     * then the allocation order, so two runs that realised their chunks differently accumulated into
     * the shared `deltas` in a different sequence and diverged in the last bit. See `order`.
     *
     * A round is snapshotted into `round` before it is walked, so chunks created during it are not
     * observed mid-walk; the loop repeats until a round creates nothing. Both halves are then facts
     * about geometry: which chunks a round contains, and the order it visits them in.
     */
    this.pass++;
    for (;;) {
      let count = 0;
      for (let o = 0; o < this.order.length; o++) {
        const chunk = this.order[o] as number;
        if (this.sweptAt[chunk] !== this.pass) this.round[count++] = chunk;
      }
      if (count === 0) break;
      for (let r = 0; r < count; r++) {
        const chunk = this.round[r] as number;
        this.sweptAt[chunk] = this.pass;
        this.sweepChunk(chunk, dt, windX, windZ, diffusion, vent, expansion);
      }
    }

    /*
     * The apply pass, per chunk and independent, so its order cannot matter: a cell's next value is
     * its own plus its own delta. Along `chunks` rather than `order` for that reason, and because
     * the whole array is one linear walk.
     */
    for (let chunk = 0; chunk < this.chunks.length; chunk++) {
      const data = this.chunks[chunk] as Float64Array;
      const delta = this.deltas[chunk] as Float64Array;
      for (let i = 0; i < data.length; i++) {
        const next = (data[i] as number) + (delta[i] as number);
        data[i] = next;
      }
      /* Clamp only what cannot be negative; enthalpy legitimately can. */
      for (let cell = 0; cell < CELLS_PER_CHUNK; cell++) {
        const base = cell * this.stride;
        for (let i = 0; i < this.species.length; i++) {
          if ((data[base + i] as number) < 0) data[base + i] = 0;
        }
        if ((data[base + this.sootSlot] as number) < 0) data[base + this.sootSlot] = 0;
        if ((data[base + this.aerosolSlot] as number) < 0) data[base + this.aerosolSlot] = 0;
      }
    }
  }

  /** One chunk's faces, for `sweep`. Every transfer lands in `deltas` and is applied afterwards. */
  private sweepChunk(
    chunk: number,
    dt: number,
    windX: number,
    windZ: number,
    diffusion: number,
    vent: number,
    expansion: number,
  ): void {
    {
      const data = this.chunks[chunk] as Float64Array;
      const blocked = this.blocked[chunk] as Uint8Array;
      const coords = this.coords[chunk] as Int32Array;
      for (let cell = 0; cell < CELLS_PER_CHUNK; cell++) {
        if (blocked[cell] === 1) continue;
        const base = cell * this.stride;
        const lx = (cell / (CHUNK_CELLS * CHUNK_CELLS)) | 0;
        const ly = ((cell / CHUNK_CELLS) | 0) % CHUNK_CELLS;
        const lz = cell % CHUNK_CELLS;
        const wx = (coords[0] as number) * CHUNK_CELLS + lx;
        const wy = (coords[1] as number) * CHUNK_CELLS + ly;
        const wz = (coords[2] as number) * CHUNK_CELLS + lz;

        const rise = this.buoyantSpeed(data, base);
        for (let axis = 0; axis < 3; axis++) {
          const velocity = axis === 0 ? windX : axis === 1 ? rise : windZ;
          const other = this.resolve(
            wx + (axis === 0 ? 1 : 0),
            wy + (axis === 1 ? 1 : 0),
            wz + (axis === 2 ? 1 : 0),
            /*
             * New ground is claimed only where something is being pushed onto it — a positive
             * velocity **and** a cell that has something to carry. Without the second half the
             * `+y` face of every boundary cell reaches upward on every sweep, whether or not
             * anything is rising, and the live set grows a tower of ambient air to its cap.
             */
            velocity > 0 && this.departsFromAmbient(data, base),
          );
          if (other < 0) {
            this.ventFace(chunk, cell, base, vent);
            continue;
          }
          const otherChunk = (other / CELLS_PER_CHUNK) | 0;
          const otherCell = other - otherChunk * CELLS_PER_CHUNK;
          if ((this.blocked[otherChunk] as Uint8Array)[otherCell] === 1) continue;
          this.face(
            chunk,
            base,
            otherChunk,
            otherCell * this.stride,
            velocity,
            dt,
            diffusion,
            expansion,
          );
        }

        /* The three negative faces are somebody else's positive face, except where that somebody
           does not exist — in which case this cell is on the boundary and vents. */
        for (let axis = 0; axis < 3; axis++) {
          const back = this.resolve(
            wx - (axis === 0 ? 1 : 0),
            wy - (axis === 1 ? 1 : 0),
            wz - (axis === 2 ? 1 : 0),
            false,
          );
          if (back < 0) this.ventFace(chunk, cell, base, vent);
        }
      }
    }
  }

  /**
   * Whether this cell holds anything the far field would not.
   *
   * What bounds the live set. A cell indistinguishable from the outdoors has nothing to spread, so
   * it never claims a neighbour — which is why a world with one campfire holds the chunks around
   * that fire rather than a column of air to the sky.
   */
  private departsFromAmbient(data: Float64Array, base: number): boolean {
    if ((data[base + this.sootSlot] as number) > AMBIENT_EPSILON) return true;
    if ((data[base + this.aerosolSlot] as number) > AMBIENT_EPSILON) return true;
    if (
      Math.abs((data[base + this.enthalpySlot] as number) - this.ambientEnthalpy) > ENTHALPY_EPSILON
    ) {
      return true;
    }
    for (let i = 0; i < this.species.length; i++) {
      if (
        Math.abs((data[base + i] as number) - (this.ambientCell[i] as number)) > AMBIENT_EPSILON
      ) {
        return true;
      }
    }
    return false;
  }

  /** One internal face: bulk transfer by wind, buoyancy and pressure, plus diffusion. */
  private face(
    chunkA: number,
    baseA: number,
    chunkB: number,
    baseB: number,
    velocity: number,
    dt: number,
    diffusion: number,
    expansion: number,
  ): void {
    const dataA = this.chunks[chunkA] as Float64Array;
    const dataB = this.chunks[chunkB] as Float64Array;
    const deltaA = this.deltas[chunkA] as Float64Array;
    const deltaB = this.deltas[chunkB] as Float64Array;

    let molesA = 0;
    let molesB = 0;
    for (let i = 0; i < this.species.length; i++) {
      molesA += (dataA[baseA + i] as number) / (this.molarMass[i] as number);
      molesB += (dataB[baseB + i] as number) / (this.molarMass[i] as number);
    }

    /*
     * **Pressure is `n·T`, not `n`**, and getting that wrong is what a first attempt at this did.
     * Heating a cell does not change how many moles it holds, so equalising *molar density* leaves
     * a hot cell exactly where it was: nothing expands, its density never falls, and buoyancy —
     * which reads density — never lifts it. The plume simply does not happen. Pressure is what
     * actually differs across that face, and it is what pushes.
     */
    const pressureA = molesA * this.cellTemperature(dataA, baseA);
    const pressureB = molesB * this.cellTemperature(dataB, baseB);

    /* Wind and buoyancy as a Courant fraction, plus the share of its excess the higher-pressure
       cell pushes across. Both are "move a fraction of the donor's contents", so they add. */
    const largest = Math.max(pressureA, pressureB);
    const pressure = largest > 0 ? (expansion * (pressureA - pressureB)) / (2 * largest) : 0;
    let fraction = (velocity * dt) / this.cellSize + pressure;
    if (fraction > MAX_FACE_FRACTION) fraction = MAX_FACE_FRACTION;
    if (fraction < -MAX_FACE_FRACTION) fraction = -MAX_FACE_FRACTION;

    if (fraction !== 0) {
      const fromA = fraction > 0;
      const source = fromA ? dataA : dataB;
      const sourceBase = fromA ? baseA : baseB;
      const share = fromA ? fraction : -fraction;
      for (let i = 0; i < this.stride; i++) {
        const moved = (source[sourceBase + i] as number) * share;
        if (moved === 0) continue;
        if (fromA) {
          deltaA[baseA + i] = (deltaA[baseA + i] as number) - moved;
          deltaB[baseB + i] = (deltaB[baseB + i] as number) + moved;
        } else {
          deltaB[baseB + i] = (deltaB[baseB + i] as number) - moved;
          deltaA[baseA + i] = (deltaA[baseA + i] as number) + moved;
        }
      }
    }

    if (diffusion > 0) {
      for (let i = 0; i < this.stride; i++) {
        const moved = ((dataA[baseA + i] as number) - (dataB[baseB + i] as number)) * diffusion;
        if (moved === 0) continue;
        deltaA[baseA + i] = (deltaA[baseA + i] as number) - moved;
        deltaB[baseB + i] = (deltaB[baseB + i] as number) + moved;
      }
    }
  }

  /** A face onto the far field: relax toward ambient and book what crossed. */
  private ventFace(chunk: number, cell: number, base: number, vent: number): void {
    void cell;
    if (!(vent > 0)) return;
    const data = this.chunks[chunk] as Float64Array;
    const delta = this.deltas[chunk] as Float64Array;
    for (let i = 0; i < this.species.length; i++) {
      const moved = ((data[base + i] as number) - (this.ambientCell[i] as number)) * vent;
      delta[base + i] = (delta[base + i] as number) - moved;
      this.vented[i] = (this.vented[i] as number) + moved;
    }
    const heat = ((data[base + this.enthalpySlot] as number) - this.ambientEnthalpy) * vent;
    delta[base + this.enthalpySlot] = (delta[base + this.enthalpySlot] as number) - heat;
    this.ventedEnthalpyTotal += heat;
    for (const slot of [this.sootSlot, this.aerosolSlot]) {
      const moved = (data[base + slot] as number) * vent;
      delta[base + slot] = (delta[base + slot] as number) - moved;
    }
  }

  /** Moles of each element the field holds, over every live chunk. Writes into `out`. */
  elementTotals(out: Float64Array): void {
    if (out.length !== ELEMENT_COUNT) {
      throw new Error(`a totals vector is ${ELEMENT_COUNT} wide, not ${out.length}`);
    }
    out.fill(0);
    const cells = CHUNK_CELLS * CHUNK_CELLS * CHUNK_CELLS;
    /* **In key order**, because this is a floating-point reduction and a reduction's answer depends
       on the order it adds. See `order`: along `chunks` it depended on which chunk was realised
       first, and `fingerprintChemistry` hashes exactly this vector. */
    for (let o = 0; o < this.order.length; o++) {
      const data = this.chunks[this.order[o] as number] as Float64Array;
      for (let cell = 0; cell < cells; cell++) {
        const base = cell * this.stride;
        for (let i = 0; i < this.species.length; i++) {
          const kilograms = data[base + i] as number;
          if (kilograms === 0) continue;
          this.registry.elements.addScaledRow(
            this.species[i] as number,
            kilograms / (this.molarMass[i] as number),
            out,
          );
        }
      }
    }
  }

  /** Total gas mass across every live chunk, kg. */
  totalMass(): number {
    const cells = CHUNK_CELLS * CHUNK_CELLS * CHUNK_CELLS;
    let total = 0;
    for (let o = 0; o < this.order.length; o++) {
      const data = this.chunks[this.order[o] as number] as Float64Array;
      for (let cell = 0; cell < cells; cell++) {
        const base = cell * this.stride;
        for (let i = 0; i < this.species.length; i++) total += data[base + i] as number;
      }
    }
    return total;
  }

  /** Kilograms of one species that have left through an open boundary. */
  ventedMass(species: number): number {
    const slot = this.slotOf(species);
    return slot < 0 ? 0 : (this.vented[slot] as number);
  }

  /** Joules that have left through an open boundary. */
  ventedEnthalpy(): number {
    return this.ventedEnthalpyTotal;
  }

  /** Kilograms that have crossed the far-field boundary in total, in either direction. */
  ventedTotalMass(): number {
    let total = 0;
    for (let i = 0; i < this.species.length; i++) total += this.vented[i] as number;
    return total;
  }

  /**
   * Moles of each element that have crossed the far-field boundary. Writes into `out`.
   *
   * Live chunks alone do not balance, and the reason is not transport: **creating a chunk draws a
   * chunk of air in from outside**, which is matter appearing in the live set. The ledger records
   * it, so `elementTotals + ventedElementTotals` is invariant under chunk creation as well as under
   * everything else — and a conservation assertion over a growing plume is possible at all.
   */
  ventedElementTotals(out: Float64Array): void {
    if (out.length !== ELEMENT_COUNT) {
      throw new Error(`a totals vector is ${ELEMENT_COUNT} wide, not ${out.length}`);
    }
    out.fill(0);
    for (let i = 0; i < this.species.length; i++) {
      const kilograms = this.vented[i] as number;
      if (kilograms === 0) continue;
      this.registry.elements.addScaledRow(
        this.species[i] as number,
        kilograms / (this.molarMass[i] as number),
        out,
      );
    }
  }

  /** Total enthalpy across every live chunk, J. */
  totalEnthalpy(): number {
    const cells = CHUNK_CELLS * CHUNK_CELLS * CHUNK_CELLS;
    let total = 0;
    for (let o = 0; o < this.order.length; o++) {
      const data = this.chunks[this.order[o] as number] as Float64Array;
      for (let cell = 0; cell < cells; cell++) {
        total += data[cell * this.stride + this.enthalpySlot] as number;
      }
    }
    return total;
  }
}

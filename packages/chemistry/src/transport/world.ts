/**
 * The tick: parcels, the air, and everything that crosses between them.
 *
 * `§13` gives the order and this is it. What it adds over the phases beneath is the thing that
 * makes them one simulation rather than two — **a burning parcel eats the oxygen around it and
 * pushes its smoke into the air**, and a parcel near a fire gets hot because of where it is rather
 * than because a caller told it to.
 *
 * **Nothing here applies a flux.** A consumer declares what is radiating and what is touching what,
 * and every parcel works out for itself what reaches it. That is the difference between a fire that
 * behaves and a fire that is a set of numbers somebody tuned.
 *
 * **The field is optional.** Without one, radiation and contact still work and the parcels simply
 * have no air to breathe: no convection, no gas exchange, no oxygen limit. A consumer who wants
 * heat but not atmosphere pays for neither the memory nor the sweep.
 */
import { ELEMENT_COUNT } from '../element/elements.ts';
import type { AtmosphereField } from '../field/atmosphere.ts';
import { PHASE_GAS } from '../species/species.ts';
import type { ParcelStore } from '../parcel/store.ts';
import { ContactSet } from './contacts.ts';
import {
  ChemistryEvents,
  EVENT_EXTINGUISHED,
  EVENT_IGNITED,
  EVENT_SMOULDER_END,
  EVENT_SMOULDER_START,
} from '../ignition/events.ts';
import {
  extinguishes,
  ignites,
  ignitionProgress,
  smoulders,
  EXTINCT_NONE,
} from '../ignition/criteria.ts';
import { type OcclusionTest, RadiativeSources, convectiveCoefficient } from './radiation.ts';

export interface ChemistryWorldOptions {
  /**
   * How fast a porous parcel equalises its pore gas with the cell around it, per second.
   *
   * Scaled by porosity, so a substance nobody described as porous exchanges nothing. What this
   * governs in practice: how quickly volatiles get out to burn, and how quickly oxygen gets in to
   * burn them.
   */
  readonly exchangeRate?: number;
  /** Ambient gas speed where there is no field to ask, m/s. */
  readonly stillAir?: number;
}

const DEFAULT_EXCHANGE_RATE = 2;

/** Which of a parcel's gases can carry a flame. Steam and carbon dioxide cannot, and that matters. */
const COMBUSTIBLE = new Set(['CH4', 'CO', 'H2', 'C2H4', 'C2H6', 'NH3', 'HCN']);

/** Where there is no field to ask, the air is ordinary air. */
const AIR_OXYGEN = 0.2071;

/**
 * Ticks the wake scan is spread over, and it must be a power of two so the phase is a mask.
 *
 * `§14`: "that scan is itself budgeted and round-robin across four ticks." A sleeping parcel is
 * therefore woken within four ticks of a fire arriving — a sixteenth of a second at 60 Hz, which is
 * far inside the tens of seconds anything takes to respond to one.
 */
const WAKE_PHASES = 4;

export class ChemistryWorld {
  /** Refilled by the caller each tick: what is radiating. */
  readonly sources = new RadiativeSources();
  /** Refilled by the caller each tick: what is touching what. */
  readonly contacts = new ContactSet();
  /** Drained by the caller each tick: what happened. Cleared at the top of every `simulate`. */
  readonly events = new ChemistryEvents();

  /** Which slice of the sleeping set this tick's wake scan looks at. See `simulate`. */
  private scanPhase = 0;
  /**
   * Whether anything solid stands between two points.
   *
   * Absent, every source is visible — the cheap default, and wrong indoors. A consumer supplies a
   * raycast; `§10` budgets and caches it, which is CH-6's work rather than this phase's.
   */
  occluded: OcclusionTest | null = null;

  private readonly exchangeRate: number;
  private readonly stillAir: number;
  private readonly scratch = new Float64Array(ELEMENT_COUNT);

  constructor(
    /** The parcels this world steps. Readable, because `fingerprintChemistry` hashes them. */
    readonly parcels: ParcelStore,
    /** The air, or `null` for a world with none. Readable for the same reason. */
    readonly field: AtmosphereField | null = null,
    options: ChemistryWorldOptions = {},
  ) {
    this.exchangeRate = options.exchangeRate ?? DEFAULT_EXCHANGE_RATE;
    this.stillAir = options.stillAir ?? 0;
  }

  /**
   * One fixed step, in the order `§13` gives.
   *
   * **Sleeping and the tier cadence are both here rather than inside the terms they skip**, because
   * both are decisions about *whether* a parcel is stepped at all and a term that decided for itself
   * would be four places deciding the same thing four ways.
   */
  simulate(dt: number, windX = 0, windZ = 0): void {
    if (!(dt > 0)) return;
    this.events.clear();
    const speed = Math.sqrt(windX * windX + windZ * windZ) + this.stillAir;
    const count = this.parcels.count;

    /*
     * The wake scan, round-robin across four ticks. `§14`: "the wake test is a coarse scan and it
     * must be, or sleeping saves nothing." A sleeping parcel is tested against the source set's own
     * ranges — which CH-5 already derives from source power, so a bonfire reaches further than a
     * candle — and a thousand sleepers cost two hundred and fifty of those a tick.
     */
    this.scanPhase = (this.scanPhase + 1) & (WAKE_PHASES - 1);
    for (let parcel = this.scanPhase; parcel < count; parcel += WAKE_PHASES) {
      if (!this.parcels.alive(parcel) || !this.parcels.sleeping(parcel)) continue;
      if (
        this.sources.reachesPoint(
          this.parcels.positionX(parcel),
          this.parcels.positionY(parcel),
          this.parcels.positionZ(parcel),
        )
      ) {
        this.parcels.wake(parcel);
      }
    }

    for (let parcel = 0; parcel < count; parcel++) {
      if (!this.parcels.alive(parcel) || this.parcels.sleeping(parcel)) continue;
      this.radiate(parcel, dt);
      this.convect(parcel, dt, speed);
    }
    this.conductContacts(dt);
    for (let parcel = 0; parcel < count; parcel++) {
      if (!this.parcels.alive(parcel) || this.parcels.sleeping(parcel)) continue;
      /* Its turn, or the seconds it is owed carried forward. Zero means it is not due this tick. */
      const step = this.parcels.accrue(parcel, dt);
      if (step === 0) continue;
      this.parcels.conduct(parcel, step);
      /* Faster gas past a surface delivers reactants faster — `1 + √v`, so a breeze matters and a
         gale does not matter proportionally more. This is what brightens an ember. */
      this.parcels.react(parcel, step, 1 + Math.sqrt(speed));
      this.exchange(parcel, step);
    }
    if (this.field !== null) this.field.step(dt, windX, windZ);
    for (let parcel = 0; parcel < count; parcel++) {
      if (!this.parcels.alive(parcel) || this.parcels.sleeping(parcel)) continue;
      this.criteria(parcel, speed);
      this.parcels.settle(parcel);
    }
  }

  /** What the fires can see of this parcel, into shell 0. */
  private radiate(parcel: number, dt: number): void {
    if (this.sources.count === 0) return;
    const area = this.parcels.areaOf(parcel);
    if (!(area > 0)) return;
    const flux = this.sources.fluxAt(
      this.parcels.positionX(parcel),
      this.parcels.positionY(parcel),
      this.parcels.positionZ(parcel),
      this.parcels.surfaceTemperatureOf(parcel),
      this.parcels.emissivityOf(parcel),
      this.occluded,
    );
    if (flux === 0) return;
    /*
     * **Bounded by the source doing the heating**, because the term is explicit and joules into a
     * small enough shell is an arbitrarily large temperature change. A copper coin on a hearth in
     * `demo/dev/chemistry.ts` reached 4,000 K on its first step and 100 K a minute later, radiating
     * the excess back as `T⁴` and ringing itself apart — a 2 g surface shell against a flux written
     * for a log.
     *
     * Nothing can be heated past the thing heating it, so the step may reach that equilibrium and
     * not exceed it. That is what an implicit solve would give, at the cost of one comparison.
     */
    this.parcels.addSurfaceHeat(
      parcel,
      this.bounded(
        parcel,
        flux * area * dt,
        this.sources.hottestAt(
          this.parcels.positionX(parcel),
          this.parcels.positionY(parcel),
          this.parcels.positionZ(parcel),
          this.occluded,
        ),
      ),
    );
  }

  /**
   * Joules, clipped to what would bring the surface to `driving` and no further.
   *
   * Zero `driving` means nothing was found to be driving it, and then the joules pass through: a
   * parcel radiating to a sky with no source in it is losing heat to the far field, and clipping
   * that against zero kelvin would be clipping it against nothing.
   */
  private bounded(parcel: number, joules: number, driving: number): number {
    if (joules === 0 || !(driving > 0)) return joules;
    const capacity = this.parcels.surfaceHeatCapacityOf(parcel);
    if (!(capacity > 0)) return joules;
    const room = capacity * (driving - this.parcels.surfaceTemperatureOf(parcel));
    if (joules > 0) return room <= 0 ? 0 : joules < room ? joules : room;
    return room >= 0 ? 0 : joules > room ? joules : room;
  }

  /** What the air around it is doing to it. */
  private convect(parcel: number, dt: number, speed: number): void {
    if (this.field === null) return;
    const area = this.parcels.areaOf(parcel);
    if (!(area > 0)) return;
    const x = this.parcels.positionX(parcel);
    const y = this.parcels.positionY(parcel);
    const z = this.parcels.positionZ(parcel);
    const gas = this.field.temperatureAt(x, y, z);
    const surface = this.parcels.surfaceTemperatureOf(parcel);
    /* Bounded by the gas, for the reason `radiate` gives: a surface cannot be convected past the
       air touching it, and an explicit step over a small shell otherwise sails through it. */
    const joules = this.bounded(
      parcel,
      convectiveCoefficient(speed) * area * (gas - surface) * dt,
      gas,
    );
    if (joules === 0) return;
    /* Taken from the air rather than made: the cell cools by exactly what the parcel gained. */
    this.parcels.addSurfaceHeat(parcel, joules);
    this.field.addHeat(x, y, z, -joules);
  }

  /** Heat across the faces the caller says are touching. */
  private conductContacts(dt: number): void {
    for (let contact = 0; contact < this.contacts.count; contact++) {
      const a = this.contacts.firstOf(contact);
      const b = this.contacts.secondOf(contact);
      if (!this.parcels.alive(a) || !this.parcels.alive(b)) continue;
      const area = this.contacts.areaOf(contact);
      if (!(area > 0)) continue;
      const ta = this.parcels.surfaceTemperatureOf(a);
      const tb = this.parcels.surfaceTemperatureOf(b);
      const ka = this.parcels.conductivityOf(a, ta);
      const kb = this.parcels.conductivityOf(b, tb);
      const total = ka + kb;
      if (!(total > 0)) continue;
      /* The harmonic mean again, and for the same reason a shell boundary uses one: two materials
         in series add reciprocals. The span is the two parcels' own surface shells. */
      const effective = (2 * ka * kb) / total;
      const span = (this.parcels.shellDepthOf(a, 0) + this.parcels.shellDepthOf(b, 0)) / 2;
      if (!(span > 0)) continue;
      const joules = (effective * area * (ta - tb) * dt) / span;
      this.parcels.addSurfaceHeat(a, -joules);
      this.parcels.addSurfaceHeat(b, joules);
    }
  }

  /**
   * The pore gas in a parcel relaxes toward the air around it.
   *
   * **One mechanism, both directions.** Volatiles a parcel's reactions made are above the cell's
   * concentration and leave; oxygen its reactions consumed is below and comes in. Writing those as
   * two rules would be two things to keep in step, and the second would be found wrong on the day a
   * fire went out with oxygen still in the room.
   *
   * The target is what the pore volume would hold at the cell's own density, so a dense material
   * with little void exchanges little — which is why a log smoulders and sawdust does not.
   */
  private exchange(parcel: number, dt: number): void {
    const field = this.field;
    if (field === null) return;
    const substance = this.parcels.substanceOf(parcel);
    const porosity = this.parcels.porosityOf(parcel);
    if (!(porosity > 0)) return;
    const share = Math.min(1, this.exchangeRate * porosity * dt);
    if (!(share > 0)) return;

    const pore = this.parcels.volumeOf(parcel) * porosity;
    const x = this.parcels.positionX(parcel);
    const y = this.parcels.positionY(parcel);
    const z = this.parcels.positionZ(parcel);
    const cellVolume = field.cellVolume;

    const set = this.parcels.speciesSetOf(substance);
    const count = this.parcels.shellCount(parcel);
    const area = this.parcels.areaOf(parcel);
    let leaving = 0;
    let leavingFuel = 0;
    for (let i = 0; i < set.length; i++) {
      const global = set[i] as number;
      if (this.parcels.phaseOf(global) !== PHASE_GAS) continue;
      if (field.slotOf(global) < 0) continue;
      const outside = (field.speciesMassAt(x, y, z, global) / cellVolume) * pore;
      /* Only the surface shell is open to the air; deeper gas has to reach it first, which is what
         `permeability` will govern when CH-6 needs it to. */
      const inside = this.parcels.speciesMassOf(parcel, 0, global);
      let moved = (inside - outside / count) * share;
      if (moved === 0) continue;

      /*
       * Clamped to what the donor actually has, **before** anything is applied.
       *
       * Both sides clamp a negative mass to zero on the way in, so an unclamped move that overdrew
       * would be silently absorbed — and silently absorbed mass is exactly the thing element
       * conservation exists to catch. It caught it: the drift was 5.6e-9 before this line.
       */
      if (moved > inside) moved = inside;
      const available = field.speciesMassAt(x, y, z, global);
      if (-moved > available) moved = -available;
      if (moved === 0) continue;

      /*
       * **Enthalpy travels with the mass**, and leaving it behind is an energy leak with a
       * plausible-looking symptom: a parcel that quietly cools as it vents, or warms as it
       * breathes, for no reason anybody can point at. The donor's own specific enthalpy is what
       * moves, which is what makes the pair conserve rather than merely nearly.
       */
      if (moved > 0) {
        const shellMass = this.parcels.massOf(parcel) / count;
        const specific = this.parcels.shellEnthalpyOf(parcel, 0) / shellMass;
        this.parcels.addSurfaceHeat(parcel, -specific * moved);
        field.addHeat(x, y, z, specific * moved);
      } else {
        const cellMass = field.massAt(x, y, z);
        if (cellMass > 0) {
          const specific = field.enthalpyAt(x, y, z) / cellMass;
          field.addHeat(x, y, z, specific * moved);
          this.parcels.addSurfaceHeat(parcel, -specific * moved);
        }
      }

      this.parcels.addSpeciesMass(parcel, 0, global, -moved);
      field.addSpecies(x, y, z, global, moved);
      if (moved > 0) {
        leaving += moved;
        if (COMBUSTIBLE.has(this.parcels.idOfSpecies(global))) leavingFuel += moved;
      }
    }

    /*
     * **The criterion ignition actually turns on**, kg/(m²·s). A surface can be well past its
     * ignition temperature and still not be producing a flammable mixture — which is exactly what
     * wet wood does, and why the temperature is the proxy and this is the thing.
     */
    const per = area > 0 && dt > 0 ? 1 / (area * dt) : 0;
    this.parcels.setMassFlux(parcel, leaving * per, leavingFuel * per);
  }

  /**
   * Whether this parcel catches, keeps burning, or stops — and why.
   *
   * **Nothing here starts a fire.** Five conditions decide it, a pilot is one of them, and the
   * pilot a caller supplied is spent at the end of the tick whether or not it was enough. That is
   * `§11`, and it is why holding a match to wet wood does exactly nothing.
   */
  private criteria(parcel: number, gasSpeed: number): void {
    const substance = this.parcels.substanceOf(parcel);
    const model = this.parcels.ignitionOf(substance);
    if (model === null) return;

    const surface = this.parcels.surfaceTemperatureOf(parcel);
    const flux = this.parcels.fuelFluxOf(parcel);
    const total = this.parcels.massFluxOf(parcel);
    const x = this.parcels.positionX(parcel);
    const y = this.parcels.positionY(parcel);
    const z = this.parcels.positionZ(parcel);
    const oxygen = this.field === null ? AIR_OXYGEN : this.field.oxygenFractionAt(x, y, z);

    const wasBurning = this.parcels.burning(parcel);
    if (wasBurning) {
      const why = extinguishes(model, flux, oxygen, surface, gasSpeed);
      if (why !== EXTINCT_NONE) {
        this.parcels.setBurning(parcel, false);
        this.events.push(EVENT_EXTINGUISHED, parcel, -1, why);
      }
    } else if (
      ignites(model, surface, flux, total, oxygen, gasSpeed, this.parcels.piloted(parcel))
    ) {
      this.parcels.setBurning(parcel, true);
      this.events.push(EVENT_IGNITED, parcel, -1, surface);
    }

    const wasSmouldering = this.parcels.smouldering(parcel);
    const glowing = smoulders(model, this.parcels.charFractionOf(parcel), oxygen, surface);
    if (glowing !== wasSmouldering) {
      this.parcels.setSmouldering(parcel, glowing);
      this.events.push(glowing ? EVENT_SMOULDER_START : EVENT_SMOULDER_END, parcel, -1, surface);
    }

    /* A pilot lasts one tick. A caller holding a match holds it every tick. */
    this.parcels.clearPilot(parcel);
  }

  /** How close a parcel is to catching, 0 to 1. A readout; nothing branches on it. */
  ignitionProgressOf(parcel: number): number {
    const model = this.parcels.ignitionOf(this.parcels.substanceOf(parcel));
    if (model === null) return 0;
    const x = this.parcels.positionX(parcel);
    const y = this.parcels.positionY(parcel);
    const z = this.parcels.positionZ(parcel);
    return ignitionProgress(
      model,
      this.parcels.surfaceTemperatureOf(parcel),
      this.parcels.fuelFluxOf(parcel),
      this.field === null ? AIR_OXYGEN : this.field.oxygenFractionAt(x, y, z),
      this.parcels.piloted(parcel),
    );
  }

  /** Moles of each element in the parcels and the air together. Writes into `out`. */
  elementTotals(out: Float64Array): void {
    if (out.length !== ELEMENT_COUNT) {
      throw new Error(`a totals vector is ${ELEMENT_COUNT} wide, not ${out.length}`);
    }
    out.fill(0);
    for (let parcel = 0; parcel < this.parcels.count; parcel++) {
      if (!this.parcels.alive(parcel)) continue;
      this.parcels.elementTotalsOf(parcel, this.scratch);
      for (let e = 0; e < ELEMENT_COUNT; e++)
        out[e] = (out[e] as number) + (this.scratch[e] as number);
    }
    if (this.field !== null) {
      this.field.elementTotals(this.scratch);
      for (let e = 0; e < ELEMENT_COUNT; e++)
        out[e] = (out[e] as number) + (this.scratch[e] as number);
      /* Plus what has crossed the boundary in either direction — which includes the air every new
         chunk drew in, and is what makes this invariant while the live set is still growing. */
      this.field.ventedElementTotals(this.scratch);
      for (let e = 0; e < ELEMENT_COUNT; e++)
        out[e] = (out[e] as number) + (this.scratch[e] as number);
    }
  }
}

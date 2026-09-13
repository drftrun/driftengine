/**
 * The substep-and-clamp solver: how a reaction network runs without exploding.
 *
 * Combustion kinetics are **stiff**. A rate that changes by orders of magnitude over tens of
 * kelvin, integrated explicitly at a sixtieth of a second, overshoots — and the overshoot's failure
 * mode is negative mass, which in an exponential rate law is where the `NaN`s come from.
 *
 * `§7` answers it with two mechanisms rather than an implicit solver, and the reason that matters
 * is scope: an implicit solve over a stiff nonlinear network is what turns this track from an `XL`
 * into something unshippable.
 *
 * **Sub-stepping** sizes the step to the reaction, from how much of the scarcest reactant one full
 * step would consume. A cold shell takes one pass; a shell at flashover takes thirty-two.
 *
 * **The clamp** is what makes the remaining stiffness survivable. Before anything is applied, the
 * demands on each species are totalled, and where they exceed what is present **every reaction
 * drawing on that species is scaled by the same factor**. Proportional rather than first-come,
 * because first-come makes the answer depend on registration order — a determinism hole with no
 * symptom until two consumers register in a different order. The worst an overshoot can then do is
 * consume everything this substep, which is bounded, physical and self-correcting: with the
 * reactant gone the rate is zero.
 *
 * **Rates are first order in each reactant**, whatever the stoichiometric coefficient. Global rate
 * constants for pyrolysis and combustion are fitted that way, and it keeps the arithmetic to
 * multiplication — a fractional exponent would mean `Math.pow`, whose result ECMAScript does not
 * pin down, on the simulation path.
 */
import { temperatureFromCapacity } from '../species/thermal.ts';
import type { RateTable } from './rates.ts';

/** Reactions one substance may declare, and species one substance may hold. */
export const MAX_SUBSTANCE_REACTIONS = 64;
export const MAX_SUBSTANCE_SPECIES = 64;

/** The most passes one call will take. Past this the clamp is what holds it together. */
const MAX_SUBSTEPS = 32;

/** K a single sub-step is allowed to move a shell's temperature before it is split. */
const TEMPERATURE_BAND = 2;

/**
 * A substance's reactions, localised and packed.
 *
 * Species are **local** indices into the substance's own set, so a shell's composition is a dense
 * run of the few species it can actually hold rather than a row over all sixty-eight. Reactants and
 * products are CSR, the layout `physics/faces.ts` uses and for the same reason: traversal allocates
 * nothing.
 */
export interface SubstanceReactions {
  readonly count: number;
  readonly speciesCount: number;
  /** kg/mol for each local species. */
  readonly molarMass: Float64Array;
  /** J/(kg·K) at the standard state, and its rise per kelvin, for each local species. */
  readonly cpA: Float64Array;
  readonly cpB: Float64Array;
  /** K below and above which each reaction does not run, and the band the lower gate opens over. */
  readonly minTemperature: Float64Array;
  readonly maxTemperature: Float64Array;
  readonly gateWidth: Float64Array;
  /** The ceiling transport puts on each reaction in still air, per second. Zero means none. */
  readonly transportLimit: Float64Array;
  readonly reactantStart: Int32Array;
  readonly reactantLocal: Int32Array;
  readonly reactantMoles: Float64Array;
  readonly productStart: Int32Array;
  readonly productLocal: Int32Array;
  readonly productMoles: Float64Array;
  /** J per unit extent, derived by Hess's law at registration. */
  readonly enthalpy: Float64Array;
  /** `null` for an instant reaction: the clamp is its only limit. */
  readonly table: readonly (RateTable | null)[];
}

/* Module-scope scratch, so a tick allocates nothing. Nothing here nests. */
const moles = new Float64Array(MAX_SUBSTANCE_SPECIES);
const demand = new Float64Array(MAX_SUBSTANCE_SPECIES);
const factor = new Float64Array(MAX_SUBSTANCE_SPECIES);
const extent = new Float64Array(MAX_SUBSTANCE_REACTIONS);
const scale = new Float64Array(MAX_SUBSTANCE_REACTIONS);
const extentThisStep = new Float64Array(MAX_SUBSTANCE_REACTIONS);

/** A very large rate, for a reaction whose only limit is what is present. */
const INSTANT_RATE = 1e12;

function rateAtTemperature(table: RateTable | null, temperature: number): number {
  if (table === null) return INSTANT_RATE;
  if (temperature <= table.minTemperature) return table.rate[table.knots - 1] as number;
  if (temperature >= table.maxTemperature) return table.rate[0] as number;
  const position =
    ((1 / temperature - table.inverseMin) / (table.inverseMax - table.inverseMin)) *
    (table.knots - 1);
  const low = Math.floor(position);
  const high = low + 1;
  if (high >= table.knots) return table.rate[table.knots - 1] as number;
  const at = position - low;
  return (table.rate[low] as number) * (1 - at) + (table.rate[high] as number) * at;
}

/**
 * Temperature of the thing being reacted, **from what it is made of right now**.
 *
 * Read off the live moles rather than from a curve built when nothing had reacted yet, which is the
 * whole of CH-6's opening reversal. `A` and `B` are the mass-weighted heat capacities of whatever
 * is present, and inverting `h = A·ΔT + B·ΔT²/2` is a formula.
 */
function readTemperature(model: SubstanceReactions, joules: number): number {
  let A = 0;
  let B = 0;
  for (let i = 0; i < model.speciesCount; i++) {
    const mass = (moles[i] as number) * (model.molarMass[i] as number);
    if (mass === 0) continue;
    A += mass * (model.cpA[i] as number);
    B += mass * (model.cpB[i] as number);
  }
  return temperatureFromCapacity(A, B, joules);
}

/**
 * How far open a reaction's temperature gate is, 0 to 1.
 *
 * A gate is not a very small rate. Ice does not melt slowly below 273.15 K, it does not melt — and
 * expressing that as an Arrhenius tail would leak a trickle of water into every freezer.
 *
 * **The band tapers both ends, and the upper one had no user until condensation.** `gateWidth` was
 * written for a lower gate — the half-kelvin `PHASE_GATE_WIDTH` that keeps a melting plateau a
 * plateau rather than a sawtooth, by refusing to convert more in one step than the arriving heat can
 * pay for. `maxTemperature` cut hard, and nothing in the library set one, so it was a ceiling with
 * nothing under it.
 *
 * A condensation needs the mirror image and rings the same way without it: the temperature falls
 * through the dew point, the gate snaps open, latent heat comes *out*, the temperature rises back
 * through it, and the gate snaps shut. Same shape as melting with the signs reversed, so the same
 * taper answers it.
 *
 * The cost is one subtract, one divide and one compare per gated reaction per sub-step, on a path
 * `§7` cares about — paid by every reaction rather than only by the ones with an upper gate, because
 * a branch on `maxTemperature < Infinity` is a branch on a value that is uniform in practice and
 * unpredictable to the machine. What would make it wrong is a reaction wanting a sharp ceiling and a
 * soft floor, which would need two widths; none does.
 */
function gateOpening(model: SubstanceReactions, r: number, temperature: number): number {
  const high = model.maxTemperature[r] as number;
  if (temperature >= high) return 0;
  const low = model.minTemperature[r] as number;
  if (temperature <= low) return 0;
  const width = model.gateWidth[r] as number;
  if (!(width > 0)) return 1;
  let opening = (temperature - low) / width;
  /* `high` is `+Infinity` for every reaction with no ceiling, so this is `Infinity` and loses. */
  const closing = (high - temperature) / width;
  if (closing < opening) opening = closing;
  return opening >= 1 ? 1 : opening;
}

/** Extent per unit time, mol/s, first order in each reactant, zero outside its gate. */
function extentRate(
  model: SubstanceReactions,
  r: number,
  shellMass: number,
  temperature: number,
  transportFactor: number,
): number {
  const opening = gateOpening(model, r, temperature);
  if (opening === 0) return 0;
  let constant = rateAtTemperature(model.table[r] as RateTable | null, temperature);

  /*
   * A transport ceiling combines with the kinetic rate as a **series resistance**, which is the same
   * arithmetic a shell boundary uses and for the same reason: whichever is slower dominates, and
   * neither side has to know about the other. Above about 800 K carbon oxidation's chemistry
   * outruns oxygen delivery tenfold, so this is what is actually being watched.
   */
  const limit = (model.transportLimit[r] as number) * transportFactor;
  if (limit > 0 && constant > 0) constant = (constant * limit) / (constant + limit);

  let rate = constant * shellMass * opening;
  const from = model.reactantStart[r] as number;
  const to = model.reactantStart[r + 1] as number;
  for (let i = from; i < to; i++) {
    rate *= (moles[model.reactantLocal[i] as number] as number) / shellMass;
    if (rate === 0) return 0;
  }
  return rate;
}

/**
 * Run one shell's reactions for `dt` seconds.
 *
 * `composition` holds this shell's species masses in kilograms at `offset`; `enthalpy` holds its
 * joules at `enthalpyIndex`. Both are written in place.
 */
export function reactShell(
  composition: Float64Array,
  offset: number,
  enthalpy: Float64Array,
  enthalpyIndex: number,
  model: SubstanceReactions,
  shellMass: number,
  dt: number,
  /**
   * How much faster than still air the reactants are reaching a surface.
   *
   * One in still air, rising with the gas moving past — which is why blowing on embers makes them
   * brighter, and why it stops when you stop.
   */
  transportFactor = 1,
): void {
  if (model.count === 0 || dt <= 0 || !(shellMass > 0)) return;

  const species = model.speciesCount;
  for (let i = 0; i < species; i++) {
    moles[i] = (composition[offset + i] as number) / (model.molarMass[i] as number);
  }

  /*
   * How many passes, from how much of the scarcest reactant one whole step would take. Measured
   * once at the temperature the step starts from: a shell that is about to run away is one whose
   * first evaluation already says so.
   */
  let temperature = readTemperature(model, enthalpy[enthalpyIndex] as number);
  demand.fill(0, 0, species);
  for (let r = 0; r < model.count; r++) {
    const rate = extentRate(model, r, shellMass, temperature, transportFactor) * dt;
    extentThisStep[r] = rate;
    const from = model.reactantStart[r] as number;
    const to = model.reactantStart[r + 1] as number;
    for (let i = from; i < to; i++) {
      const local = model.reactantLocal[i] as number;
      demand[local] = (demand[local] as number) + (model.reactantMoles[i] as number) * rate;
    }
  }
  let stiffness = 0;
  for (let i = 0; i < species; i++) {
    const have = moles[i] as number;
    if (!(have > 0)) continue;
    const want = (demand[i] as number) / have;
    if (want > stiffness) stiffness = want;
  }

  /*
   * And how far one whole step would move the temperature.
   *
   * Reactant availability alone is not enough, and a phase change is what showed it: melting is
   * limited by heat rather than by how much ice is left, so a step that converts a tenth of the
   * ice looks perfectly well-resolved on the mass estimate while absorbing enough latent heat to
   * throw the temperature sixty kelvin the wrong way. Measured at a 16 K undershoot on a boiling
   * kettle before this term existed.
   */
  let heat = 0;
  let capacity = 0;
  for (let r = 0; r < model.count; r++) {
    heat += Math.abs((model.enthalpy[r] as number) * (extentThisStep[r] as number));
  }
  for (let i = 0; i < species; i++) {
    const mass = (moles[i] as number) * (model.molarMass[i] as number);
    if (mass > 0) capacity += mass * (model.cpA[i] as number);
  }
  if (capacity > 0) {
    const swing = heat / (capacity * TEMPERATURE_BAND);
    if (swing > stiffness) stiffness = swing;
  }
  const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(stiffness)));
  const step = dt / substeps;

  for (let pass = 0; pass < substeps; pass++) {
    if (pass > 0) {
      temperature = readTemperature(model, enthalpy[enthalpyIndex] as number);
    }

    demand.fill(0, 0, species);
    for (let r = 0; r < model.count; r++) {
      const total = extentRate(model, r, shellMass, temperature, transportFactor) * step;
      extent[r] = total;
      if (total === 0) continue;
      const from = model.reactantStart[r] as number;
      const to = model.reactantStart[r + 1] as number;
      for (let i = from; i < to; i++) {
        const local = model.reactantLocal[i] as number;
        demand[local] = (demand[local] as number) + (model.reactantMoles[i] as number) * total;
      }
    }

    /* One factor per species, so two reactions competing for the same reactant are cut alike. */
    for (let i = 0; i < species; i++) {
      const want = demand[i] as number;
      const have = moles[i] as number;
      factor[i] = want > have ? (have > 0 ? have / want : 0) : 1;
    }
    for (let r = 0; r < model.count; r++) {
      let smallest = 1;
      const from = model.reactantStart[r] as number;
      const to = model.reactantStart[r + 1] as number;
      for (let i = from; i < to; i++) {
        const f = factor[model.reactantLocal[i] as number] as number;
        if (f < smallest) smallest = f;
      }
      scale[r] = smallest;
    }

    for (let r = 0; r < model.count; r++) {
      const xi = (extent[r] as number) * (scale[r] as number);
      if (xi === 0) continue;
      const rFrom = model.reactantStart[r] as number;
      const rTo = model.reactantStart[r + 1] as number;
      for (let i = rFrom; i < rTo; i++) {
        const local = model.reactantLocal[i] as number;
        moles[local] = (moles[local] as number) - (model.reactantMoles[i] as number) * xi;
        if ((moles[local] as number) < 0) moles[local] = 0;
      }
      const pFrom = model.productStart[r] as number;
      const pTo = model.productStart[r + 1] as number;
      for (let i = pFrom; i < pTo; i++) {
        const local = model.productLocal[i] as number;
        moles[local] = (moles[local] as number) + (model.productMoles[i] as number) * xi;
      }
      /* Exothermic is a negative `ΔH`, and it *adds* to the enthalpy that reads as heat. */
      enthalpy[enthalpyIndex] =
        (enthalpy[enthalpyIndex] as number) - (model.enthalpy[r] as number) * xi;
    }
  }

  for (let i = 0; i < species; i++) {
    composition[offset + i] = (moles[i] as number) * (model.molarMass[i] as number);
  }
}

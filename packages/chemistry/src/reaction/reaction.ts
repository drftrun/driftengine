/**
 * What a reaction is: stoichiometry, a rate law, and what kind of change it represents.
 *
 * **No enthalpy field**, and that is the same decision `SpeciesDefinition` makes about molar mass.
 * A reaction's `ΔH` is derived from its species' formation enthalpies by Hess's law at
 * registration, so a number that disagreed with its own species cannot exist. `§5` of the design is
 * the argument, and CH-0's heating-value test is what makes the underlying numbers trustworthy.
 *
 * **No gates yet.** The design's `ReactionGates` — a minimum oxygen fraction, a phase requirement,
 * a moisture ceiling — are refused in this phase rather than stubbed: an oxygen gate without a gas
 * field to read is a constant pretending to be physics, and the field is CH-4. The network here
 * runs on mass action alone.
 */

export const KIND_DRYING = 0;
export const KIND_PYROLYSIS = 1;
export const KIND_COMBUSTION = 2;
export const KIND_CHAR_OXIDATION = 3;
export const KIND_CALCINATION = 4;
export const KIND_CORROSION = 5;
export const KIND_DISSOLUTION = 6;
export const KIND_DENATURATION = 7;
export const KIND_BROWNING = 8;
export const KIND_BIOLOGICAL = 9;
export const KIND_PHASE_CHANGE = 10;

export type ReactionKind =
  | typeof KIND_DRYING
  | typeof KIND_PYROLYSIS
  | typeof KIND_COMBUSTION
  | typeof KIND_CHAR_OXIDATION
  | typeof KIND_CALCINATION
  | typeof KIND_CORROSION
  | typeof KIND_DISSOLUTION
  | typeof KIND_DENATURATION
  | typeof KIND_BROWNING
  | typeof KIND_BIOLOGICAL
  | typeof KIND_PHASE_CHANGE;

export interface SpeciesAmount {
  readonly species: string;
  /** Moles per unit of reaction extent. Fractional is allowed and often necessary. */
  readonly moles: number;
}

/**
 * `k(T) = A · T^n · exp(−Ea / R·T)`. Monotonic in temperature, which is right for everything a
 * flame does and wrong for everything an enzyme does.
 */
export interface ArrheniusKinetics {
  readonly type: 'arrhenius';
  readonly A: number;
  /** J/mol. */
  readonly activationEnergy: number;
  readonly n?: number;
}

/**
 * A peaked curve: zero below `minimum`, one at `optimum`, zero above `maximum`.
 *
 * **Enzyme-catalysed rates are not Arrhenius**, and using one gives compost that heats forever.
 * `§8.6` is the argument; this is where the shape lives.
 */
export interface CardinalKinetics {
  readonly type: 'cardinal';
  /** The rate at the optimum. */
  readonly peak: number;
  readonly minimum: number;
  readonly optimum: number;
  readonly maximum: number;
}

/**
 * Arrhenius, capped by how fast the reactant can physically reach the surface.
 *
 * **This is what makes char glow for an hour instead of vanishing in seconds, and `§7` says why.**
 * Above about 800 K the chemistry of carbon oxidation outruns oxygen delivery by an order of
 * magnitude, so what you are actually watching is transport. The kinetic rate alone gives char that
 * disappears; the cap gives char that sits there glowing, which is what char does.
 *
 * The two combine as a **series resistance** — `1/k = 1/k_kinetic + 1/k_transport` — which is the
 * same arithmetic a shell boundary uses for the same reason, and it means neither side has to know
 * about the other. And the transport half rises with the gas moving past, so **blowing on embers
 * makes them brighter and stops when you stop**.
 */
export interface DiffusionKinetics {
  readonly type: 'diffusion';
  readonly A: number;
  /** J/mol. */
  readonly activationEnergy: number;
  readonly n?: number;
  /** The ceiling transport puts on it in still air, per second. */
  readonly transportLimit: number;
}

/** As fast as the reactants allow: the clamp in the solver is the only thing limiting it. */
export interface InstantKinetics {
  readonly type: 'instant';
}

export type Kinetics = ArrheniusKinetics | CardinalKinetics | DiffusionKinetics | InstantKinetics;

/**
 * When a reaction is allowed to run at all.
 *
 * Separate from the rate law because it is a different kind of statement: kinetics say how fast,
 * a gate says whether. Ice does not melt at all below 273.15 K, and expressing that as a very small
 * Arrhenius rate would be a lie that leaks a trickle of water into every freezer.
 */
export interface ReactionGates {
  /** K. Below this, nothing. */
  readonly minTemperature?: number;
  /** K. Above this, nothing. */
  readonly maxTemperature?: number;
  /**
   * K over which a gate opens rather than snapping: upward from `minTemperature`, and downward from
   * `maxTemperature` where there is one.
   *
   * Zero for a pure substance. A few kelvin for a mixture: butter softens over about three, because
   * it is triglycerides with different melting points, and that band is what makes fat render
   * slowly instead of switching from solid to liquid.
   *
   * **One number for both ends**, because no reaction here wants a sharp ceiling over a soft floor
   * and a second field would be a knob nobody turns. A reaction with both gates set tapers
   * symmetrically and is fully open only between them.
   */
  readonly width?: number;
}

export interface Reaction {
  readonly id: string;
  readonly reactants: readonly SpeciesAmount[];
  readonly products: readonly SpeciesAmount[];
  readonly kinetics: Kinetics;
  readonly kind: ReactionKind;
  readonly gates?: ReactionGates;
}

/**
 * A phase change, as the reaction it actually is.
 *
 * **Its enthalpy is not given here and must not be**: Hess's law over CH-0's formation enthalpies
 * gives 333,611 J/kg for ice melting against a literature 333,550, and — the part that settles the
 * design — 2,442,631 J/kg for water boiling, which is the value **at 298.15 K** rather than the
 * 2,256,400 quoted at the boiling point. That is right, and it means the latent heat at any
 * temperature stops being stored and becomes a consequence of the heat capacities either side,
 * varying the way the real one does.
 *
 * **A fast finite rate rather than `Instant`, and the difference is the whole plateau.** Instant
 * kinetics would let the clamp convert every gram of water it could reach in a single sub-step —
 * two and a half megajoules absorbed at once, and a temperature that falls hundreds of kelvin below
 * the boiling point rather than sitting on it. A finite rate through an opening gate is a
 * proportional controller instead: the further above the transition the temperature strays, the
 * more converts, the more heat is absorbed, and it settles just above with an overshoot
 * proportional to the flux arriving. That settling *is* the plateau, and it comes out of the
 * substep-and-clamp solver rather than out of a table.
 *
 * `activationEnergy: 0` makes the Arrhenius form a constant, so no second kinetics kind was needed.
 */
export function phaseChange(
  id: string,
  from: string,
  to: string,
  temperature: number,
  width = PHASE_GATE_WIDTH,
  rate = PHASE_RATE,
): Reaction {
  return {
    id,
    reactants: [{ species: from, moles: 1 }],
    products: [{ species: to, moles: 1 }],
    kinetics: { type: 'arrhenius', A: rate, activationEnergy: 0 },
    kind: KIND_PHASE_CHANGE,
    gates: { minTemperature: temperature, width },
  };
}

/**
 * A phase change the other way up: the one that runs as something *cools*.
 *
 * **`phaseChange` is "heat arrives" and this is "heat leaves", and the pair is not symmetric by
 * accident.** Everything the library had until now was the first kind — ice melts, water boils, wax
 * vaporises — because a fire is heat arriving. A vapour condensing is the same mechanism read
 * backwards: it runs *below* a temperature rather than above one, its gate closes as the
 * temperature rises through the transition, and its enthalpy comes out with the opposite sign
 * because Hess's law over the two species already carries it.
 *
 * **The gate closes over `width` rather than snapping**, and `gateOpening` grew the upper taper for
 * this. Without it the pair rings: the temperature falls through the transition, the gate opens
 * fully, latent heat is released, the temperature rises back through it, and the gate slams. That
 * is `PHASE_GATE_WIDTH`'s argument with the signs reversed, so it takes the same answer.
 *
 * **A condensation wants a reverse reaction and its caller must write one.** Nothing here pairs
 * them, because a pair is two entries in a network and the network is data. A condensation with no
 * evaporation is a one-way sink: droplets that drift back into a flame stay droplets, and the smoke
 * over a fire never turns black again.
 */
export function condensation(
  id: string,
  from: string,
  to: string,
  temperature: number,
  width = PHASE_GATE_WIDTH,
  rate = PHASE_RATE,
): Reaction {
  return {
    id,
    reactants: [{ species: from, moles: 1 }],
    products: [{ species: to, moles: 1 }],
    kinetics: { type: 'arrhenius', A: rate, activationEnergy: 0 },
    kind: KIND_PHASE_CHANGE,
    gates: { maxTemperature: temperature, width },
  };
}

/**
 * How fast a phase change runs with its gate fully open, per second.
 *
 * **A gain, not a physical constant, and it is bounded from both sides.** Too high and one step
 * converts more than the arriving heat can pay for, so the temperature undershoots and the pair
 * rings. Too low and the phase change cannot keep up with a real flux — at this value a kilogram
 * boils at up to half a gram a second per kelvin of overshoot, which is about 1.2 kW and rises with
 * the overshoot, so a kettle settles a thousandth of a kelvin above its boiling point and a blowtorch
 * settles further above it. That the band widens with the flux is correct rather than a compromise.
 */
export const PHASE_RATE = 0.5;

/**
 * K over which a phase change's gate opens, for a pure substance.
 *
 * Not zero, and that is what keeps the plateau a plateau rather than a sawtooth: a gate that snapped
 * fully open a hair above the transition would convert far more than the arriving heat can pay for,
 * undershoot, snap shut, and ring. Half a kelvin is the band the temperature is then held within.
 */
export const PHASE_GATE_WIDTH = 0.5;

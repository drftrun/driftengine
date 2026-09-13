/**
 * The reactions every family reaches through: water changing phase, gas burning, char oxidising.
 *
 * **Not an entry point.** A consumer imports a family and gets whatever of this it needs, so
 * `library/mineral` never pulls in a methane flame.
 *
 * **The activation energies are literature; the pre-exponentials are order of magnitude.** A
 * published single-step combustion rate law carries fractional reaction orders — Westbrook and
 * Dryer give methane as `[CH₄]^−0.3·[O₂]^1.3` — and there is no exact conversion of that into the
 * first-order mass action this solver runs. So `Ea` is the measured barrier and `A` is chosen to put
 * the rate in the right decade at flame temperature. Said here rather than implied, because a
 * reader is entitled to know which half of a rate constant is a measurement.
 *
 * That is a bounded looseness rather than a free one: a flame's *temperature* comes from the
 * enthalpy, which is derived, and its *extent* from the oxygen the field delivers, which is
 * transport. What `A` sets is how thin the reaction zone is.
 */
import { GAS_CONSTANT } from '../reaction/rates.ts';
import {
  KIND_CHAR_OXIDATION,
  KIND_COMBUSTION,
  type Reaction,
  phaseChange,
} from '../reaction/reaction.ts';

export const MELT_ICE = 'melt-ice';
export const BOIL_WATER = 'boil-water';
export const BURN_METHANE = 'burn-methane';
export const BURN_CARBON_MONOXIDE = 'burn-carbon-monoxide';
export const BURN_HYDROGEN = 'burn-hydrogen';
export const BURN_ETHYLENE = 'burn-ethylene';
export const BURN_SOOT = 'burn-soot';
export const SOOT_METHANE = 'soot-methane';
export const OXIDISE_CHAR = 'oxidise-char';
export const OXIDISE_CHAR_RICH = 'oxidise-char-rich';

/** The gas-phase steps, which is what a `AtmosphereField` is given rather than a parcel. */
export const GAS_REACTIONS: readonly string[] = [
  BURN_METHANE,
  BURN_CARBON_MONOXIDE,
  BURN_HYDROGEN,
  BURN_ETHYLENE,
  BURN_SOOT,
  SOOT_METHANE,
];

/**
 * How much char goes to CO rather than CO₂ at a temperature, per Arthur's measured relation.
 *
 * **Nothing in the model calls this.** It is here so a test can assert that the two char reactions
 * reproduce it, and so a reader can see what the two activation energies below mean. The relation
 * itself is `§8.5`'s, and its consequence is the one the design cares about: a cool smoulder makes
 * mostly CO₂ and a hot one makes mostly CO, so an oxygen-starved fire in a closed room produces
 * carbon monoxide faster than an open one would.
 */
export function arthurRatio(temperature: number): number {
  // determinism: build-time — a substance's tabulated property, built at registration
  return 2500 * Math.exp(-6240 / temperature);
}

/**
 * The gap between the two char paths' activation energies, and it is `6240·R` exactly.
 *
 * That is the whole trick. `k_rich/k_lean = (A_rich/A_lean)·exp(−ΔEa/R·T)`, so setting
 * `ΔEa = 6240·R` and `A_rich/A_lean = 2500` makes the ratio Arthur's relation identically, at every
 * temperature, with nothing tabulated and no branch anywhere.
 */
const ARTHUR_GAP = 6240 * GAS_CONSTANT;

/** Kinetically controlled char oxidation, before transport takes over above about 800 K. */
const CHAR_A = 1e7;
const CHAR_EA = 140000;

/**
 * The ceiling oxygen delivery puts on char oxidation in still air, per second.
 *
 * **This is what makes char glow for an hour rather than vanishing in a minute**, and `§7` is the
 * argument. Above about 800 K the kinetic rate is orders of magnitude faster than oxygen can reach
 * the surface, so what is being watched is transport; the solver combines the two as a series
 * resistance and the transport half wins. It rises with the gas moving past, which is why blowing
 * on an ember brightens it.
 *
 * At this value a kilogram of char lasts tens of thousands of seconds in still air, which is the
 * hour a real bed of embers lasts.
 */
const CHAR_TRANSPORT = 1e-5;

export const COMMON_REACTIONS: readonly Reaction[] = [
  /*
   * The two water transitions, as CH-6's gated reactions rather than as shape in a curve. Their
   * latent heats are Hess's law over the formation enthalpies and are not written anywhere: 333.6
   * kJ/kg for fusion and 2,442.6 for vaporisation, the latter being the value at 298.15 K rather
   * than the 2,256.4 quoted at the boiling point — which is right, and is why the latent heat at any
   * temperature is a consequence here rather than a stored number.
   */
  phaseChange(MELT_ICE, 'H2O(s)', 'H2O(l)', 273.15),
  phaseChange(BOIL_WATER, 'H2O(l)', 'H2O(g)', 373.15),

  /* Gas-phase combustion. Every flame over a solid is one of these; the solid only makes the gas. */
  {
    id: BURN_METHANE,
    reactants: [
      { species: 'CH4', moles: 1 },
      { species: 'O2', moles: 2 },
    ],
    products: [
      { species: 'CO2', moles: 1 },
      { species: 'H2O(g)', moles: 2 },
    ],
    kinetics: { type: 'arrhenius', A: 2.1e11, activationEnergy: 202500 },
    kind: KIND_COMBUSTION,
  },
  {
    /* The second stage, and where a flame's blue comes from. It is also the slow one: CO burns out
       well after the hydrocarbons, which is why a rich flame's tip is where the CO finally goes. */
    id: BURN_CARBON_MONOXIDE,
    reactants: [
      { species: 'CO', moles: 1 },
      { species: 'O2', moles: 0.5 },
    ],
    products: [{ species: 'CO2', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 1e10, activationEnergy: 167400 },
    kind: KIND_COMBUSTION,
  },
  {
    id: BURN_HYDROGEN,
    reactants: [
      { species: 'H2', moles: 1 },
      { species: 'O2', moles: 0.5 },
    ],
    products: [{ species: 'H2O(g)', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 1e11, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
  {
    id: BURN_ETHYLENE,
    reactants: [
      { species: 'C2H4', moles: 1 },
      { species: 'O2', moles: 3 },
    ],
    products: [
      { species: 'CO2', moles: 2 },
      { species: 'H2O(g)', moles: 2 },
    ],
    kinetics: { type: 'arrhenius', A: 2e12, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
  {
    /* Soot burning out in the flame tip, which is what stops a luminous flame smoking when there is
       enough air — and what fails to happen when there is not. */
    id: BURN_SOOT,
    reactants: [
      { species: 'C(soot)', moles: 1 },
      { species: 'O2', moles: 1 },
    ],
    products: [{ species: 'CO2', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 1e6, activationEnergy: 140000 },
    kind: KIND_COMBUSTION,
  },

  {
    /*
     * **Soot, and nothing decides when it forms.** `§8.4` says a flame is orange because it holds
     * incandescent soot and blue because it does not, and that the difference is the equivalence
     * ratio — but there is no gate on φ here and there does not need to be. This reaction needs no
     * oxygen and `burn-methane` needs two, so in a cell with air the oxidation wins and in one that
     * has run out this is the only path left. **A rich flame soots and a lean one does not, out of
     * mass action.**
     *
     * `CH₄ → C(soot) + 2 H₂` is methane's real thermal decomposition, and its activation energy
     * puts the onset near 1,000 K — which is where soot genuinely starts forming in a flame.
     *
     * Soot is `C(soot)`, a **species**, so the carbon stays in the element ledger. A soot channel
     * that carried mass outside `elementTotals` would make the most valuable assertion in the track
     * quietly wrong every time a fire made smoke.
     */
    id: SOOT_METHANE,
    reactants: [{ species: 'CH4', moles: 1 }],
    products: [
      { species: 'C(soot)', moles: 1 },
      { species: 'H2', moles: 2 },
    ],
    kinetics: { type: 'arrhenius', A: 1e13, activationEnergy: 250000 },
    kind: KIND_COMBUSTION,
  },

  /*
   * Char, the two ways. See `ARTHUR_GAP`: the pair carries the measured CO/CO₂ split in the gap
   * between their activation energies, so the split emerges rather than being decided anywhere.
   */
  {
    id: OXIDISE_CHAR,
    reactants: [
      { species: 'C(char)', moles: 1 },
      { species: 'O2', moles: 1 },
    ],
    products: [{ species: 'CO2', moles: 1 }],
    kinetics: {
      type: 'diffusion',
      A: CHAR_A,
      activationEnergy: CHAR_EA,
      transportLimit: CHAR_TRANSPORT,
    },
    kind: KIND_CHAR_OXIDATION,
  },
  {
    id: OXIDISE_CHAR_RICH,
    reactants: [
      { species: 'C(char)', moles: 1 },
      { species: 'O2', moles: 0.5 },
    ],
    products: [{ species: 'CO', moles: 1 }],
    kinetics: {
      type: 'diffusion',
      A: CHAR_A * 2500,
      activationEnergy: CHAR_EA + ARTHUR_GAP,
      transportLimit: CHAR_TRANSPORT,
    },
    kind: KIND_CHAR_OXIDATION,
  },
];

/** Every char and water reaction a solid needs, which is what a burnable substance declares. */
export const SOLID_COMMON: readonly string[] = [BOIL_WATER, OXIDISE_CHAR, OXIDISE_CHAR_RICH];

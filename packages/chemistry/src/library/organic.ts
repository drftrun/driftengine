/**
 * `@driftengine/chemistry/library/organic` — wood, and the things made out of plants and hides.
 *
 * **Wood does not burn.** It decomposes into gas, and the gas burns; the log itself only glows where
 * the char is oxidising. `§8.3` is the argument, and everything here follows from it: three
 * polymers with three kinetics, a competition inside cellulose that decides char yield, and a flame
 * that is somewhere else.
 *
 * **Three species are registered here rather than in `species/standard.ts`.** `tar` is meaningless
 * outside a wood fire, `tar(l)` outside a wood fire that is cooling, and `cellulose(active)` outside
 * this scheme, so putting any of them in the standard table would charge every consumer of the
 * engine for all three.
 */
import {
  PHASE_GAS,
  PHASE_LIQUID,
  PHASE_SOLID,
  type SpeciesDefinition,
} from '../species/species.ts';
import {
  KIND_COMBUSTION,
  KIND_PYROLYSIS,
  type Reaction,
  condensation,
  phaseChange,
} from '../reaction/reaction.ts';
import { SHAPE_CYLINDER, SHAPE_SLAB } from '../parcel/shells.ts';
import { massFractions } from '../substance/composition.ts';
import { wetComposition } from '../substance/substance.ts';
import type { SubstanceThermal } from '../substance/substance.ts';
import type { SubstanceLibrary } from './library.ts';
import {
  BOIL_WATER,
  COMMON_REACTIONS,
  GAS_REACTIONS,
  OXIDISE_CHAR,
  OXIDISE_CHAR_RICH,
} from './common.ts';

export const BURN_TAR = 'burn-tar';
export const SOOT_TAR = 'soot-tar';
export const CONDENSE_TAR = 'condense-tar';
export const EVAPORATE_TAR = 'evaporate-tar';

/**
 * The gas-phase steps a wood fire needs: the common five, plus the four this library invents.
 *
 * A consumer hands these to `AtmosphereField`, which runs them through the same solver a shell uses.
 */
export const ORGANIC_GAS_REACTIONS: readonly string[] = [
  ...GAS_REACTIONS,
  BURN_TAR,
  SOOT_TAR,
  CONDENSE_TAR,
  EVAPORATE_TAR,
];

/**
 * K. Where wood tar stops being a vapour, and it is a dew point rather than a boiling point.
 *
 * **Levoglucosan boils near 658 K and this is 135 K below that, which is the difference between a
 * pure liquid and a trace vapour in air.** Condensation happens where the tar's partial pressure
 * reaches its saturation pressure, and a plume carrying tens of grams of tar per cubic metre is
 * nowhere near a pure atmosphere of the stuff. Clausius-Clapeyron over the vaporisation enthalpy
 * this library already derives — 104,987 J/mol, the gap between the two tar species below — puts the
 * dew point at 547 K for 100 g/m³ and 497 K for 10, so a smoke-scale loading condenses somewhere in
 * the low five hundreds. 523 K is 250 °C, sits inside that band, and is the figure biomass
 * gasification quotes for when a producer gas starts fouling its own pipework with tar.
 *
 * **What it separates is the whole point.** A flame is 1,200 K and up, so the gate is shut there and
 * the tar burns or cracks to soot: a flaming fire's smoke is black. A smouldering surface pushes tar
 * into air a few hundred kelvin, the gate is open, and it condenses to droplets: a smouldering
 * fire's smoke is pale. Nothing chooses between them and no equivalence ratio is read — the two are
 * Arrhenius rates that need heat and this is a gate that needs the absence of it.
 *
 * **What would make it wrong** is a consumer whose cells are large enough to dilute a plume well
 * below smoke-scale loadings, where the true dew point drops toward 450 K and this would condense
 * tar that should still be flying. The fix then is a partial-pressure gate, which `ReactionGates`
 * cannot express — it is temperature only, which is the same limit that keeps rusting from being
 * gated on humidity.
 */
const TAR_DEW_POINT = 523.15;

/**
 * K over which the dew point opens, and it is a band because tar is not one molecule.
 *
 * `PHASE_GATE_WIDTH`'s half a kelvin is right for water, which is a pure substance with a plateau of
 * zero width. Pyrolysis tar is levoglucosan plus anhydrosugars plus phenolics plus whatever the
 * lignin gave up, and a mixture condenses over a range the way a distillation cut boils over one —
 * which is the same argument `fuel/`'s diesel and kerosene take their twenty-kelvin widths from.
 * Twenty-five kelvin here, so the heaviest fraction is already droplets while the lightest is still
 * vapour, and a plume greys rather than switching.
 */
const TAR_DEW_BAND = 25;

/**
 * Cellulose's activated intermediate, and its enthalpy is cellulose's **exactly**.
 *
 * Broido-Shafizadeh's first step is a depolymerisation that leaves the repeat unit intact, and no
 * measurement separates the two states thermochemically. Giving the intermediate a different
 * formation enthalpy would put a number into the model that nothing measured, and Hess's law would
 * then spend it on every gram of cellulose that ever pyrolyses. Equal is the honest value, and it
 * makes the activation step cost nothing — which is what "the same molecule, rearranged" means.
 */
const ACTIVE_CELLULOSE: SpeciesDefinition = {
  id: 'cellulose(active)',
  formula: { C: 6, H: 10, O: 5 },
  phase: PHASE_SOLID,
  formationEnthalpy: -968957,
  cpA: 1340,
  cpB: 4.9,
  pseudo: true,
};

/**
 * Wood pyrolysis tar, as the levoglucosan it mostly is — a gas, because it leaves as a vapour.
 *
 * **Its formation enthalpy is back-derived from two measurements, neither of which is a pyrolysis
 * heat.** The higher heating value of wood pyrolysis oil is 17.0 MJ/kg, which fixes the condensed
 * value at −1,033.8 kJ/mol; the sublimation enthalpy of levoglucosan is 105 kJ/mol, which lifts it
 * to the vapour. That the volatile branch then comes out at the *third* measured quantity —
 * +248 kJ/kg against `§8.3`'s +255 — is the check, and `organic.test.ts` is where it is made.
 *
 * The same formula as cellulose, and that is not a coincidence: fast cellulose pyrolysis is
 * depolymerisation, so the tar carries the repeat unit away whole. The endotherm is the vaporisation
 * and nothing else, which is why a pyrolysing surface cools itself.
 */
const TAR: SpeciesDefinition = {
  id: 'tar',
  formula: { C: 6, H: 10, O: 5 },
  phase: PHASE_GAS,
  formationEnthalpy: -928813,
  cpA: 1600,
  cpB: 1.2,
  pseudo: true,
};

/**
 * The same tar as droplets, and **its enthalpy is the measured number rather than a derived one**.
 *
 * Read `TAR` above and this falls out of it. That comment back-derives the vapour from two
 * measurements: pyrolysis oil's higher heating value of 17.0 MJ/kg, which fixes the **condensed**
 * value at −1,033,800 J/mol, and levoglucosan's 105 kJ/mol of sublimation, which lifts it to the
 * gas. So the condensed species is where the measurement actually lands, and the vapour that shipped
 * first was the derived one — a gas because a wood fire's tar leaves as a vapour, and nothing had
 * anywhere to put it once it cooled.
 *
 * Nothing new is asserted by writing it down: `-1033800` burns to 6 CO₂ and 5 H₂O(l) at exactly
 * 17.0 MJ/kg over 162.14 g/mol, which is where it came from, and the gap to `TAR` is the 104,987
 * J/mol that `TAR_DEW_POINT` is computed against. Two species, one measurement, and Hess's law
 * carries the latent heat between them without it being stored anywhere.
 *
 * **A liquid rather than a solid, and the field reads the phase.** Condensed tar is micrometre
 * droplets suspended in gas — an aerosol — and `AtmosphereField.aerosolAt` sums every carried
 * species in the liquid phase for that reason, which is what makes this the pale half of smoke
 * without either file naming the other. Real tar is a glassy semi-solid at room temperature; a
 * `PHASE_SOLID` here would file it with soot, which is the black half, and get the colour backwards.
 *
 * `cpA` is bio-oil's, near 1,900 J/kg·K, above its own vapour's the way a condensed organic's
 * usually is.
 */
const CONDENSED_TAR: SpeciesDefinition = {
  id: 'tar(l)',
  formula: { C: 6, H: 10, O: 5 },
  phase: PHASE_LIQUID,
  formationEnthalpy: -1033800,
  cpA: 1900,
  cpB: 2.0,
  pseudo: true,
};

const REACTIONS: readonly Reaction[] = [
  ...COMMON_REACTIONS,

  /*
   * Broido-Shafizadeh, as `§8.3` draws it. The activation energies are the published ones; the
   * pre-exponentials are too, and together they put cellulose's peak at 350-380 °C where it is
   * measured.
   */
  {
    id: 'activate-cellulose',
    reactants: [{ species: 'cellulose', moles: 1 }],
    products: [{ species: 'cellulose(active)', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 2.8e19, activationEnergy: 242400 },
    kind: KIND_PYROLYSIS,
  },
  {
    /*
     * **The high-`Ea` branch, and it wins when heating is fast.** That single fact is the most
     * useful thing in the whole model: kindling thrown on a hot fire is consumed to fine ash, and a
     * log at the edge of one chars deeply and barely flames. Nothing chooses; the rates do.
     */
    id: 'cellulose-to-tar',
    reactants: [{ species: 'cellulose(active)', moles: 1 }],
    products: [{ species: 'tar', moles: 1 }],
    kinetics: { type: 'arrhenius', A: 3.28e14, activationEnergy: 196500 },
    kind: KIND_PYROLYSIS,
  },
  {
    /*
     * **The low-`Ea` branch, and it wins when heating is slow.** A quarter of the mass stays behind
     * as carbon and the step is exothermic, which is how a covered pit turns wood into charcoal
     * without anybody implementing charcoal.
     */
    id: 'cellulose-to-char',
    reactants: [{ species: 'cellulose(active)', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 3.5 },
      { species: 'CO', moles: 1 },
      { species: 'CO2', moles: 0.5 },
      { species: 'CH4', moles: 1 },
      { species: 'H2O(g)', moles: 3 },
    ],
    kinetics: { type: 'arrhenius', A: 1.3e10, activationEnergy: 150500 },
    kind: KIND_PYROLYSIS,
  },
  {
    /* First to go, at about 250 °C, and CO₂-rich — which is why the first smoke off a fresh log is
       thin and pale and does not want to catch. */
    id: 'pyrolyse-hemicellulose',
    reactants: [{ species: 'hemicellulose', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 2 },
      { species: 'CO', moles: 1 },
      { species: 'CO2', moles: 0.75 },
      { species: 'CH4', moles: 1.25 },
      { species: 'H2O(g)', moles: 1.5 },
    ],
    kinetics: { type: 'arrhenius', A: 2e16, activationEnergy: 186700 },
    kind: KIND_PYROLYSIS,
  },
  {
    /* Slow, broad, and the main char source: 43% of it stays behind as carbon, which is most of
       what a bed of embers is made of. */
    id: 'pyrolyse-lignin',
    reactants: [{ species: 'lignin', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 6 },
      { species: 'CO2', moles: 1 },
      { species: 'CH4', moles: 2 },
      { species: 'H2O(g)', moles: 1 },
    ],
    kinetics: { type: 'arrhenius', A: 9.55e8, activationEnergy: 108000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /*
     * Resin and terpenes cracking, and **this is why pine flares and oak does not**. There is no
     * single published pair for a lump this broad, so the rate is set to peak in the 150-250 °C band
     * that terpene volatilisation is measured in — which is well below any of the three polymers,
     * so a resinous wood gives off something combustible before it is properly hot.
     */
    id: 'pyrolyse-extractives',
    reactants: [{ species: 'extractives', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 4 },
      { species: 'CH4', moles: 2 },
      { species: 'C2H4', moles: 2 },
    ],
    kinetics: { type: 'arrhenius', A: 1e8, activationEnergy: 100000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /*
     * Protein chars heavily and gives up its nitrogen as ammonia and hydrogen cyanide, because that
     * is where 1.3 nitrogens per residue have to go. Nothing here knows that burning hides is
     * dangerous; the formula does.
     */
    id: 'pyrolyse-collagen',
    reactants: [{ species: 'collagen', moles: 1 }],
    products: [
      { species: 'C(char)', moles: 2.9 },
      { species: 'NH3', moles: 1 },
      { species: 'HCN', moles: 0.3 },
      { species: 'CO', moles: 0.6 },
      { species: 'CH4', moles: 0.5 },
      { species: 'H2O(g)', moles: 0.9 },
    ],
    kinetics: { type: 'arrhenius', A: 1e13, activationEnergy: 175000 },
    kind: KIND_PYROLYSIS,
  },
  {
    /*
     * Tar cracking to soot, which is where most of a wood fire's smoke comes from. Needs no oxygen,
     * so it is what happens to tar that reaches a starved region — and `C₆H₁₀O₅ → 6 C + 5 H₂O` is
     * balanced exactly, because a cellulose repeat unit *is* six carbons and five waters.
     */
    id: SOOT_TAR,
    reactants: [{ species: 'tar', moles: 1 }],
    products: [
      { species: 'C(soot)', moles: 6 },
      { species: 'H2O(g)', moles: 5 },
    ],
    kinetics: { type: 'arrhenius', A: 1e11, activationEnergy: 200000 },
    kind: KIND_COMBUSTION,
  },
  /*
   * **The third thing tar can do, and it is what the pale smoke is.**
   *
   * The two above need heat: cracking to soot has a 200 kJ/mol barrier and burning has 125.5 plus an
   * oxygen it has to find. A smouldering surface supplies neither — there is no flame over it, the
   * gas a few centimetres away is a few hundred kelvin, and the oxygen is going into the char. So
   * the tar coming off it did nothing at all until this pair existed: it sat in the cell as an
   * invisible vapour, drifted, and vented to the far field.
   *
   * Now it cools past its dew point and becomes droplets, which is what smoke *is* in every fire
   * that is not flaming. And the competition needs no arbiter, because the three are already
   * exclusive: two rates that climb with temperature against one gate that closes with it. A flame
   * blackens its own smoke and a smoulder whitens its own, out of the same three entries.
   *
   * The reverse is here rather than left out because a one-way condensation is a sink: aerosol
   * carried back over a fire would stay pale, and a plume that greys as it cools would never darken
   * again where it is drawn back in. `EVAPORATE_TAR` is the same transition read upward, sharing the
   * dew point and the band, so the pair is an equilibrium rather than a trap.
   */
  condensation(CONDENSE_TAR, 'tar', 'tar(l)', TAR_DEW_POINT, TAR_DEW_BAND),
  phaseChange(EVAPORATE_TAR, 'tar(l)', 'tar', TAR_DEW_POINT, TAR_DEW_BAND),

  {
    id: BURN_TAR,
    reactants: [
      { species: 'tar', moles: 1 },
      { species: 'O2', moles: 6 },
    ],
    products: [
      { species: 'CO2', moles: 6 },
      { species: 'H2O(g)', moles: 5 },
    ],
    kinetics: { type: 'arrhenius', A: 5e11, activationEnergy: 125500 },
    kind: KIND_COMBUSTION,
  },
];

/** Everything a lignocellulosic solid does: dry, pyrolyse three ways, then glow. */
const WOOD_REACTIONS: readonly string[] = [
  BOIL_WATER,
  'activate-cellulose',
  'cellulose-to-tar',
  'cellulose-to-char',
  'pyrolyse-hemicellulose',
  'pyrolyse-lignin',
  'pyrolyse-extractives',
  OXIDISE_CHAR,
  OXIDISE_CHAR_RICH,
];

/**
 * The criteria a cellulosic solid catches by: 350 °C with a pilot, 500 °C without, 3.5 g/m²·s.
 *
 * Shared because they are a property of *cellulose* rather than of a shape — paper and a log have
 * the same surface chemistry and differ in how fast they reach it, which is the depth stack's job
 * and not this one's. `§11` says why the mass flux is the real criterion and why both are stored.
 */
const CELLULOSIC_IGNITION = { pilotedSurfaceK: 623, autoSurfaceK: 773, criticalMassFlux: 0.0035 };

export const ORGANIC: SubstanceLibrary = {
  id: 'organic',
  species: [ACTIVE_CELLULOSE, TAR, CONDENSED_TAR],
  reactions: REACTIONS,
  substances: (species): readonly SubstanceThermal[] => [
    {
      /* `§5`'s worked substance, and the one `§21`'s whole scene is about. */
      id: 'oak',
      composition: wetComposition(
        species,
        massFractions(species, {
          cellulose: 0.43,
          hemicellulose: 0.26,
          lignin: 0.26,
          extractives: 0.04,
          ash: 0.01,
        }),
        0.12,
      ),
      density: 700,
      conductivity: { k0: 0.16, k1: 0.0002 },
      shells: 4,
      shape: SHAPE_CYLINDER,
      porosity: 0.55,
      emissivity: 0.9,
      reactions: WOOD_REACTIONS,
      ignition: CELLULOSIC_IGNITION,
      appearance: {
        albedo: [0.32, 0.22, 0.13],
        charAlbedo: [0.03, 0.03, 0.03],
        sootYield: 0.015,
      },
    },
    {
      /* Softwood: lighter, more resinous, and it is the resin that makes it catch first. Six percent
         extractives against oak's four, cracking a hundred and fifty degrees earlier than cellulose. */
      id: 'pine',
      composition: wetComposition(
        species,
        massFractions(species, {
          cellulose: 0.41,
          hemicellulose: 0.24,
          lignin: 0.28,
          extractives: 0.06,
          ash: 0.01,
        }),
        0.12,
      ),
      density: 500,
      conductivity: { k0: 0.12, k1: 0.0002 },
      shells: 4,
      shape: SHAPE_CYLINDER,
      porosity: 0.62,
      emissivity: 0.9,
      reactions: WOOD_REACTIONS,
      ignition: CELLULOSIC_IGNITION,
      appearance: {
        albedo: [0.45, 0.33, 0.2],
        charAlbedo: [0.03, 0.03, 0.03],
        sootYield: 0.02,
      },
    },
    {
      /* Two shells, not four: a sheet is thermally thin, so its far side is its near side and the
         depth stack has nothing to resolve. That is the whole difference between paper and a log. */
      id: 'paper',
      composition: wetComposition(
        species,
        massFractions(species, {
          cellulose: 0.85,
          hemicellulose: 0.05,
          lignin: 0.02,
          ash: 0.08,
        }),
        0.06,
      ),
      density: 800,
      conductivity: { k0: 0.05, k1: 0.0001 },
      shells: 2,
      shape: SHAPE_SLAB,
      porosity: 0.35,
      emissivity: 0.92,
      reactions: WOOD_REACTIONS,
      ignition: CELLULOSIC_IGNITION,
      appearance: {
        albedo: [0.82, 0.8, 0.75],
        charAlbedo: [0.04, 0.04, 0.04],
        sootYield: 0.011,
      },
    },
    {
      /* Fabric bulk density rather than fibre density — 300 against cellulose's 1,540 — because what
         a flame meets is the cloth and not the thread. The porosity is what lets it smoulder. */
      id: 'cotton',
      composition: wetComposition(
        species,
        massFractions(species, {
          cellulose: 0.94,
          hemicellulose: 0.03,
          extractives: 0.02,
          ash: 0.01,
        }),
        0.07,
      ),
      density: 300,
      conductivity: { k0: 0.04, k1: 0.0001 },
      shells: 2,
      shape: SHAPE_SLAB,
      porosity: 0.72,
      emissivity: 0.9,
      reactions: WOOD_REACTIONS,
      ignition: CELLULOSIC_IGNITION,
      appearance: {
        albedo: [0.86, 0.85, 0.82],
        charAlbedo: [0.04, 0.04, 0.04],
        sootYield: 0.011,
      },
    },
    {
      /*
       * Collagen rather than cellulose, so it chars instead of flaming and gives up cyanide on the
       * way. Its limiting oxygen index is genuinely higher than wood's — protein is a poor fuel —
       * which is one number here and is why a leather coat is a better thing to be wearing.
       */
      id: 'leather',
      composition: wetComposition(
        species,
        massFractions(species, {
          collagen: 0.88,
          extractives: 0.08,
          ash: 0.04,
        }),
        0.14,
      ),
      density: 900,
      conductivity: { k0: 0.15, k1: 0.0002 },
      shells: 3,
      shape: SHAPE_SLAB,
      porosity: 0.3,
      emissivity: 0.93,
      reactions: [
        BOIL_WATER,
        'pyrolyse-collagen',
        'pyrolyse-extractives',
        OXIDISE_CHAR,
        OXIDISE_CHAR_RICH,
      ],
      ignition: {
        pilotedSurfaceK: 673,
        autoSurfaceK: 823,
        criticalMassFlux: 0.0045,
        limitingOxygen: 0.21,
      },
      appearance: {
        albedo: [0.2, 0.12, 0.07],
        charAlbedo: [0.03, 0.03, 0.03],
        sootYield: 0.03,
      },
    },
    {
      /* Fifteen percent ash, which is silica, and it is why straw leaves so much behind and why a
         straw fire is fast and poor. Baled density and high porosity: it breathes, so it smoulders. */
      id: 'straw',
      composition: wetComposition(
        species,
        massFractions(species, {
          cellulose: 0.36,
          hemicellulose: 0.28,
          lignin: 0.16,
          extractives: 0.05,
          ash: 0.15,
        }),
        0.1,
      ),
      density: 130,
      conductivity: { k0: 0.05, k1: 0.0001 },
      shells: 3,
      shape: SHAPE_CYLINDER,
      porosity: 0.8,
      emissivity: 0.9,
      reactions: WOOD_REACTIONS,
      ignition: CELLULOSIC_IGNITION,
      appearance: {
        albedo: [0.62, 0.52, 0.28],
        charAlbedo: [0.04, 0.04, 0.04],
        sootYield: 0.015,
      },
    },
  ],
};

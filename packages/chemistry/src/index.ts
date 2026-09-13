/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/chemistry` — thermochemistry of bulk matter.
 *
 * Game code imports from `@driftengine/chemistry` only; nothing reaches inside. This package
 * **imports no other engine package**, which is the property `@driftengine/physics` and
 * `@driftengine/entities` have and the reason all three were affordable: everything it needs from
 * the rest of the engine arrives as plain data or through a structural target.
 *
 * **CH-0 through CH-7 of Track P.** CH-0 is the ledger: the closed element set, the species registry
 * whose molar masses are derived from formulas, the species-by-element matrix, mass-fraction
 * compositions, and the reduction that turns kilograms of species into moles of elements. CH-1 is
 * the state: **enthalpy rather than temperature**, a curve per substance whose flat regions are the
 * phase changes, boiling against pressure, and a parcel store. CH-2 is the depth: nested shells of
 * equal mass and inward conduction, which is what makes a twig catch and a log not. CH-3 is the
 * network: reactions balanced against the element matrix at registration, enthalpies derived by
 * Hess's law, rates tabulated so `exp` never runs on a tick, and a substep-and-clamp solver that
 * cannot produce a negative mass. CH-4 is the air: one sparse atmosphere carrying oxygen to a fire
 * and smoke away from it, with conservative flux-form transport, buoyancy, the one wind, and a
 * connectivity that makes a sealed room genuinely sealed. CH-5 joins them: radiation with the
 * `1/r²` that makes "near the fire" mean something, convection, contact conduction, and the
 * exchange that lets a burning parcel eat the oxygen around it and push its smoke into the air.
 *
 * CH-6 retired the enthalpy curve: the latent heat was already in the formation enthalpies, so a
 * phase change is a gated reaction and its plateau emerges from the solver. Ignition became five
 * criteria rather than a flag. **CH-7 is the substances**, and they are not here: thirty-nine of
 * them across seven entry points under `library/*`, because a substance is forty numbers and a
 * composition, and a consumer who wants a campfire should not pay for polyurethane. What this
 * barrel exports of CH-7 is `installLibrary` and nothing else.
 *
 * That shape is deliberate. `elementTotals` is the assertion every later phase is checked with, and
 * it exists before there is anything to conserve through, so the day a reaction first moves matter
 * there is already a test that says whether it moved the right amount.
 *
 * The design is recorded in this package's README.
 */

export type { ElementSymbol } from './element/elements.ts';
export { ATOMIC_MASS, ELEMENTS, ELEMENT_COUNT, elementIndex } from './element/elements.ts';

export { SpeciesElementMatrix } from './element/matrix.ts';

export type { Phase, SpeciesDefinition } from './species/species.ts';
export {
  PHASE_GAS,
  PHASE_LIQUID,
  PHASE_SOLID,
  STANDARD_PRESSURE,
  STANDARD_TEMPERATURE,
} from './species/species.ts';
export { SpeciesRegistry } from './species/registry.ts';
export { STANDARD_SPECIES, registerStandardSpecies } from './species/standard.ts';

export type { Composition } from './substance/composition.ts';
export { SUM_TOLERANCE, massFractions } from './substance/composition.ts';

export type { AppearanceModel, SubstanceThermal } from './substance/substance.ts';
export { compositionElements, wetComposition } from './substance/substance.ts';

export {
  MAX_MODEL_TEMPERATURE,
  MIN_MODEL_TEMPERATURE,
  sensibleEnthalpy,
  temperatureFromCapacity,
} from './species/thermal.ts';

export { boilingPoint } from './substance/boiling.ts';
export { SubstanceRegistry } from './substance/registry.ts';

export type { Shape, ShellGeometry } from './parcel/shells.ts';
export {
  MAX_SHELLS,
  SHAPE_CYLINDER,
  SHAPE_SLAB,
  SHAPE_SPHERE,
  shellGeometry,
} from './parcel/shells.ts';

export type { ConductionModel, Conductivity } from './parcel/conduction.ts';
export { conductShells } from './parcel/conduction.ts';

export type { ParcelSpec } from './parcel/store.ts';
export { PHASE_MIXED, ParcelStore } from './parcel/store.ts';

export type { Tier } from './parcel/tier.ts';
export {
  TIER_CADENCE,
  TIER_COUNT,
  TIER_DISTANT,
  TIER_FAR,
  TIER_HERO,
  TIER_NEAR,
  TIER_SHELLS,
  TIER_SUBSTEPS,
} from './parcel/tier.ts';

export { fingerprintChemistry } from './world/fingerprint.ts';

export type {
  ArrheniusKinetics,
  CardinalKinetics,
  DiffusionKinetics,
  InstantKinetics,
  Kinetics,
  Reaction,
  ReactionKind,
  SpeciesAmount,
} from './reaction/reaction.ts';
export type { ReactionGates } from './reaction/reaction.ts';
export {
  KIND_BIOLOGICAL,
  KIND_BROWNING,
  KIND_CALCINATION,
  KIND_CHAR_OXIDATION,
  KIND_COMBUSTION,
  KIND_CORROSION,
  KIND_DENATURATION,
  KIND_DISSOLUTION,
  KIND_DRYING,
  KIND_PHASE_CHANGE,
  KIND_PYROLYSIS,
  phaseChange,
} from './reaction/reaction.ts';
export { ReactionRegistry } from './reaction/registry.ts';

export type { RateTable } from './reaction/rates.ts';
export {
  GAS_CONSTANT,
  cardinalRate,
  rateAt,
  tabulateArrhenius,
  tabulateCardinal,
} from './reaction/rates.ts';

export type { SubstanceReactions } from './reaction/solver.ts';
export { MAX_SUBSTANCE_REACTIONS, MAX_SUBSTANCE_SPECIES, reactShell } from './reaction/solver.ts';

export type { AmbientState } from './field/ambient.ts';
export {
  STANDARD_AIR,
  STANDARD_FIELD_SPECIES,
  STANDARD_PRESSURE_PA,
  ambientCellMass,
  saturationVapourPressure,
} from './field/ambient.ts';

export type { AtmosphereOptions } from './field/atmosphere.ts';
export { AtmosphereField, CHUNK_CELLS, CHUNK_SIZE } from './field/atmosphere.ts';

export { localiseReactions } from './reaction/localise.ts';

export type { OcclusionTest } from './transport/radiation.ts';
export {
  RadiativeSources,
  STEFAN_BOLTZMANN,
  convectiveCoefficient,
  radiantFlux,
  sourceRange,
} from './transport/radiation.ts';
export { ContactSet } from './transport/contacts.ts';

export type { IgnitionModel } from './ignition/criteria.ts';
export {
  BLOW_OFF_SPEED,
  DEFAULT_LIMITING_OXYGEN,
  DEFAULT_LOWER_FLAMMABLE,
  DEFAULT_SMOULDERING_OXYGEN,
  DEFAULT_UPPER_FLAMMABLE,
  surfaceFuelFraction,
  EXTINCT_BLOWN_OFF,
  EXTINCT_COOLED,
  EXTINCT_FUEL,
  EXTINCT_NONE,
  EXTINCT_OXYGEN,
  extinguishes,
  ignitionProgress,
  ignites,
  smoulders,
} from './ignition/criteria.ts';
export {
  ChemistryEvents,
  EVENT_BOILED,
  EVENT_BROWNED,
  EVENT_CALCINED,
  EVENT_CARAMELISED,
  EVENT_CHARRED,
  EVENT_CONDENSED,
  EVENT_CONSUMED,
  EVENT_CORRODED,
  EVENT_DECAYED,
  EVENT_DENATURED,
  EVENT_DISSOLVED,
  EVENT_EXPLODED,
  EVENT_EXTINGUISHED,
  EVENT_FERMENTED,
  EVENT_FROZEN,
  EVENT_IGNITED,
  EVENT_KIND_COUNT,
  EVENT_MELTED,
  EVENT_SMOULDER_END,
  EVENT_SMOULDER_START,
  EVENT_STRUCTURAL_FAIL,
  EVENT_SUBLIMED,
} from './ignition/events.ts';
export type { ChemistryWorldOptions } from './transport/world.ts';
export { ChemistryWorld } from './transport/world.ts';

export { elementTotals } from './conservation.ts';

export type { SubstanceLibrary } from './library/library.ts';
export { installLibrary } from './library/library.ts';

export { maxElementDrift } from './testing/drift.ts';

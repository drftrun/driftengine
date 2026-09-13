/**
 * `drift/chemistry` — Track P's surface, and the thirteenth `drift/*` module.
 *
 * Like every binding here, nothing in it is new engine code: a binding is a **description and a
 * lookup**. Where the surface needed a quantity `@driftengine/chemistry` did not have — a moisture
 * content on a dry basis, a heat release rate, a char depth — that function was grown in the package
 * that owns the subsystem and this describes it, per the rule in `host.ts`.
 *
 * ---
 *
 * ## Parcels are `i32`, and that is `drift/physics`'s convention followed rather than improved on
 *
 * A body is an `i32` there, a negative value means none, and a script author who has learned one
 * surface has learned this one. A second convention for the same shape of thing is the kind of
 * inconsistency nobody can defend a year later. `§20.2`.
 *
 * ## `chemistry.write` is inside the determinism boundary
 *
 * `capability.ts` wrote the rule that decides it and this track is the one entitled to apply it: a
 * parcel's composition and enthalpy are simulated quantities in exactly the sense a component's
 * fields are. They integrate on the fixed step and touch no clock. A rule that refused
 * `chemistry.write` to a `@deterministic` function would refuse the canonical operation of the
 * package.
 *
 * ## Two capabilities the design lists are **not** here, and neither is an oversight
 *
 * - **`wake`.** `§14`'s sleeping, budgets and LOD tiers were the design's CH-6 and were displaced
 *   when the build re-scoped that phase onto the temperature reading the ignition criteria had to
 *   read. Nothing sleeps, so a capability to wake it would be a no-op wearing a name — which is the
 *   rule against silent no-ops, arriving through a binding. It goes in with `§14`.
 * - **`setAmbient`.** The ambient is the far field every live chunk was filled from and every vented
 *   kilogram was booked against. Changing it mid-run would leave the field holding air drawn from an
 *   atmosphere that no longer exists and the conservation ledger measuring against a moved baseline —
 *   which would make `elementTotals`, the single most valuable assertion in the track, meaningless.
 *   A consumer who wants a different atmosphere constructs the field with one. **Reversal:**
 *   re-baselining every live chunk and re-booking the ledger, which is a feature rather than a
 *   setter.
 */
import {
  AtmosphereField,
  ChemistryWorld,
  ParcelStore,
  SpeciesRegistry,
  SubstanceRegistry,
} from '@driftengine/chemistry';
import { type ComponentType, defineComponent } from '@driftengine/entities';
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';

export const CHEMISTRY_MODULE = 'drift/chemistry';

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: CapabilityDefinition['effects'],
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: CHEMISTRY_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects,
    /* Every capability in this module is deterministic — see the header. */
    deterministic: true,
    doc,
    implementation: `${CHEMISTRY_MODULE}.${name}`,
  });

/**
 * The three opaque types `§20.2` names.
 *
 * `Chemistry` is the world as `PhysicsWorld` is one. A `Substance` and a `Species` are registrations,
 * and a script holds them to pass back rather than to read into — a field on either would be a
 * promise about a representation the engine could then never change.
 */
export const CHEMISTRY_TYPES: readonly OpaqueType[] = [
  {
    module: CHEMISTRY_MODULE,
    name: 'Chemistry',
    doc: 'A chemistry world: parcels, the air, and the tick that runs them.',
  },
  {
    module: CHEMISTRY_MODULE,
    name: 'Substance',
    doc: 'A registered material: what it is made of and what it can turn into.',
  },
  {
    module: CHEMISTRY_MODULE,
    name: 'Species',
    doc: 'A registered chemical species, such as `O2` or `cellulose`.',
  },
];

const READ = ['chemistry.read'] as const;
const WRITE = ['chemistry.write'] as const;

const P = { name: 'chem', type: 'Chemistry' };
const PARCEL = { name: 'parcel', type: 'i32' };
const XYZ = [
  { name: 'x', type: 'f32' },
  { name: 'y', type: 'f32' },
  { name: 'z', type: 'f32' },
];

export const CHEMISTRY_CAPABILITIES: readonly CapabilityDefinition[] = [
  /* Registration lookups: the two opaque handles enter a script here and nowhere else. */
  define(
    'substance',
    [P, { name: 'id', type: 'String' }],
    'Substance',
    READ,
    'A registered material by id, such as `oak`. Refuses in words naming what the world has.',
  ),
  define(
    'species',
    [P, { name: 'id', type: 'String' }],
    'Species',
    READ,
    'A registered species by id, such as `O2`. Refuses in words if the world has no such species.',
  ),

  /* The read surface, §20.3. */
  define(
    'parcelCount',
    [P],
    'i32',
    READ,
    'How many parcel handles have ever been issued, live or not.',
  ),
  define(
    'parcelAt',
    [P, { name: 'index', type: 'i32' }],
    'i32',
    READ,
    'The handle at an index, for iteration. Check `alive` before reading it.',
  ),
  define('alive', [P, PARCEL], 'bool', READ, 'Whether a parcel still exists.'),
  define('substanceOf', [P, PARCEL], 'Substance', READ, 'What material a parcel is made of.'),
  define('temperature', [P, PARCEL], 'f32', READ, 'K, averaged over the whole parcel.'),
  define(
    'surfaceTemperature',
    [P, PARCEL],
    'f32',
    READ,
    'K at the outermost shell — the one that decides whether it catches.',
  ),
  define(
    'coreTemperature',
    [P, PARCEL],
    'f32',
    READ,
    'K at the innermost shell — the one that decides whether it is cooked.',
  ),
  define(
    'mass',
    [P, PARCEL],
    'f32',
    READ,
    'How much of it there is, in kilograms. Falls as it burns.',
  ),
  define(
    'speciesMass',
    [P, PARCEL, { name: 'species', type: 'Species' }],
    'f32',
    READ,
    'kg of one species held anywhere in this parcel.',
  ),
  define(
    'moisture',
    [P, PARCEL],
    'f32',
    READ,
    'kg of water per kg of dry matter — the dry basis, which is how moisture content is quoted. Under 0.25 will burn; over 0.35 will not.',
  ),
  define(
    'charFraction',
    [P, PARCEL],
    'f32',
    READ,
    'Share of the parcel that is now carbon, 0 to 1.',
  ),
  define('charDepth', [P, PARCEL], 'f32', READ, 'Metres of char measured inward from the surface.'),
  define(
    'wetness',
    [P, PARCEL],
    'f32',
    READ,
    'kg of liquid water on the surface, per square metre of it.',
  ),
  define(
    'phase',
    [P, PARCEL],
    'i32',
    READ,
    '0 solid, 1 liquid, 2 gas, 3 mixed. Mixed is a real answer: wet wood is a solid and a liquid at once.',
  ),
  define('burning', [P, PARCEL], 'bool', READ, 'Whether a flame stands over it.'),
  define(
    'smouldering',
    [P, PARCEL],
    'bool',
    READ,
    'Whether it is glowing with no flame. A smoulder survives air a flame cannot, which is why smothering leaves embers.',
  ),
  define(
    'heatRelease',
    [P, PARCEL],
    'f32',
    READ,
    "kW the reactions released last tick. A fire's size is its heat release rate, not its temperature. Negative while a surface is gasifying, which is correct.",
  ),
  define(
    'ignitionProgress',
    [P, PARCEL],
    'f32',
    READ,
    'How close to catching, 0 to 1: the least satisfied of the five criteria. A readout — nothing branches on it.',
  ),
  define(
    'structuralIntegrity',
    [P, PARCEL],
    'f32',
    READ,
    'How much is still load-bearing, 1 down to 0, as char eats the thickness. This package breaks nothing; it reports.',
  ),
  define('massFlux', [P, PARCEL], 'f32', READ, 'kg/(m²·s) of gas leaving the surface — the smoke.'),
  define(
    'fuelFlux',
    [P, PARCEL],
    'f32',
    READ,
    'The combustible share of that, which is what ignition is measured against.',
  ),
  define('positionX', [P, PARCEL], 'f32', READ, 'Where the consumer said this parcel is.'),
  define('positionY', [P, PARCEL], 'f32', READ, 'Where the consumer said this parcel is.'),
  define('positionZ', [P, PARCEL], 'f32', READ, 'Where the consumer said this parcel is.'),

  /* The air, sampled at a point. */
  define('ambientTemperature', [P, ...XYZ], 'f32', READ, 'K of the air at a point.'),
  define(
    'oxygenFraction',
    [P, ...XYZ],
    'f32',
    READ,
    'Volume fraction of oxygen. Air is 0.209; a flame stops near 0.14 and a smoulder near 0.05.',
  ),
  define(
    'humidity',
    [P, ...XYZ],
    'f32',
    READ,
    'Relative humidity, 0 to 1. Nothing dries in fog because the vapour pressure deficit is zero.',
  ),
  define(
    'pressure',
    [P, ...XYZ],
    'f32',
    READ,
    'Pascals. Rises where the air is heated and confined, which is what an explosion event reports on.',
  ),
  define(
    'concentration',
    [P, { name: 'species', type: 'Species' }, ...XYZ],
    'f32',
    READ,
    'Parts per million by volume. The reading a game acts on — carbon monoxide is the one that kills.',
  ),
  define(
    'smokeDensity',
    [P, ...XYZ],
    'f32',
    READ,
    'Extinction coefficient, 1/m: what to attenuate a light along a ray by.',
  ),
  define(
    'visibility',
    [P, ...XYZ],
    'f32',
    READ,
    'How far you can see, metres. Clamped at ten kilometres.',
  ),

  /* The write surface, §20.4. */
  /*
   * **`place`, not `spawn`, and `release`, not `emit`.** `§20.4` named both after words this
   * language already reserves as statement heads — `spawn` starts a task and `emit` starts an event
   * — so `chemistry.spawn(…)` does not parse at all. Renaming the capability is the narrow fix;
   * making either a soft keyword would loosen the grammar everywhere for two names. The store's own
   * method is still `spawn`, because TypeScript has no such collision.
   */
  define(
    'place',
    [
      P,
      { name: 'substance', type: 'Substance' },
      { name: 'kilograms', type: 'f32' },
      { name: 'area', type: 'f32' },
      ...XYZ,
    ],
    'i32',
    WRITE,
    'Put a new parcel in the world. `area` is the exposed surface in m², and it is required rather than defaulted: a characteristic depth is volume over area, so a parcel with no area has no depth.',
  ),
  define('destroy', [P, PARCEL], 'void', WRITE, 'Remove a parcel. Its handle is never reused.'),
  define(
    'move',
    [P, PARCEL, ...XYZ],
    'void',
    WRITE,
    'Where it is. The consumer owns position; this package only reads it to work out what reaches it.',
  ),
  define(
    'addHeat',
    [P, PARCEL, { name: 'joules', type: 'f32' }],
    'void',
    WRITE,
    'Joules into the surface shell, which is what a flux from outside does.',
  ),
  define(
    'addHeatDeep',
    [P, PARCEL, { name: 'shell', type: 'i32' }, { name: 'joules', type: 'f32' }],
    'void',
    WRITE,
    'Joules into a named shell. The difference from `addHeat` is a microwave and an oven.',
  ),
  define(
    'setTemperature',
    [P, PARCEL, { name: 'kelvin', type: 'f32' }],
    'void',
    WRITE,
    'Set every shell to a temperature. **For authoring and tests, not for a tick** — it discards whatever enthalpy was there rather than accounting for it.',
  ),
  define(
    'wet',
    [P, PARCEL, { name: 'kilograms', type: 'f32' }],
    'void',
    WRITE,
    'Pour water on it: real liquid water into the surface shell, where boiling will find it. Refuses, naming the material, where that material holds no water.',
  ),
  define(
    'dry',
    [P, PARCEL, { name: 'kilograms', type: 'f32' }],
    'void',
    WRITE,
    'Take surface water away: a cloth, a hot dry pan, or wind.',
  ),
  define(
    'ignite',
    [P, PARCEL],
    'void',
    WRITE,
    'Supply a pilot for one tick. **This does not start a fire** — it satisfies one of five criteria, so holding a match to wet wood does nothing.',
  ),
  define(
    'douse',
    [P, PARCEL],
    'void',
    WRITE,
    'Remove the pilot and the flame. Embers survive, which is the point of it.',
  ),
  define(
    'addSpecies',
    [P, PARCEL, { name: 'species', type: 'Species' }, { name: 'kilograms', type: 'f32' }],
    'void',
    WRITE,
    'Salt the water, oil the pan, poison the well.',
  ),
  define(
    'mix',
    [P, { name: 'from', type: 'i32' }, { name: 'into', type: 'i32' }],
    'void',
    WRITE,
    'Pour one parcel into another; the first is consumed. Both must be the same material — a mixture of two is a third material, authored as one.',
  ),
  define(
    'release',
    [P, { name: 'species', type: 'Species' }, { name: 'kilograms', type: 'f32' }, ...XYZ],
    'void',
    WRITE,
    'A gas release into the air: a leak, a vent, an extinguisher.',
  ),
  define(
    'addAirHeat',
    [P, { name: 'joules', type: 'f32' }, ...XYZ],
    'void',
    WRITE,
    'Joules into a cell of air, which is what a heater does and what a fire does to the room.',
  ),

  /* The event buffer, §20.5, in the shape `drift/physics`'s contact buffer established. */
  define('eventCount', [P], 'i32', READ, 'Events this tick. Cleared at the top of every one.'),
  define(
    'eventKind',
    [P, { name: 'index', type: 'i32' }],
    'i32',
    READ,
    '0 ignited, 1 extinguished, 2 smoulderStart, 3 smoulderEnd, 4 consumed, 5 charred, 6 structuralFail, 7 frozen, 8 melted, 9 boiled, 10 condensed, 11 sublimed, 12 corroded, 13 calcined, 14 dissolved, 15 denatured, 16 browned, 17 caramelised, 18 fermented, 19 decayed, 20 exploded.',
  ),
  define(
    'eventParcel',
    [P, { name: 'index', type: 'i32' }],
    'i32',
    READ,
    'Which parcel it happened to.',
  ),
  define(
    'eventSpecies',
    [P, { name: 'index', type: 'i32' }],
    'i32',
    READ,
    'Which species, or -1 where the kind does not name one.',
  ),
  define(
    'eventValue',
    [P, { name: 'index', type: 'i32' }],
    'f32',
    READ,
    "The kind's own quantity.",
  ),
];

/**
 * A parcel handle on an entity, and `§19` says why it is declared here.
 *
 * Track M's design is explicit that `@driftengine/entities` declares **no components** — it is the
 * model, not a library of them. And `@driftengine/chemistry` imports no engine package at all, so it
 * cannot declare one either. This binding layer is the one place that already depends on core,
 * entities and now chemistry at once, which makes it the only honest home.
 *
 * `standoff` is not a chemistry quantity and is here because it is the one a consumer always ends up
 * adding: how far this was placed from the fire, which is what `1/r²` is measured over.
 */
export const CHEMISTRY_COMPONENT: ComponentType = defineComponent('Chemistry', {
  parcel: 'i32',
  standoff: 'f32',
});

/** What a consumer supplies to make `drift/chemistry` reachable. */
export interface ChemistryServices {
  readonly world: ChemistryWorld;
  readonly parcels: ParcelStore;
  readonly air: AtmosphereField;
  readonly substances: SubstanceRegistry;
  readonly species: SpeciesRegistry;
}

export function chemistryImplementation(services: ChemistryServices): Record<string, unknown> {
  const { world, parcels, air, substances, species } = services;

  /**
   * Resolve an id, or refuse naming what the world has.
   *
   * **Not `-1` and not a no-op**, for the reason `drift/ecs` gives about a component name: a script
   * that misspells `oak` would otherwise spawn nothing and read zeroes, which is a behaviour that
   * runs, reports success and is wrong.
   */
  const substanceOf = (id: string): number => {
    const index = substances.indexOf(id);
    if (index >= 0) return index;
    throw new Error(
      `no substance is registered as \`${id}\`. Install the library that carries it — ` +
        '`@driftengine/chemistry/library/organic` has `oak`, `pine`, `paper`, `cotton`, `leather` ' +
        'and `straw` — or define one.',
    );
  };
  const speciesOf = (id: string): number => {
    const index = species.indexOf(id);
    if (index >= 0) return index;
    throw new Error(`no species is registered as \`${id}\`. The standard table has sixty-eight.`);
  };

  return {
    substance: (_: unknown, id: string) => substanceOf(id),
    species: (_: unknown, id: string) => speciesOf(id),

    parcelCount: () => parcels.count,
    parcelAt: (_: unknown, index: number) => index,
    alive: (_: unknown, parcel: number) => parcels.alive(parcel),
    substanceOf: (_: unknown, parcel: number) => parcels.substanceOf(parcel),
    temperature: (_: unknown, parcel: number) => parcels.temperatureOf(parcel),
    surfaceTemperature: (_: unknown, parcel: number) => parcels.surfaceTemperatureOf(parcel),
    coreTemperature: (_: unknown, parcel: number) => parcels.coreTemperatureOf(parcel),
    mass: (_: unknown, parcel: number) => parcels.massOf(parcel),
    speciesMass: (_: unknown, parcel: number, s: number) => parcels.parcelSpeciesMass(parcel, s),
    moisture: (_: unknown, parcel: number) => parcels.moistureOf(parcel),
    charFraction: (_: unknown, parcel: number) => parcels.charFractionOf(parcel),
    charDepth: (_: unknown, parcel: number) => parcels.charDepthOf(parcel),
    wetness: (_: unknown, parcel: number) => parcels.wetnessOf(parcel),
    phase: (_: unknown, parcel: number) => parcels.parcelPhaseOf(parcel),
    burning: (_: unknown, parcel: number) => parcels.burning(parcel),
    smouldering: (_: unknown, parcel: number) => parcels.smouldering(parcel),
    /* Watts inside, kilowatts out: a fire is quoted in kW everywhere a person reads one. */
    heatRelease: (_: unknown, parcel: number) => parcels.heatReleaseOf(parcel) / 1000,
    ignitionProgress: (_: unknown, parcel: number) => world.ignitionProgressOf(parcel),
    structuralIntegrity: (_: unknown, parcel: number) => parcels.structuralIntegrityOf(parcel),
    massFlux: (_: unknown, parcel: number) => parcels.massFluxOf(parcel),
    fuelFlux: (_: unknown, parcel: number) => parcels.fuelFluxOf(parcel),
    positionX: (_: unknown, parcel: number) => parcels.positionX(parcel),
    positionY: (_: unknown, parcel: number) => parcels.positionY(parcel),
    positionZ: (_: unknown, parcel: number) => parcels.positionZ(parcel),

    ambientTemperature: (_: unknown, x: number, y: number, z: number) => air.temperatureAt(x, y, z),
    oxygenFraction: (_: unknown, x: number, y: number, z: number) => air.oxygenFractionAt(x, y, z),
    humidity: (_: unknown, x: number, y: number, z: number) => air.humidityAt(x, y, z),
    pressure: (_: unknown, x: number, y: number, z: number) => air.pressureAt(x, y, z),
    concentration: (_: unknown, s: number, x: number, y: number, z: number) =>
      air.concentrationAt(x, y, z, s),
    smokeDensity: (_: unknown, x: number, y: number, z: number) => air.smokeDensityAt(x, y, z),
    visibility: (_: unknown, x: number, y: number, z: number) => air.visibilityAt(x, y, z),

    place: (
      _: unknown,
      substance: number,
      kilograms: number,
      area: number,
      x: number,
      y: number,
      z: number,
    ) => parcels.spawn({ substance, mass: kilograms, temperature: 293.15, area, x, y, z }),
    destroy: (_: unknown, parcel: number) => parcels.destroy(parcel),
    move: (_: unknown, parcel: number, x: number, y: number, z: number) =>
      parcels.move(parcel, x, y, z),
    addHeat: (_: unknown, parcel: number, joules: number) => parcels.addSurfaceHeat(parcel, joules),
    addHeatDeep: (_: unknown, parcel: number, shell: number, joules: number) =>
      parcels.addShellHeat(parcel, shell, joules),
    setTemperature: (_: unknown, parcel: number, kelvin: number) =>
      parcels.setTemperature(parcel, kelvin),
    wet: (_: unknown, parcel: number, kilograms: number) => parcels.wet(parcel, kilograms),
    dry: (_: unknown, parcel: number, kilograms: number) => parcels.dry(parcel, kilograms),
    ignite: (_: unknown, parcel: number) => parcels.ignite(parcel),
    douse: (_: unknown, parcel: number) => parcels.douse(parcel),
    addSpecies: (_: unknown, parcel: number, s: number, kilograms: number) =>
      parcels.addSpeciesMass(parcel, 0, s, kilograms),
    mix: (_: unknown, from: number, into: number) => parcels.mix(from, into),
    release: (_: unknown, s: number, kilograms: number, x: number, y: number, z: number) =>
      air.addSpecies(x, y, z, s, kilograms),
    addAirHeat: (_: unknown, joules: number, x: number, y: number, z: number) =>
      air.addHeat(x, y, z, joules),

    eventCount: () => world.events.count,
    eventKind: (_: unknown, index: number) => world.events.kindOf(index),
    eventParcel: (_: unknown, index: number) => world.events.parcelOf(index),
    eventSpecies: (_: unknown, index: number) => world.events.speciesOf(index),
    eventValue: (_: unknown, index: number) => world.events.valueOf(index),
  };
}

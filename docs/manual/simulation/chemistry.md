---
title: Chemistry
description: Matter as parcels of real substances, whose heat, phase changes, burning and smoke follow from conserved energy, steered from DriftScript.
packages: ['@driftengine/chemistry', '@driftengine/script']
covers: ['Chemistry']
areas: ['chemistry']
---

# Chemistry

`@driftengine/chemistry` models bulk matter: what a thing is made of, what temperature it is, and
what it turns into. A parcel of matter holds a mass and an enthalpy, and its temperature is worked
out from what it is made of at that moment. Melting, boiling and burning are reactions that balance
element by element, so a kettle sits at a hundred degrees while it boils, a green log will not catch
at a fire that lights a dry one, and nobody wrote either rule down. It is 18.1 KB gzipped and
imports no other engine package.

The example is a campfire: oak and kindling beside a bed of embers, a kettle, a block of ice, an
iron nail and a copper coin, each heating at the rate its own substance decides. The camp is a
DriftScript module: the rain, a keeper who lays a new log on, seasoned or green, and a notebook of
what happened. Lay a green log and watch it steam instead of catching; let it rain and everything
that can hold water stops at the boiling point; let the wind blow. The fire runs fifteen times
faster than the clock.

<!-- run: chemistry -->

## Installing it

```ts sample=chemistry/main.ts#install
/** Three families of substance, and a world with air over it: one metre cells, 8³ to a chunk. */
const chem = installChemistry({ libraries: [ORGANIC, FOOD, METAL], maxChunks: 8 });
/** The fire's own fixed step: a quarter second of chemistry each tick of the page. */
const DT = 0.25;
/** The hearth sits at (4, 4, 4) in the air's cells, and the scene is drawn in those same metres. */
const HEARTH: Vec3 = [4, 4, 4];
```

`installChemistry(options)` builds a world from the families of substance a game uses, and wires
the rest: the species, the reactions between them, the substances, the parcels, the air over them,
and the world that steps them all. The families are entry points of their own, so a game that wants
a campfire pays for a campfire:

- `library/organic`: oak, pine, paper, cotton, leather and straw.
- `library/food`: water, ice, butter, beef muscle, potato, egg white and sugar.
- `library/fuel`: ethanol, petrol, diesel, kerosene and paraffin wax.
- `library/polymer`, `library/mineral`, `library/metal` and `library/biological`.

Each costs between 625 bytes and 1.3 KB. `cellSize` is the air's cell in metres, one by default,
`maxChunks` how many 8³ chunks of air may be live at once, and `ambient` the air's starting state.
`match(names)` resolves material names to substances exactly, with no synonyms, and returns the
names that matched nothing, so a model's `pine_bark_02` is a decision for you and not a guess.
Positions are in the air's cells, which at the default size are metres.

## Parcels

```ts sample=chemistry/main.ts#things
/** What is on the hearth: a substance, where it sits, and the box it fills. */
interface Thing {
  readonly label: string;
  readonly at: Vec3;
  readonly size: Vec3;
  parcel: number;
  meshes: MeshHandle[];
}
function spawn(label: string, substance: string, at: Vec3, size: Vec3): Thing {
  const index = chem.substances.indexOf(substance);
  const bounds = parcelFromBounds(size[0], size[1], size[2], chem.substances.densityOf(index));
  const parcel = chem.parcels.spawn({
    substance: index,
    mass: bounds.mass,
    temperature: 288.15,
    area: bounds.area,
    x: at[0],
    y: at[1],
    z: at[2],
  });
  return { label, at, size, parcel, meshes: charSteps(parcel, size) };
}
```

`parcels.spawn({ substance, mass, temperature, area, x, y, z })` puts a parcel in the world, and
`parcelFromBounds(width, height, depth, density)` gives the mass and surface area of a box of it. A
parcel has depth: nested shells of equal mass, so heat enters the surface and conducts inward, a
thin piece heats through and a thick one does not. An 80 mm log's core stays at room temperature
while its surface chars.

Reading one: `temperatureOf`, `surfaceTemperatureOf` and `coreTemperatureOf`, in kelvin;
`massOf`, `charFractionOf`, `wetnessOf` and `wettable`; `burning` and `smouldering`; and
`heatReleaseOf`, in watts, negative while it is drying or charring and taking heat in. Changing one:
`addHeat`, `wet` and `dry`, `ignite`, which offers a flame, and `douse`.

## A tick

```ts sample=chemistry/main.ts#tick
/* The embers radiate; every parcel is offered a flame, which is one of the five conditions. */
chem.world.sources.clear();
chem.world.sources.add(hx, hy + 0.05, hz, 1150, 0.2, 90000);
chem.world.contacts.clear();
for (const thing of things) chem.parcels.ignite(thing.parcel);
exported<Weather>(camp, 'weather')(notes, chem, DT);
chem.world.simulate(DT, wind, 0);
/* The events are cleared at the top of the next step, so they are read now. */
exported<Notice>(camp, 'notice')(notes, chem, named('kettle').parcel, named('ice').parcel);
```

`world.sources` holds what radiates, cleared and filled each tick: a position, a temperature, an
area and a power. Every parcel works out what reaches it, so a log twice as far from the fire takes
four times as long. `world.contacts` holds what touches what. `world.simulate(dt, windX, windZ)`
steps it all: conduction through the shells, the reactions, the air's transport, and the parcels
drawing oxygen from the cell they sit in and pushing what they make back into it.

Ignition is five conditions: a surface hot enough, enough fuel coming off it, oxygen above the
limiting fraction, a mixture at the surface inside its flammability limits, and a pilot flame, which
is what `ignite` offers and which lowers the temperature needed. A wet log's steam thins the mixture
below its limit, so it does not catch however long a match is held to it. Going out is four: fuel
gone, too little oxygen, the surface cooled, or the flame blown off, and a smoulder survives air a
flame cannot.

What happened is an event buffer, drained each tick and cleared at the start of the next. Twenty-one
kinds are named; four are raised today, a parcel igniting, going out, and starting and stopping a
smoulder. The camp watches the kettle and the ice by their temperature and their phase.

## The camp, in DriftScript

```drs sample=chemistry/camp.drs#weather
// Rain wets everything that can hold water, a little each tick; a nail or a coin stays dry.
fn weather(camp: Camp, chem: Chemistry, dt: f32) {
    if camp.rain <= 0 {
        return
    }
    var parcel: i32 = 0
    while parcel < chemistry.parcelCount(chem) {
        if chemistry.alive(chem, parcel) && chemistry.wettable(chem, parcel) {
            chemistry.wet(chem, parcel, camp.rain * dt)
        }
        parcel += 1
    }
}
```

```drs sample=chemistry/camp.drs#stoke
// A log of oak laid on the fire and offered a flame: seasoned, or green, which is the same wood
// with water poured on. Whether it catches is the chemistry's answer.
fn stoke(chem: Chemistry, green: bool, x: f32, y: f32, z: f32) -> i32 {
    let oak = chemistry.substance(chem, "oak")
    let log = chemistry.place(chem, oak, 2.5, 0.16, x, y, z)
    if green {
        chemistry.wet(chem, log, 0.9)
    }
    chemistry.ignite(chem, log)
    return log
}
```

```drs sample=chemistry/camp.drs#notice
// What happened this tick: catching and going out from the chemistry's event buffer, read before
// it is cleared, and the kettle and the ice by watching them.
fn notice(camp: mut Camp, chem: Chemistry, kettle: i32, ice: i32) {
    var at: i32 = 0
    while at < chemistry.eventCount(chem) {
        let kind = chemistry.eventKind(chem, at)
        if kind == IGNITED {
            camp.caught += 1
            camp.lastCaught = chemistry.eventParcel(chem, at)
        }
        if kind == EXTINGUISHED {
            camp.putOut += 1
        }
        at += 1
    }
    if chemistry.surfaceTemperature(chem, kettle) >= 99.5degC {
        camp.boiled = true
    }
    if chemistry.phase(chem, ice) != SOLID {
        camp.melting = true
    }
}
```

```ts sample=chemistry/main.ts#script
/** The camp, hosted with the chemistry it reads and writes. */
const camp = hostScript(campScript, { chemistry: chem });
interface Camp {
  rain: number;
  caught: number;
  putOut: number;
  boiled: boolean;
  melting: boolean;
  lastCaught: number;
}
const notes = exported<() => Camp>(camp, 'createCamp')();
type Weather = (camp: Camp, chem: unknown, dt: number) => void;
type Stoke = (chem: unknown, green: boolean, x: number, y: number, z: number) => number;
type Notice = (camp: Camp, chem: unknown, kettle: number, ice: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./camp.drs', (next) => {
    if (next !== undefined) patchModule(camp, next as Record<string, unknown>, { Camp: [notes] });
  });
}
```

`drift/chemistry` is handed the world it reads and writes, and every call takes it as its first
argument. A module has:

- `substance` and `species`, by id, refusing one that is not installed and saying where to find it.
- Reading a parcel: `parcelCount`, `alive`, `temperature`, `surfaceTemperature` and
  `coreTemperature`, `mass`, `moisture`, `wetness` and `wettable`, `charFraction`, `phase`,
  `burning` and `smouldering`, `heatRelease` in kilowatts, `ignitionProgress` and more.
- Reading the air at a point: `ambientTemperature`, `oxygenFraction`, `humidity`, `pressure`,
  `concentration`, `smokeDensity` and `visibility`.
- Changing things: `place`, `destroy` and `move`, `addHeat`, `setTemperature`, `wet` and `dry`,
  `ignite` and `douse`, `addSpecies`, `mix`, and `release` and `addAirHeat` into the air.
- The events: `eventCount`, and `eventKind`, `eventParcel`, `eventSpecies` and `eventValue` by
  index.

A write is inside the determinism boundary: a parcel's enthalpy is simulated state integrated on the
fixed step, so a `@deterministic` function may change chemistry. Temperatures may be written in
`degC` as a threshold, `>= 99.5degC`, and the compiler refuses one used as a difference, which would
be 273.15 kelvin out.

## Drawing it

```ts sample=chemistry/main.ts#surface
/* Every reading a picture needs: char colour, Planck glow, wetness, and what is left of it. */
writeSurface(
  chem.parcels,
  things.map((thing) => thing.parcel),
  surface,
);
emitSmoke(chem.air, hx - 4, hy, hz - 4, 8, smoke, {
  threshold: 2e-6,
  size: 0.3,
  wind: wind * 0.3,
});
/* The air's cells are a metre across, so a puff in the cell the camera is in fills the view. */
for (let i = 0; i < smoke.count; i += 1) {
  const dx = (smoke.positions[i * 3] ?? 0) - camera.position[0];
  const dy = (smoke.positions[i * 3 + 1] ?? 0) - camera.position[1];
  const dz = (smoke.positions[i * 3 + 2] ?? 0) - camera.position[2];
  if (dx * dx + dy * dy + dz * dz < 1.5) smoke.alphas[i] = 0;
}
```

`@driftengine/chemistry/present` turns readings into pictures, and every mapping is a physical
quantity. `writeSurface(parcels, handles, out)` writes each parcel's colour, darkening toward its
own char colour as it chars, its glow, from Planck at its surface temperature, its roughness, from
the water on it, and its scale, from what is left of it. `emitSmoke(air, x, y, z, cells, out,
options)` writes a particle for every cell of air holding smoke, coloured by the ratio of soot,
nearly black, to droplets, nearly white: a flame smokes dark and a smoulder or a wet log smokes pale,
with nothing choosing. `flameHeight(kilowatts, diameter)` is the height of a flame, and
`crackleRate`, `hissRate` and `roarLevel` are levels for sound. The targets are described by shape
only, so core's particles take the smoke directly and neither package imports the other.

The example draws each thing from meshes built emissive and white, `setEmissiveColor([1, 1, 1])`, and
binds a white emissive map one texel wide whose `emissiveScale` is the glow `writeSurface` gave it:
a [material](../rendering/materials.md)'s map modulates a mesh's own emission, so the colour comes
from the chemistry, and a thing too cold to glow is drawn with a scale of zero. Emissive in this
engine is also gated on the environment's `nightFactor`, so embers that glow at dusk look dead at
noon; the example sets it to one.

## Without a scene

```ts sample=snippets/chemistry.ts#elements
/** Seasoned oak, dry basis, as mass fractions that must sum to one. */
const species = new SpeciesRegistry();
registerStandardSpecies(species);
const oak = massFractions(species, {
  cellulose: 0.43,
  hemicellulose: 0.26,
  lignin: 0.26,
  extractives: 0.04,
  ash: 0.01,
});

/** Ten kilograms of it, reduced to moles of each of the fifteen elements. */
export function carbonInTenKilograms(): number {
  const mass = new Float64Array(species.count);
  oak.species.forEach((s, i) => {
    mass[s] = (oak.fraction[i] ?? 0) * 10;
  });
  const elements = new Float64Array(ELEMENT_COUNT);
  elementTotals(species, mass, elements);
  return elements[ELEMENTS.indexOf('C')] ?? 0;
}
```

```ts sample=snippets/chemistry.ts#plateau
/**
 * A litre of water on a kilowatt, in a world with no air: the registries and the parcels wired by
 * hand, which is the part of `installChemistry` that comes before the atmosphere.
 */
const reactions = new ReactionRegistry(species);
const substances = new SubstanceRegistry(species, reactions);
installLibrary(FOOD, species, reactions, substances);
const parcels = new ParcelStore(substances);
const kitchen = new ChemistryWorld(parcels, null);
const water = parcels.spawn({
  substance: substances.indexOf('water'),
  mass: 1,
  temperature: 293.15,
  area: 0.05,
});

/** It climbs to boiling, then stays at a hundred while the kilowatt goes into boiling it away. */
export function heatFor(seconds: number): number {
  for (let t = 0; t < seconds; t += 1) {
    parcels.addHeat(water, 1000);
    kitchen.simulate(1);
  }
  return parcels.temperatureOf(water) - 273.15;
}
```

```ts sample=snippets/chemistry.ts#fingerprint
/**
 * Sixteen hex digits over every parcel, and the air where there is one: two runs that agree print
 * the same.
 */
export function fingerprint(): string {
  return fingerprintChemistry(kitchen);
}
```

The pieces underneath are usable on their own. `massFractions(species, fractions)` is a material
that must sum to one, and `elementTotals` reduces kilograms of species to moles of each of the
fifteen elements, which is the ledger every reaction is checked against. A `ChemistryWorld` with no
air steps parcels alone, in microseconds; the air is most of what a step costs.
`fingerprintChemistry(world)` is sixteen hexadecimal digits over every parcel's composition and
enthalpy and the air, for checking that two runs agree.

## What it costs

A parcel whose surface and reactions have been still for thirty ticks sleeps and is not stepped,
and wakes on heat, water, a contact, or a fire coming near, so a pile of cold stones costs nothing.
A parcel far from the camera can be stepped coarser with `setTier`, from `TIER_HERO` through
`TIER_NEAR` and `TIER_FAR` to `TIER_DISTANT`, one shell every sixteenth tick. Every tier conserves
mass, elements and energy exactly, so a parcel may change tier mid-burn; what a coarse tier gives up
is accuracy, and a lumped parcel chars more, having no cold core to hide behind.

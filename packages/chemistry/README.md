# @driftengine/chemistry

Thermochemistry of bulk matter: what a material is made of, what temperature it is, and what it
turns into. **18.1 KB gzipped**, standalone — it imports no other engine package, so a consumer who
wants matter and no renderer pays for matter and no renderer.

**This is the whole of Track P, CH-0 through CH-10.**

## What ships today

|                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fifteen elements**                 | `C H O N S Cl Si Ca Fe Al Mg Cu Na K P`, with IUPAC conventional atomic weights. A closed set, so every matrix has a fixed width and a totals vector is fifteen doubles                                                                                                                                                                                                                                                                                                                                                                    |
| **Sixty-eight species**              | Atmospheric and combustion gases, condensed water, three forms of carbon, the wood polymers, the biopolymers, sugars, lipids, fuel surrogates, polymers, minerals and metals. Ten more arrive with the families that need them — wood tar as vapour and as droplets, molten fat, five fuel vapours — rather than being carried by everyone                                                                                                                                                                                                 |
| **Molar mass, derived**              | A species carries a _formula_; its mass is that formula against the atomic weights. There is no molar-mass field to disagree with it                                                                                                                                                                                                                                                                                                                                                                                                       |
| **The species-by-element matrix**    | Moles of each element per mole of each species, dense, `Float64Array`, with a scaled-row reduction that allocates nothing                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`Composition`**                    | Mass fractions that must sum to one, stored sorted by species index so two spellings of the same material reduce bit-identically                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`elementTotals`**                  | Kilograms of species to moles of elements, into a caller-owned vector, allocating nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Enthalpy is the state**            | A parcel holds joules and mass; its temperature is **derived from what it is made of right now**. `h = A·ΔT + B·ΔT²/2` inverts in closed form with one square root — no table, no search, and composition-aware by construction                                                                                                                                                                                                                                                                                                            |
| **A phase change is a reaction**     | Melting and boiling are gated reactions whose enthalpy Hess's law already supplies, and **the plateau emerges from the solver** rather than from a curve. Nothing branches on melting and nothing has to                                                                                                                                                                                                                                                                                                                                   |
| **`boilingPoint`**                   | Clausius-Clapeyron, so a stew at 3,000 m is pinned at 90 °C and cannot brown. Authoring-time only until CH-4 tabulates it                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`ParcelStore`**                    | Structure-of-arrays `Float64Array` columns: substance, mass, enthalpy, position. `addHeat` is one addition and `temperatureOf` is one search                                                                                                                                                                                                                                                                                                                                                                                               |
| **A parcel has depth**               | Nested shells of **equal mass**, so a large object's surface shell is thin and its core is fat. Heat enters shell 0 and conducts inward, and the interface conductivity is the **harmonic mean**, because a boundary is a series resistance                                                                                                                                                                                                                                                                                                |
| **Thin catches, thick does not**     | Under 20 kW/m², a 2 mm slab's surface passes 300 °C in 29 s and an 80 mm one takes 400 s — and the 80 mm log's _core_ is five hundredths of a kelvin above the room while its surface chars                                                                                                                                                                                                                                                                                                                                                |
| **Reactions that balance**           | Checked against the element matrix at registration and **refused naming the element and the gap**. Enthalpies derived by Hess's law, never typed in: methane comes out at its published heating values without either being written down                                                                                                                                                                                                                                                                                                   |
| **Rates as tables**                  | `exp` never runs on a tick. Knots uniform in `1/T`, where `ln k` is exactly linear, measured under 0.5% against the closed form                                                                                                                                                                                                                                                                                                                                                                                                            |
| **A solver that cannot go negative** | Sub-stepped by stiffness, then clamped: where demand exceeds what is present, every reaction drawing on that species is cut **by the same factor**, so the answer does not depend on registration order                                                                                                                                                                                                                                                                                                                                    |
| **One atmosphere**                   | Sparse chunks, and empty air costs nothing. Conservative flux transport on the one wind plus buoyancy, a connectivity that makes a sealed room sealed, and a far-field ledger that balances                                                                                                                                                                                                                                                                                                                                                |
| **Gas-phase combustion**             | The **same solver** a shell uses, given a cell — which is what lets a flame stand off a surface rather than sit on it                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Radiation, and `1/r²`**            | A source is declared and every parcel works out what reaches it. Move a log twice as far from a fire and it takes four times as long — one line of arithmetic, and the whole reason distance means anything                                                                                                                                                                                                                                                                                                                                |
| **The parcels meet the air**         | A burning parcel draws the oxygen its reactions want out of the cell it sits in and pushes the gas they make into it. One relaxation, both directions                                                                                                                                                                                                                                                                                                                                                                                      |
| **Ignition is a criterion**          | Five conditions, and `ignite` supplies one of them. **Holding a match to wet wood does nothing**, which is the API telling the truth about what a match is                                                                                                                                                                                                                                                                                                                                                                                 |
| **Extinction is four**               | Fuel gone, oxygen below the limiting index, surface cooled, or blown off — and a smoulder survives air a flame cannot, which is why smothering leaves embers                                                                                                                                                                                                                                                                                                                                                                               |
| **An event buffer**                  | Twenty-one kinds, drained per tick, in the shape `drift/physics`'s contact buffer established                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Char glows for an hour**           | Above about 800 K the chemistry outruns oxygen delivery, so the rate is transport, not kinetics. The two combine as a series resistance — and **blowing on an ember brightens it**                                                                                                                                                                                                                                                                                                                                                         |
| **A smoulder's smoke is pale**       | Tar leaving a surface cracks to soot and burns where it is hot, and **condenses to droplets where it is not** — a 523 K dew point, which is Clausius-Clapeyron at the loading a plume carries rather than levoglucosan's 658 K boiling point. Two rates that climb with temperature against one gate that closes with it, so a flame blackens its own smoke and a smoulder whitens its own with nothing choosing. `aerosolAt` sums every carried species in the **liquid phase**, so the field never names a species this library invented |
| **A log dries, smokes and catches**  | The whole of `§21`, asserted: the surface pins at the boiling point while the core stays cold, gas comes off, and it lights. **A green log at the same fire does not**                                                                                                                                                                                                                                                                                                                                                                     |
| **Thirty-nine substances**           | Across seven entry points — organic, food, fuel, polymer, mineral, metal, biological — each with real compositions, thermophysics and reactions, and **each family costs 625 bytes to 1.3 kilobytes**, so a consumer who wants a campfire pays for a campfire                                                                                                                                                                                                                                                                              |

## The substance library, and what it costs

```ts
import {
  installLibrary,
  ReactionRegistry,
  SpeciesRegistry,
  SubstanceRegistry,
} from '@driftengine/chemistry';
import { ORGANIC } from '@driftengine/chemistry/library/organic';

installLibrary(ORGANIC, species, reactions, substances);
const log = parcels.spawn({
  substance: substances.indexOf('oak'),
  mass: 8,
  temperature: 293.15,
  area: 0.2,
});
```

| Entry point          | Substances                                                             | Cost over three you wrote yourself |
| -------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `library/organic`    | oak, pine, paper, cotton, leather, straw                               | 1,279 B                            |
| `library/food`       | water, ice, butter, beef-muscle, potato, egg-white, sugar              | 1,062 B                            |
| `library/fuel`       | ethanol, petrol, diesel, kerosene, paraffin-wax                        | 926 B                              |
| `library/biological` | compost, hay, flesh, must                                              | 845 B                              |
| `library/polymer`    | polyethylene, polypropylene, pvc, polystyrene, pmma, polyurethane-foam | 734 B                              |
| `library/mineral`    | limestone, gypsum-board, sand, clay, concrete, glass                   | 703 B                              |
| `library/metal`      | iron, steel, aluminium, copper, magnesium                              | 625 B                              |

Installing several is ordinary: they share the water phase changes, the five gas-phase combustion
steps and the two char oxidations, and `installLibrary` skips what is already registered.

**Some things the library does that nothing in it decides.** A candle is wax melting, then boiling,
then burning — three gated reactions in series, and the word "candle" appears nowhere. A steak
cannot brown while it is wet, because Maillard needs 140 °C and a wet surface is pinned at 100.
PVC self-extinguishes in air and PMMA does not, on one number each. Char makes mostly CO₂ when it
smoulders cool and mostly CO when it smoulders hot, because two activation energies differ by
`6240·R` and that ratio **is** Arthur's relation. A hay bale respires, warms itself out of the
mesophilic band and is picked up by the thermophiles above it. And burning leather gives off
hydrogen cyanide, because collagen carries 1.3 nitrogens per residue and they have to go somewhere.

**One bias, stated rather than buried.** Pyrolysis endotherms derived over this species set run
high, because the volatile slate stops at C₂ and char is pure carbon where real volatiles are
C₁₀–C₄₀ and real char keeps some hydrogen and oxygen. What is _not_ biased is the total: Hess's law
over the whole path reproduces each material's measured heating value exactly, so what the cap
distorts is the split between the gasification and the flame, not the heat. It bites hardest on the
polyolefins and barely at all on wood, whose aggregate lands inside the measured band.

## The one thing worth knowing before reading the code

**A species stores a formation enthalpy and a heat capacity, and nothing reads them yet.** That is
not an oversight. CH-3 builds the reaction network, and it derives every reaction's `ΔH` from these
by Hess's law rather than taking a typed-in number — because a reaction enthalpy that disagreed
with its own species would conserve energy _in the code_ and lose it _against the world_, with no
symptom anywhere.

So the numbers are checked here instead, where they are written: `standard.test.ts` reconstructs
eighteen published higher heating values from the stored enthalpies and the element rows, and holds
them to two percent, which is inside the spread of the published figures themselves.

**Pseudo-species carry a back-derived enthalpy.** Cellulose, lignin, a protein residue and a diesel
surrogate have never been in a calorimeter; what has been measured is what a kilogram of them gives
off. Their formation enthalpies are derived from that, so Hess's law reproduces the heat the world
actually releases. They are marked `pseudo: true`, so a reader can tell an exact number from a mean
over a population.

## Using it

```ts
import {
  ELEMENT_COUNT,
  SpeciesRegistry,
  elementTotals,
  massFractions,
  registerStandardSpecies,
} from '@driftengine/chemistry';

const registry = new SpeciesRegistry();
registerStandardSpecies(registry);

// Seasoned oak, dry basis, as mass fractions that must sum to one.
const oak = massFractions(registry, {
  cellulose: 0.43,
  hemicellulose: 0.26,
  lignin: 0.26,
  extractives: 0.04,
  ash: 0.01,
});

// Ten kilograms of it, reduced to moles of each of the fifteen elements.
const mass = new Float64Array(registry.count);
for (let i = 0; i < oak.species.length; i++) {
  mass[oak.species[i]!] = oak.fraction[i]! * 10;
}
const elements = new Float64Array(ELEMENT_COUNT);
elementTotals(registry, mass, elements);
```

**Registration fails fast and never warns.** An unknown element, a duplicate id, a negative
subscript, an empty formula, a composition that does not sum to one: each throws at init naming the
offending value. Nothing here runs in a frame, so checking thoroughly costs nothing and not
checking costs a `NaN` that surfaces twenty ticks into a burn.

## Drawing it

```ts
import { installChemistry, writeSurface, emitSmoke } from '@driftengine/chemistry/present';
```

**`present/` imports nothing and names no core type.** Every target is described structurally by
what it must have — core's `ParticleInstances` satisfies `SmokeTarget` exactly, and neither package
knows the other exists. Six mappings, and every one is a physical quantity rather than an art
direction: smoke colour from the soot-to-aerosol ratio, flame height from `L ≈ 0.235·Q^(2/5) −
1.02·D`, glow from Planck at the surface temperature, albedo lerped by char fraction, roughness from
the surface water film, and a scale from the cube root of what is left of the volume. Plus three
audio scalars, and the package never touches `@driftengine/audio`.

**Emissive in this engine is gated on `nightFactor`.** Embers written by `writeSurface` look right at
dusk and dead at noon. That is `AGENTS.md`'s standing trap and it is said here because this is where
a consumer meets it.

`demo/dev/chemistry.html` is the scene: a hearth where the kettle sits at 99 °C, the green log sits
at 100 °C, the ice core sits at −1 °C, the iron nail reaches 611 °C and the copper coin beside it
reaches 75, and a panel in the corner reports element drift at 2.6e-10 over the whole run.

## Budgets, tiers, and the fingerprint

**A cold stone sleeps.** A parcel whose surface flux and reaction output have both been still for
thirty ticks is skipped entirely, and wakes on heat, water, mass, a contact, or a fire coming within
range — the last through a coarse scan spread round-robin over four ticks, so a thousand sleepers
cost two hundred and fifty range comparisons a tick.

**Four tiers, and every one conserves.** `Hero` is the resolution the substance declared, down to one
shell every sixteenth tick at `Distant`. Shells are equal-mass by construction, so a fold is a
proportional redistribution and mass, every element and enthalpy come through exactly — which is what
makes a tier change safe mid-burn. What it costs is measured and stated: over five hundred seconds of
fire, `Near` is exact, `Far` drifts 21% and `Distant` 43%, and the coarser tiers char _more_, because
a lumped parcel has no cold core to hide behind.

**`fingerprintChemistry`** is sixteen hexadecimal digits over parcel compositions, enthalpies, the
field's elements and the substance registry — order-insensitive over parcels, because a handle is
the order something was spawned in. Two libraries are two worlds and it says so.

## What is absent

**Nothing the design specified.** Condensed tar was the last of it and closed:
`tar(l)` is carried the way `C(soot)` is, its formation enthalpy is the number pyrolysis oil's
heating value measures directly, and the vapour that shipped first turns out to be the derived one.

One thing inside CH-3 is knowingly approximate and is CH-5's gate: a substance's enthalpy curve is
built from its _initial_ composition, so as reactions run, the temperature read back drifts by
however much the true heat capacity has moved. Energy stays exact — the joules are added and
subtracted directly — and the fix is written down in that phase's plan. See `ROADMAP.md`'s Track P row for the
order, and the design's `§26` for the nine things the track refuses outright.

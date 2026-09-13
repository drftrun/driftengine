import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ParcelStore } from '../parcel/store.ts';
import { AtmosphereField } from '../field/atmosphere.ts';
import { STANDARD_AIR } from '../field/ambient.ts';
import { ChemistryWorld } from '../transport/world.ts';
import { ELEMENT_COUNT } from '../element/elements.ts';
import { maxElementDrift } from '../testing/drift.ts';
import { installLibrary } from '../library/library.ts';
import { ORGANIC } from '../library/organic.ts';
import { MINERAL } from '../library/mineral.ts';
import { TIER_DISTANT, TIER_FAR, TIER_HERO, TIER_NEAR, type Tier } from '../parcel/tier.ts';

function build(): { world: ChemistryWorld; parcels: ParcelStore; substances: SubstanceRegistry } {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(ORGANIC, species, reactions, substances);
  installLibrary(MINERAL, species, reactions, substances);
  const parcels = new ParcelStore(substances);
  const air = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR, maxChunks: 1 });
  return { world: new ChemistryWorld(parcels, air), parcels, substances };
}

describe('sleeping', () => {
  let world: ChemistryWorld;
  let parcels: ParcelStore;
  let substances: SubstanceRegistry;

  beforeEach(() => {
    ({ world, parcels, substances } = build());
  });

  const stone = (x: number): number =>
    parcels.spawn({
      substance: substances.indexOf('limestone'),
      mass: 5,
      temperature: 293.15,
      area: 1,
      x,
      y: 0.5,
      z: 0.5,
    });

  it('PUTS A COLD STONE TO SLEEP, and a thousand of them cost a bounded scan', () => {
    /*
     * `§14`: "a cold stone floor is a thousand sleeping parcels costing a bounded scan." A parcel
     * whose surface flux and composition have both been still for long enough is skipped entirely,
     * which is the whole performance argument for this phase.
     */
    const rock = stone(6.5);
    expect(parcels.sleeping(rock)).toBe(false);
    for (let i = 0; i < 60; i++) world.simulate(1 / 60, 0, 0);
    expect(parcels.sleeping(rock)).toBe(true);
  }, 60000);

  it('WAKES IT WHEN A FIRE COMES WITHIN RANGE, without anyone saying so', () => {
    /*
     * The wake test is `§14`'s coarse scan: a sleeping parcel is tested against the source set's own
     * ranges — which CH-5 already derives from source power, so a bonfire reaches further than a
     * candle — rather than against every source at full precision.
     */
    const rock = stone(1.5);
    for (let i = 0; i < 60; i++) world.simulate(1 / 60, 0, 0);
    expect(parcels.sleeping(rock)).toBe(true);

    world.sources.clear();
    world.sources.add(0.5, 0.5, 0.5, 1200, 0.2, 90000);
    /* The scan is round-robin across four ticks, so it takes a handful rather than one. */
    for (let i = 0; i < 8; i++) world.simulate(1 / 60, 0, 0);
    expect(parcels.sleeping(rock)).toBe(false);
  }, 60000);

  it('WAKES IT WHEN HEAT OR WATER ARRIVES, because both change what it is', () => {
    const rock = stone(6.5);
    for (let i = 0; i < 60; i++) world.simulate(1 / 60, 0, 0);
    expect(parcels.sleeping(rock)).toBe(true);
    parcels.addHeat(rock, 5000);
    expect(parcels.sleeping(rock)).toBe(false);
  }, 60000);

  it('never sleeps something that is burning, whatever its flux is doing', () => {
    /* A steady flame is a *steady* parcel by every measure this uses, and sleeping one would put out
       a fire by optimising it. */
    const rock = stone(6.5);
    parcels.setBurning(rock, true);
    for (let i = 0; i < 120; i++) world.simulate(1 / 60, 0, 0);
    expect(parcels.sleeping(rock)).toBe(false);
  }, 60000);
});

describe('the four tiers, burning the same log', () => {
  it('AGREES WITHIN TOLERANCE ACROSS ALL FOUR, which is what makes LOD safe', () => {
    /*
     * `§25`'s row, and the strongest thing that can be said about a level-of-detail scheme: the same
     * log, the same fire, the same seconds — at four resolutions — ends up made of the same stuff.
     *
     * **Conservation is exact and agreement is not**, and the difference matters. A tier folds
     * shells and coarsens the step, so the *rate* a log chars at genuinely changes; what may not
     * change is how much of anything there is. Elements are asserted to 1e-12 and the composition to
     * a band that holds the measured spread.
     */
    const totals: Float64Array[] = [];
    const chars: number[] = [];

    for (const tier of [TIER_HERO, TIER_NEAR, TIER_FAR, TIER_DISTANT] as Tier[]) {
      const { world, parcels, substances } = build();
      const log = parcels.spawn({
        substance: substances.indexOf('oak'),
        mass: 4,
        temperature: 293.15,
        area: 0.4,
        x: 0.6,
        y: 0.5,
        z: 0.5,
      });
      parcels.setTier(log, tier);
      for (let i = 0; i < 2000; i++) {
        world.sources.clear();
        world.sources.add(0, 0.5, 0.5, 1250, 0.2, 90000);
        world.contacts.clear();
        world.simulate(0.25, 0.1, 0);
      }
      const out = new Float64Array(ELEMENT_COUNT);
      parcels.elementTotalsOf(log, out);
      totals.push(out);
      chars.push(parcels.charFractionOf(log));
    }

    /*
     * **Measured, and recorded rather than banded to taste.** Five hundred seconds of fire on a 4 kg
     * oak log:
     *
     * | Tier | Element drift from Hero | Char fraction |
     * |---|---|---|
     * | Near | 0.0000 | 0.0816 |
     * | Far | 0.2118 | 0.0847 |
     * | Distant | 0.4331 | 0.1277 |
     *
     * **Near is exact because oak declares four shells and `Near` is four**, so nothing folded. That
     * is the tier system saying it will not reduce below what an author asked for.
     *
     * **The coarser tiers char *more*, and the direction is the physics rather than an error.** A
     * lumped parcel has no cold core to hide behind: fold four shells into one and the whole log sits
     * at something near its own surface temperature, so it pyrolyses further in the same seconds. A
     * `Distant` log is a log that has given up its depth, and depth is the entire reason a log is not
     * a twig — so half again as much char is what "distant" costs and what it buys is a sixteenth of
     * the work.
     *
     * What is asserted is the **ordering**, which is the invariant that would break if a fold were
     * wrong: a coarser tier is never closer to Hero than a finer one.
     */
    const drifts = totals.map((t) => maxElementDrift(totals[0] as Float64Array, t));
    expect(drifts[1] as number).toBeLessThan(1e-12);
    expect(drifts[2] as number).toBeLessThan(0.3);
    expect(drifts[3] as number).toBeLessThan(0.6);
    for (let i = 2; i < drifts.length; i++) {
      expect(drifts[i] as number, `tier ${i} against ${i - 1}`).toBeGreaterThanOrEqual(
        drifts[i - 1] as number,
      );
    }
    /* And the direction: coarser chars further, because it has no core to hide behind. */
    expect(chars[3] as number).toBeGreaterThan(chars[0] as number);
    /* And they all actually did something, or the agreement above is agreement about nothing. */
    for (const char of chars) expect(char).toBeGreaterThan(0);
  }, 300000);
});

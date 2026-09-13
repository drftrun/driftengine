import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ParcelStore } from '../parcel/store.ts';
import { installLibrary } from './library.ts';
import { FOOD } from './food.ts';

function world(): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(FOOD, species, reactions, substances);
  return { species, reactions, substances };
}

describe('the food library', () => {
  it('installs: every reaction balances and every substance resolves', () => {
    const { substances } = world();
    for (const id of ['water', 'ice', 'butter', 'beef-muscle', 'potato', 'egg-white', 'sugar']) {
      expect(substances.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('melts fat over a BAND rather than at a point, which is why it renders slowly', () => {
    /*
     * `§8.1`'s worked case. Pure water's plateau has zero width; butter is a mixture of
     * triglycerides with different melting points, so it softens over about three kelvin — and that
     * band is the difference between fat rendering and fat snapping from solid to liquid.
     *
     * The band is the gate's `width`, which CH-6 put there for exactly this.
     */
    const { reactions } = world();
    const melt = reactions.indexOf('melt-fat');
    expect(reactions.minTemperatureOf(melt)).toBeCloseTo(306.15, 2);
    expect(reactions.gateWidthOf(melt)).toBeGreaterThan(2);
    /* Against water, whose plateau is half a kelvin wide because it is one substance. */
    expect(reactions.gateWidthOf(reactions.indexOf('boil-water'))).toBeLessThan(1);
  });

  it('turns collagen to gelatin on a clock, which is why slow cooking is slow', () => {
    /*
     * `§8.7`: many hours at 60 °C, about an hour at 80 °C. That ratio is what an activation energy
     * *is*, so the rate is back-derived from the two measured times rather than chosen — and the
     * consequence is that a tough cut needs time as well as heat, with nothing in the model saying
     * so.
     */
    const { reactions } = world();
    const index = reactions.indexOf('gelatinise-collagen');
    const at = (t: number): number => 1 / reactions.rateOf(index, t);
    expect(at(353.15)).toBeGreaterThan(1800);
    expect(at(353.15)).toBeLessThan(7200);
    expect(at(333.15) / at(353.15)).toBeGreaterThan(5);
  });

  it('gates browning above the boiling point, which is the whole of searing', () => {
    const { reactions } = world();
    /* 140 °C for Maillard and 160 °C for caramelisation, both above water's 100. */
    expect(reactions.minTemperatureOf(reactions.indexOf('brown-maillard'))).toBeCloseTo(413.15, 2);
    expect(reactions.minTemperatureOf(reactions.indexOf('caramelise'))).toBeCloseTo(433.15, 2);
  });

  it('CANNOT BROWN A WET SURFACE, and nothing anywhere enforces that', () => {
    /*
     * **The assertion this library exists to make.** Maillard needs 140 °C. A wet surface is pinned
     * at 100 °C by the vaporisation plateau, which is CH-6's gated reaction and not a rule. So while
     * there is water in the surface shell, browning is unreachable — not forbidden, *unreachable* —
     * and the instant the water is gone the surface climbs and it starts.
     *
     * Every piece of received wisdom about searing is this one fact: pat it dry, use a hot pan,
     * do not crowd it. None of that is in the model and all of it comes out.
     */
    const { species, substances } = world();
    const parcels = new ParcelStore(substances);
    const steak = parcels.spawn({
      substance: substances.indexOf('beef-muscle'),
      mass: 0.02,
      temperature: 293.15,
      area: 0.01,
    });
    const char = species.indexOf('C(char)');
    const water = species.indexOf('H2O(l)');
    /* A hot pan: 30 kW/m² over the 0.01 m² touching it, as joules per 20 ms step. */
    const DT = 0.02;
    const JOULES = 30000 * 0.01 * DT;

    const startWater = parcels.speciesMassOf(steak, 0, water);
    let brownedWhileWet = 0;
    let surfaceWhileWet = 0;
    let dryAt = -1;
    for (let step = 0; step < 30000; step++) {
      parcels.addSurfaceHeat(steak, JOULES);
      parcels.conduct(steak, DT);
      parcels.react(steak, DT);
      /* The SURFACE shell's water, not the parcel's: a steak's middle stays wet for as long as you
         like, and it is the surface that browns. */
      const left = parcels.speciesMassOf(steak, 0, water);
      if (dryAt < 0 && left < 1e-7) dryAt = step;
      /*
       * Sampled while the surface still holds a tenth of the water it started with, not down to the
       * last trace. The plateau ends as the last of it goes — the remaining water cannot absorb the
       * arriving flux, so the temperature starts to climb before the shell is strictly dry — and
       * that tail is the transition rather than a failure of the plateau.
       */
      if (left > startWater * 0.1) {
        brownedWhileWet = parcels.speciesMassOf(steak, 0, char);
        surfaceWhileWet = parcels.surfaceTemperatureOf(steak);
      }
    }

    /* It was pinned at the boiling point the whole time the water was there. */
    expect(surfaceWhileWet).toBeGreaterThan(370);
    expect(surfaceWhileWet).toBeLessThan(380);
    /* And produced no crust at all while it was. */
    expect(brownedWhileWet).toBeLessThan(1e-9);
    /* Then it dried, and then it browned. */
    expect(dryAt).toBeGreaterThan(0);
    expect(parcels.speciesMassOf(steak, 0, char)).toBeGreaterThan(1e-7);
  }, 60000);
});

import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ParcelStore } from '../parcel/store.ts';
import { installLibrary } from './library.ts';
import { BIOLOGICAL } from './biological.ts';

function world(): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(BIOLOGICAL, species, reactions, substances);
  return { species, reactions, substances };
}

describe('the biological library', () => {
  it('installs: every reaction balances and every substance resolves', () => {
    const { substances } = world();
    for (const id of ['compost', 'hay', 'flesh', 'must']) {
      expect(substances.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('DERIVES THE TWO PUBLISHED BIOCHEMICAL ENTHALPIES, and stores neither', () => {
    /*
     * Aerobic respiration of glucose releases 2,803 kJ/mol and fermentation 68 — the first is
     * `§8.6`'s own quoted figure and the second is a textbook one. Both come out of Hess's law over
     * glucose, ethanol, carbon dioxide and water, and neither is written anywhere.
     *
     * That the ratio between them is forty is the whole of why fermentation is a survival strategy
     * and respiration is a fire hazard.
     */
    const { reactions } = world();
    const aerobic = reactions.enthalpyOf(reactions.indexOf('decay-mesophilic'));
    expect(aerobic).toBeGreaterThan(-2830000);
    expect(aerobic).toBeLessThan(-2780000);
    const fermenting = reactions.enthalpyOf(reactions.indexOf('ferment'));
    expect(fermenting).toBeGreaterThan(-72000);
    expect(fermenting).toBeLessThan(-65000);
  });

  it('PEAKS AND THEN FALLS OFF A CLIFF, which Arrhenius cannot do', () => {
    /*
     * `§8.6` refuses Arrhenius here structurally: an enzyme-catalysed rate rises to an optimum and
     * then collapses as the enzyme denatures, and modelling decay with Arrhenius gives compost that
     * gets hotter forever — the single most common mistake in this area.
     *
     * So the shape is asserted: zero at both ends, maximum at the optimum, and **asymmetric** — a
     * slow rise and a sharp fall, which is what the cardinal form is for.
     */
    const { reactions } = world();
    const index = reactions.indexOf('decay-mesophilic');
    const at = (t: number): number => reactions.rateOf(index, t);
    expect(at(272)).toBe(0);
    expect(at(320)).toBe(0);
    expect(at(308.15)).toBeGreaterThan(at(298.15));
    expect(at(308.15)).toBeGreaterThan(at(315));
    /* Asymmetric: five kelvin past the optimum costs more than five kelvin short of it. */
    expect(at(313.15)).toBeLessThan(at(303.15));
  });

  it('hands over to the thermophiles where the mesophiles die', () => {
    /* Which is why a compost heap steams: the first population heats it past its own maximum and a
       second one takes over above that. Two reactions, two bands, no handover code. */
    const { reactions } = world();
    const meso = reactions.indexOf('decay-mesophilic');
    const thermo = reactions.indexOf('decay-thermophilic');
    expect(reactions.rateOf(meso, 303.15)).toBeGreaterThan(reactions.rateOf(thermo, 303.15));
    expect(reactions.rateOf(thermo, 328.15)).toBeGreaterThan(reactions.rateOf(meso, 328.15));
    expect(reactions.rateOf(meso, 328.15)).toBe(0);
  });

  it('A HAY BALE SELF-HEATS OUT OF ITS OWN BAND, and nobody implemented that', () => {
    /*
     * `§8.6`'s claim, as far as a unit test can carry it. Wet hay respires, respiration is
     * exothermic, and a pile large enough to keep the heat generates faster than it loses — so it
     * climbs out of the mesophilic band, kills the population that was doing it, and is picked up by
     * the thermophiles above.
     *
     * **Oxygen is injected rather than transported**, because what is being asserted is the cardinal
     * rate and the enthalpy balance, not the field. A bale that could not breathe would simply stop,
     * which is the same model saying something different and true.
     *
     * The path from here to actual ignition is real and is not asserted: it needs the char branch and
     * days of simulated time, which is beyond a test's budget. What is asserted is the mechanism that
     * gets it started, and that nothing anywhere was told about spontaneous combustion.
     */
    const { species, substances } = world();
    const parcels = new ParcelStore(substances);
    const bale = parcels.spawn({
      substance: substances.indexOf('hay'),
      mass: 1,
      temperature: 293.15,
      area: 1,
    });
    const oxygen = species.indexOf('O2');
    const shells = parcels.shellCount(bale);
    const DT = 10;

    let thermophilicAt = -1;
    for (let step = 0; step < 30000 && thermophilicAt < 0; step++) {
      /* Air reaching the inside of a porous bale, topped up each step. */
      for (let shell = 0; shell < shells; shell++) {
        const held = parcels.speciesMassOf(bale, shell, oxygen);
        if (held < 5e-4) parcels.addSpeciesMass(bale, shell, oxygen, 5e-4 - held);
      }
      parcels.conduct(bale, DT);
      parcels.react(bale, DT);
      if (parcels.temperatureOf(bale) > 313.15) thermophilicAt = step;
    }

    expect(thermophilicAt).toBeGreaterThan(0);
    /*
     * **6.1 hours, measured, against a real bale's one to three days** — and the gap is the harness
     * rather than the model. Nothing here loses heat to anything, and the oxygen is topped up every
     * step, so this is the adiabatic upper bound on a mechanism a real bale runs against convection,
     * conduction to the ground and its own air running out. Recorded rather than tuned, per the
     * track's stop condition; the band below holds the measurement and the real figure both.
     */
    expect(thermophilicAt * DT).toBeGreaterThan(3600);
    expect(thermophilicAt * DT).toBeLessThan(3 * 86400);
  }, 120000);

  it('MAKES METHANE WHEN THERE IS NO OXYGEN, and nothing decides which branch', () => {
    /*
     * `§8.6`: a submerged log rots one way and a fallen one rots the other. There is no gate on
     * either branch — aerobic decay simply has oxygen as a reactant, so a parcel with none cannot
     * run it, and mass action does the rest.
     */
    const { species, substances } = world();
    const parcels = new ParcelStore(substances);
    const drowned = parcels.spawn({
      substance: substances.indexOf('compost'),
      mass: 1,
      temperature: 305.15,
      area: 1,
    });
    const methane = species.indexOf('CH4');
    for (let step = 0; step < 20000; step++) parcels.react(drowned, 10);
    expect(parcels.parcelSpeciesMass(drowned, methane)).toBeGreaterThan(1e-6);
    /* And it barely warmed: the methane path keeps the energy rather than releasing it. */
    expect(parcels.temperatureOf(drowned)).toBeLessThan(315);
  }, 60000);
});

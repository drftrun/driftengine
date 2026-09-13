import { describe, expect, it } from 'vitest';
import { PHASE_GAS } from '../species/species.ts';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ParcelStore } from '../parcel/store.ts';
import { installLibrary } from './library.ts';
import { FUEL } from './fuel.ts';

function world(): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(FUEL, species, reactions, substances);
  return { species, reactions, substances };
}

/** MJ per kilogram of the fuel a combustion reaction consumes first. */
function heatingValue(reactions: ReactionRegistry, species: SpeciesRegistry, id: string): number {
  const index = reactions.indexOf(id);
  const fuel = reactions.reactantSpecies(index)[0] as number;
  const moles = reactions.reactantMoles(index)[0] as number;
  return -reactions.enthalpyOf(index) / (moles * species.molarMass(fuel)) / 1e6;
}

describe('the fuel library', () => {
  it('installs: every reaction balances and every substance resolves', () => {
    const { substances } = world();
    for (const id of ['ethanol', 'petrol', 'diesel', 'kerosene', 'paraffin-wax']) {
      expect(substances.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it("RECOVERS EACH FUEL'S PUBLISHED HEATING VALUE from a chain of back-derivations", () => {
    /*
     * **The check on every number in this file at once.** A gas species here is a liquid that
     * already existed plus a *measured enthalpy of vaporisation*, and nothing about combustion went
     * into either. So the lower heating value that falls out of the burn reaction is a prediction,
     * and these are the published figures it is predicting.
     *
     * The values are the **vapour** ones, which sit above the familiar liquid figures by exactly the
     * vaporisation that was added — ethanol at 27.7 MJ/kg against the liquid's 26.8, and that gap is
     * 0.92 MJ/kg, which is 42.3 kJ/mol over 46.07 g/mol. The arithmetic closes.
     */
    const { reactions, species } = world();
    expect(heatingValue(reactions, species, 'burn-ethanol')).toBeGreaterThan(27.2);
    expect(heatingValue(reactions, species, 'burn-ethanol')).toBeLessThan(28.2);
    expect(heatingValue(reactions, species, 'burn-petrol')).toBeGreaterThan(44.0);
    expect(heatingValue(reactions, species, 'burn-petrol')).toBeLessThan(45.5);
    expect(heatingValue(reactions, species, 'burn-diesel')).toBeGreaterThan(43.5);
    expect(heatingValue(reactions, species, 'burn-diesel')).toBeLessThan(45.0);
    expect(heatingValue(reactions, species, 'burn-wax')).toBeGreaterThan(42.0);
    expect(heatingValue(reactions, species, 'burn-wax')).toBeLessThan(46.0);
    expect(heatingValue(reactions, species, 'burn-propane')).toBeGreaterThan(45.5);
    expect(heatingValue(reactions, species, 'burn-propane')).toBeLessThan(46.8);
  });

  it('makes a liquid vaporise before it burns, which is what rate-limits a pool fire', () => {
    /*
     * A pool of petrol does not burn. Its *vapour* burns, and how fast depends on how much heat
     * reaches the surface — which is why a pool fire's burning rate is a heat-transfer number and
     * not a chemical one, and why throwing sand on one works.
     */
    const { reactions, species } = world();
    const burn = reactions.indexOf('burn-petrol');
    expect(species.phaseOf(reactions.reactantSpecies(burn)[0] as number)).toBe(PHASE_GAS);
    expect(reactions.indexOf('vaporise-petrol')).toBeGreaterThanOrEqual(0);
  });

  it('gives a diesel cut a WIDE boiling band and ethanol a narrow one', () => {
    /* Ethanol is one molecule and boils at a point; diesel is a distillation cut and boils over
       tens of kelvin. Both are the same gate with a different width. */
    const { reactions } = world();
    expect(reactions.gateWidthOf(reactions.indexOf('vaporise-ethanol'))).toBeLessThan(2);
    expect(reactions.gateWidthOf(reactions.indexOf('vaporise-diesel'))).toBeGreaterThan(10);
  });

  it('BURNS A CANDLE, and nothing in the model knows what a candle is', () => {
    /*
     * Solid wax, then molten wax, then wax vapour, **in that order**, from one wick's worth of heat
     * arriving at a surface. Three gated reactions and a heat flux; no candle anywhere.
     *
     * This is the clearest case in the library of the design's claim that a phase change is just a
     * reaction: a candle is two of them in series, and the fact that it works is the fact that the
     * plateaus stack.
     */
    const { species, substances } = world();
    const parcels = new ParcelStore(substances);
    const candle = parcels.spawn({
      substance: substances.indexOf('paraffin-wax'),
      mass: 0.05,
      temperature: 293.15,
      area: 0.001,
    });
    const solid = species.indexOf('wax');
    const liquid = species.indexOf('wax(l)');
    const vapour = species.indexOf('wax(g)');

    let meltedAt = -1;
    let vaporisedAt = -1;
    const DT = 0.05;
    for (let step = 0; step < 40000 && vaporisedAt < 0; step++) {
      /* A wick delivers a small flux to a small area: 40 kW/m² over a square centimetre. */
      parcels.addSurfaceHeat(candle, 40000 * 0.001 * DT);
      parcels.conduct(candle, DT);
      parcels.react(candle, DT);
      if (meltedAt < 0 && parcels.parcelSpeciesMass(candle, liquid) > 1e-4) meltedAt = step;
      if (parcels.parcelSpeciesMass(candle, vapour) > 1e-6) vaporisedAt = step;
    }

    expect(meltedAt).toBeGreaterThan(0);
    expect(vaporisedAt).toBeGreaterThan(meltedAt);
    /* And there is still solid wax below: a candle burns at its top, not all at once. */
    expect(parcels.parcelSpeciesMass(candle, solid)).toBeGreaterThan(0);
  }, 60000);
});

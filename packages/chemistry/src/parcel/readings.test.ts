import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { PHASE_LIQUID, PHASE_SOLID } from '../species/species.ts';
import { installLibrary } from '../library/library.ts';
import { ORGANIC } from '../library/organic.ts';
import { FOOD } from '../library/food.ts';
import { ParcelStore } from './store.ts';

/**
 * The readings `drift/chemistry` needs and the store did not have.
 *
 * **Each is a real quantity rather than a passthrough**, which is why they are here and not in the
 * binding: `host.ts` says a binding is a lookup, and a lookup that had to compute a moisture content
 * would be the engine growing a function in the wrong package.
 */
describe('what a parcel can be asked', () => {
  let species: SpeciesRegistry;
  let substances: SubstanceRegistry;
  let parcels: ParcelStore;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    const reactions = new ReactionRegistry(species);
    substances = new SubstanceRegistry(species, reactions);
    installLibrary(ORGANIC, species, reactions, substances);
    installLibrary(FOOD, species, reactions, substances);
    parcels = new ParcelStore(substances);
  });

  const spawn = (id: string, mass = 1, temperature = 293.15): number =>
    parcels.spawn({ substance: substances.indexOf(id), mass, temperature, area: 0.2 });

  it('REPORTS MOISTURE ON A DRY BASIS, which is how everyone quotes it', () => {
    /*
     * Seasoned oak is authored at `moisture: 0.12`, meaning twelve kilograms of water per hundred of
     * *dry* wood — and `wetComposition` folded that into a wet-basis fraction of 0.107 to store it.
     * Reading it back has to undo the same conversion, or a script comparing against the 0.25 that
     * decides whether a log is worth burning would be reading a different quantity than the author
     * wrote.
     */
    expect(parcels.moistureOf(spawn('oak'))).toBeCloseTo(0.12, 6);
    /* Beef is 72% water by mass, which is 2.571 dry basis. */
    expect(parcels.moistureOf(spawn('beef-muscle'))).toBeCloseTo(2.571, 3);
  });

  it('reads the phase of what a parcel is made of, and says MIXED where it is', () => {
    expect(parcels.parcelPhaseOf(spawn('sugar'))).toBe(PHASE_SOLID);
    expect(parcels.parcelPhaseOf(spawn('water'))).toBe(PHASE_LIQUID);
    /* Wet oak is wood and water at once, and calling it either would be a lie. */
    expect(parcels.parcelPhaseOf(spawn('oak'))).toBe(3);
  });

  it('POURS WATER ON SOMETHING, and the water is really there', () => {
    /*
     * `wet` is not a flag. It puts liquid water in the surface shell, where the boiling reaction can
     * find it — so the heat sink `§12` describes is the same 2.44 MJ/kg every other drop of water in
     * this model carries, and the fire goes out for the reason a real one does.
     */
    const log = spawn('oak', 2);
    const water = species.indexOf('H2O(l)');
    const before = parcels.speciesMassOf(log, 0, water);
    parcels.wet(log, 0.05);
    expect(parcels.speciesMassOf(log, 0, water)).toBeCloseTo(before + 0.05, 9);
    /*
     * And it reads back as a film in kg per square metre — of the **free** water only, beyond the
     * 12% the wood carries as its own moisture. A seasoned log is not glossy and a doused one is,
     * and reporting the shell's total water would have made the two identical.
     */
    expect(parcels.wetnessOf(log)).toBeCloseTo(0.05 / 0.2, 6);

    parcels.dry(log, 0.05);
    expect(parcels.speciesMassOf(log, 0, water)).toBeCloseTo(before, 9);
  });

  it('refuses to wet something that cannot hold water, naming it', () => {
    /* Rather than silently doing nothing, which is the rule this whole package is written under. */
    expect(() => parcels.wet(spawn('sugar'), 0.01)).toThrow(/sugar/);
  });

  it('REPORTS HEAT RELEASE IN KILOWATTS, which is what a fire is measured in', () => {
    /*
     * The number every fire-engineering figure in the design is quoted against, and it is not the
     * temperature: a fire's size is its heat release rate. Measured as the thermal enthalpy the
     * reactions put into the parcel over the step that produced it, so it is the reactions' own
     * output and not conduction's or a radiative source's.
     */
    const ember = spawn('oak', 1, 1000);
    const oxygen = species.indexOf('O2');
    for (let shell = 0; shell < parcels.shellCount(ember); shell++) {
      parcels.addSpeciesMass(ember, shell, oxygen, 0.01);
    }
    parcels.react(ember, 0.1);
    expect(parcels.heatReleaseOf(ember)).not.toBe(0);
    /* A cold parcel with nothing happening releases nothing at all. */
    /*
     * A cold parcel releases −2.15 µW, measured, and the sign is worth keeping: lignin's activation
     * energy is 108 kJ/mol, low enough that it creeps at room temperature, and creeping is
     * endothermic. Two microwatts over a kilogram is a temperature falling by 5e-10 K a second,
     * which is a real number this model is entitled to and nothing a game will notice.
     */
    const cold = spawn('oak', 1, 280);
    parcels.react(cold, 0.1);
    expect(Math.abs(parcels.heatReleaseOf(cold))).toBeLessThan(1e-3);
  });

  it('LOSES STRUCTURAL INTEGRITY AS IT CHARS, and breaks nothing', () => {
    /*
     * `§18` refuses structural failure in writing: a beam whose char depth exceeds a fraction of its
     * thickness has lost its strength, and what happens then — a joint releasing, a building coming
     * down — belongs to whoever owns the solver. This package writes the scalar and stops.
     */
    const beam = spawn('oak', 2);
    expect(parcels.structuralIntegrityOf(beam)).toBeCloseTo(1, 6);

    const char = species.indexOf('C(char)');
    /* Turn the outer shell's three polymers to char, which is 95% of the dry matter and takes the
       shell past the half-char mark a charred-through shell is counted at. */
    for (const id of ['cellulose', 'hemicellulose', 'lignin']) {
      const polymer = species.indexOf(id);
      const held = parcels.speciesMassOf(beam, 0, polymer);
      parcels.addSpeciesMass(beam, 0, polymer, -held);
      parcels.addSpeciesMass(beam, 0, char, held);
    }
    expect(parcels.structuralIntegrityOf(beam)).toBeLessThan(1);
    expect(parcels.charDepthOf(beam)).toBeGreaterThan(0);
  });

  it('MIXES ONE PARCEL INTO ANOTHER, conserving both mass and enthalpy', () => {
    const cold = spawn('water', 1, 283.15);
    const hot = spawn('water', 1, 353.15);
    const total = parcels.enthalpyOf(cold) + parcels.enthalpyOf(hot);

    parcels.mix(hot, cold);

    expect(parcels.alive(hot)).toBe(false);
    expect(parcels.massOf(cold)).toBeCloseTo(2, 9);
    expect(parcels.enthalpyOf(cold)).toBeCloseTo(total, 6);
    /* And the temperature is the mass-weighted mean, which is what mixing means. */
    expect(parcels.temperatureOf(cold)).toBeCloseTo(318.15, 1);
  });

  it('refuses to mix two different materials, naming both', () => {
    /* Two substances are two species sets and two shell counts. A stew is not a substance change,
       and pretending otherwise would silently discard whichever set was narrower. */
    expect(() => parcels.mix(spawn('water'), spawn('oak'))).toThrow(/water.*oak|oak.*water/);
  });

  it('heats one named shell, which is what a microwave does', () => {
    const potato = spawn('potato', 0.3);
    const before = parcels.coreTemperatureOf(potato);
    parcels.addShellHeat(potato, parcels.shellCount(potato) - 1, 20000);
    expect(parcels.coreTemperatureOf(potato)).toBeGreaterThan(before);
    /* And the surface has not noticed, which is the whole difference from `addHeat`. */
    expect(parcels.surfaceTemperatureOf(potato)).toBeCloseTo(293.15, 3);
  });
});

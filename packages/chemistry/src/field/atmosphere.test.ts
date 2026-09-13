import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { STANDARD_AIR, STANDARD_PRESSURE_PA } from './ambient.ts';
import { AtmosphereField, CHUNK_SIZE } from './atmosphere.ts';

describe('AtmosphereField', () => {
  let species: SpeciesRegistry;
  let field: AtmosphereField;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    field = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR });
  });

  it('starts with no chunks at all, and the far field costs nothing', () => {
    expect(field.chunkCount).toBe(0);
    /* Reading empty space answers from the ambient rather than creating anything. */
    expect(field.temperatureAt(1000, 1000, 1000)).toBeCloseTo(STANDARD_AIR.temperature, 6);
    expect(field.chunkCount).toBe(0);
  });

  it('gives dry air the oxygen fraction dry air has', () => {
    /*
     * 20.95% by volume, which is the number every extinction criterion in `§12` is written against.
     * The field stores masses, so this is a real conversion through the molar masses CH-0 derived,
     * not a constant read back.
     */
    const dry = new AtmosphereField(species, {
      cellSize: 1,
      ambient: { ...STANDARD_AIR, humidity: 0 },
    });
    expect(dry.oxygenFractionAt(0, 0, 0)).toBeCloseTo(0.2095, 4);
  });

  it('and moist air rather less, because water vapour displaces it', () => {
    /*
     * The figure everyone quotes, 20.95%, is for *dry* air. At 20 °C and 50% relative humidity the
     * vapour is 1.15% of the mixture by volume and oxygen falls to 20.7% — which matters, because
     * the limiting index a flame goes out at is about 14% and humidity is a real part of the
     * distance to it. The default ambient is moist for that reason.
     */
    expect(field.oxygenFractionAt(0, 0, 0)).toBeCloseTo(0.2071, 3);

    const humid = new AtmosphereField(species, {
      cellSize: 1,
      ambient: { ...STANDARD_AIR, humidity: 1 },
    });
    expect(humid.oxygenFractionAt(0, 0, 0)).toBeLessThan(field.oxygenFractionAt(0, 0, 0));
  });

  it('creates a chunk only where something is put', () => {
    field.addSpecies(0.5, 0.5, 0.5, species.indexOf('CO'), 0.001);
    expect(field.chunkCount).toBe(1);
    field.addSpecies(2.5, 0.5, 0.5, species.indexOf('CO'), 0.001);
    expect(field.chunkCount).toBe(1);
    /* A chunk is eight cells across, so this lands in a second one. */
    field.addSpecies(CHUNK_SIZE + 0.5, 0.5, 0.5, species.indexOf('CO'), 0.001);
    expect(field.chunkCount).toBe(2);
  });

  it('addresses negative coordinates without folding them onto positive ones', () => {
    const co = species.indexOf('CO');
    field.addSpecies(-0.5, -0.5, -0.5, co, 0.002);
    const here = field.speciesMassAt(-0.5, -0.5, -0.5, co);
    expect(here).toBeGreaterThan(0);
    expect(field.speciesMassAt(0.5, 0.5, 0.5, co)).toBeLessThan(here);
  });

  it('reports a concentration in ppm, which is what a game decides on', () => {
    /* Carbon monoxide is the thing that kills, and 1,600 ppm is the figure a survival game wants
       to act on rather than a mole count it has to convert itself. */
    const co = species.indexOf('CO');
    const before = field.concentrationAt(0, 0, 0, co);
    expect(before).toBeCloseTo(0, 6);
    field.addSpecies(0.5, 0.5, 0.5, co, 0.001);
    expect(field.concentrationAt(0.5, 0.5, 0.5, co)).toBeGreaterThan(100);
  });

  it('warms when heat is added and cools when it is taken', () => {
    const before = field.temperatureAt(0.5, 0.5, 0.5);
    field.addHeat(0.5, 0.5, 0.5, 5000);
    const warm = field.temperatureAt(0.5, 0.5, 0.5);
    expect(warm).toBeGreaterThan(before + 1);
    field.addHeat(0.5, 0.5, 0.5, -5000);
    expect(field.temperatureAt(0.5, 0.5, 0.5)).toBeCloseTo(before, 3);
  });

  it('gains pressure when heated, because nothing has let it expand yet', () => {
    /*
     * A cell is a fixed volume, so heat raises its pressure and leaves its density alone. **Density
     * falls only once transport lets the gas out**, which is what actually makes a plume — and the
     * step that does it is asserted where it lives, in `transport.test.ts`. Asserting a density
     * drop here would be asserting that a sealed box gets lighter.
     */
    const cold = field.densityAt(0.5, 0.5, 0.5);
    expect(cold).toBeCloseTo(1.2, 1);
    const before = field.pressureAt(0.5, 0.5, 0.5);
    field.addHeat(0.5, 0.5, 0.5, 400000);
    expect(field.temperatureAt(0.5, 0.5, 0.5)).toBeGreaterThan(600);
    expect(field.pressureAt(0.5, 0.5, 0.5)).toBeGreaterThan(before * 2);
    expect(field.densityAt(0.5, 0.5, 0.5)).toBeCloseTo(cold, 9);
  });

  it('holds pressure near one atmosphere for undisturbed air', () => {
    expect(field.pressureAt(0.5, 0.5, 0.5)).toBeCloseTo(STANDARD_PRESSURE_PA, -3);
  });

  it('reports visibility, and smoke takes it away', () => {
    const clear = field.visibilityAt(0.5, 0.5, 0.5);
    expect(clear).toBeGreaterThan(1000);
    field.addSoot(0.5, 0.5, 0.5, 1e-4);
    const smoky = field.visibilityAt(0.5, 0.5, 0.5);
    expect(smoky).toBeLessThan(20);
    expect(smoky).toBeGreaterThan(0);
  });

  it('refuses a species it does not carry, naming it', () => {
    expect(() => field.addSpecies(0, 0, 0, species.indexOf('cellulose'), 1)).toThrow(/cellulose/);
  });

  it('conserves what is put into it, summed over every cell', () => {
    const co2 = species.indexOf('CO2');
    let expected = 0;
    for (let i = 0; i < 50; i++) {
      field.addSpecies(i * 0.7, 0.5, 0.5, co2, 0.001);
      expected += 0.001;
    }
    /* Against the ambient the cells already held, so the difference is what was added. */
    expect(field.totalAdded(co2)).toBeCloseTo(expected, 9);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { STANDARD_AIR } from './ambient.ts';
import { AtmosphereField } from './atmosphere.ts';

describe('what the air can be asked', () => {
  let species: SpeciesRegistry;
  let field: AtmosphereField;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    field = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR, maxChunks: 1 });
  });

  it('REPORTS RELATIVE HUMIDITY, which is what dries washing and what does not', () => {
    /*
     * The ambient is authored at 50% and the field fills a cell from it, so this is the round trip
     * through a partial pressure and back — and it is the reading `§8.1`'s evaporation is gated on:
     * nothing dries in fog because the vapour pressure deficit is zero.
     */
    expect(field.humidityAt(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 2);
  });

  it('drops the humidity when the air is heated, without any water leaving', () => {
    /*
     * Warm air holds more, so the same water is a smaller fraction of what saturation allows. That
     * is why a fire dries a room out: it removes no water at all.
     */
    const before = field.humidityAt(0.5, 0.5, 0.5);
    field.addHeat(0.5, 0.5, 0.5, 60000);
    expect(field.humidityAt(0.5, 0.5, 0.5)).toBeLessThan(before * 0.5);
  });

  it('reports smoke as an extinction coefficient, which is what visibility is derived from', () => {
    /*
     * `visibilityAt` is Koschmieder over this, so the two must agree by construction: metres and
     * inverse metres are the same measurement, and a consumer wanting to attenuate a light along a
     * ray needs the coefficient rather than the distance.
     */
    expect(field.smokeDensityAt(0.5, 0.5, 0.5)).toBe(0);
    field.addSoot(0.5, 0.5, 0.5, 1e-4);
    const extinction = field.smokeDensityAt(0.5, 0.5, 0.5);
    expect(extinction).toBeGreaterThan(0);
    /* Koschmieder's constant is 3.912, and the product is it exactly. */
    expect(field.visibilityAt(0.5, 0.5, 0.5) * extinction).toBeCloseTo(3.912, 6);
  });
});

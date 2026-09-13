import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { massFractions } from '../substance/composition.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { SHAPE_SLAB } from './shells.ts';
import { ParcelStore } from './store.ts';

/* Oak: 700 kg/m³, about 1300 J/(kg·K) over this composition, 0.16 W/(m·K) across the grain. */
const OAK_K = 0.16;
const AMBIENT = 293.15;

describe('conduction through a parcel’s depth', () => {
  let species: SpeciesRegistry;
  let substances: SubstanceRegistry;
  let oak: number;
  let parcels: ParcelStore;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    substances = new SubstanceRegistry(species);
    oak = substances.define({
      id: 'oak',
      composition: massFractions(species, { cellulose: 0.6, lignin: 0.4 }),
      density: 700,
      conductivity: { k0: OAK_K, k1: 0 },
      shells: 4,
      shape: SHAPE_SLAB,
    });
    parcels = new ParcelStore(substances);
  });

  const slab = (thickness: number, area = 0.01): number =>
    parcels.spawn({ substance: oak, mass: 700 * area * thickness, temperature: AMBIENT, area });

  it('starts every shell at the temperature it was spawned with', () => {
    const p = slab(0.02);
    expect(parcels.shellCount(p)).toBe(4);
    for (let i = 0; i < 4; i++) expect(parcels.shellTemperatureOf(p, i)).toBeCloseTo(AMBIENT, 6);
    expect(parcels.surfaceTemperatureOf(p)).toBeCloseTo(AMBIENT, 6);
    expect(parcels.coreTemperatureOf(p)).toBeCloseTo(AMBIENT, 6);
  });

  it('conserves the parcel’s total enthalpy exactly, however long it runs', () => {
    /*
     * The invariant that holds whatever the step size does. Conduction *moves* energy between
     * shells: whatever leaves one enters the next, so an unstable step can oscillate but can never
     * gain or lose a joule. That is why an explicit integrator is safe here, and it is asserted
     * rather than argued.
     */
    const p = slab(0.02);
    parcels.addSurfaceHeat(p, 50000);
    const total = parcels.enthalpyOf(p);
    for (let i = 0; i < 5000; i++) parcels.conduct(p, 1 / 60);
    expect(parcels.enthalpyOf(p)).toBeCloseTo(total, 6);
  });

  it('moves heat inward from a hot surface and stops when it is level', () => {
    const p = slab(0.02);
    parcels.addSurfaceHeat(p, 50000);
    expect(parcels.surfaceTemperatureOf(p)).toBeGreaterThan(parcels.coreTemperatureOf(p) + 100);

    /*
     * Six thousand seconds, and it needs every one of them. Oak's thermal diffusivity is
     * 1.76e-7 m²/s, so levelling 20 mm takes on the order of an hour — measured at 254 K of spread
     * still left after 333 s, 9.9 K after 1,667 s and 0.003 K after 5,000 s. A test that ran for a
     * few simulated minutes and expected equilibrium would be asserting that wood is not an
     * insulator.
     */
    for (let i = 0; i < 6000; i++) parcels.conduct(p, 1);

    const surface = parcels.surfaceTemperatureOf(p);
    const core = parcels.coreTemperatureOf(p);
    expect(surface - core).toBeLessThan(0.5);
    expect(core).toBeGreaterThan(AMBIENT);
  });

  it('never drives a shell past the one it is drawing from', () => {
    /* The failure an unstable explicit step actually shows: not lost energy, but a cold shell
       overshooting past its neighbour and the pair ringing. */
    const p = slab(0.02);
    parcels.addSurfaceHeat(p, 50000);
    for (let i = 0; i < 3000; i++) {
      parcels.conduct(p, 1 / 60);
      for (let s = 1; s < 4; s++) {
        expect(
          parcels.shellTemperatureOf(p, s - 1),
          `tick ${i}, shell ${s}`,
        ).toBeGreaterThanOrEqual(parcels.shellTemperatureOf(p, s) - 1e-6);
      }
    }
  });

  it('does nothing at all to a parcel of one shell', () => {
    const one = substances.define({
      id: 'oak-1',
      composition: massFractions(species, { cellulose: 0.6, lignin: 0.4 }),
      density: 700,
      conductivity: { k0: OAK_K, k1: 0 },
      shells: 1,
      shape: SHAPE_SLAB,
    });
    const p = parcels.spawn({ substance: one, mass: 1, temperature: AMBIENT, area: 0.01 });
    parcels.addSurfaceHeat(p, 50000);
    const before = parcels.surfaceTemperatureOf(p);
    parcels.conduct(p, 1 / 60);
    expect(parcels.surfaceTemperatureOf(p)).toBeCloseTo(before, 12);
  });

  it('takes the harmonic mean at an interface, not the arithmetic one', () => {
    /*
     * A boundary between two shells is a **series** resistance, and a series resistance adds
     * reciprocals. It only matters when the two sides differ, which they do as soon as
     * conductivity depends on temperature — and it matters a lot: with `k` running from 0.12 to
     * 5.12 across this pair, the two means are a factor of eleven apart. Getting it wrong makes a
     * char layer over wet wood insulate far less than it does, which is the whole late-stage story
     * of a burning log.
     */
    const swingy = substances.define({
      id: 'swingy',
      composition: massFractions(species, { SiO2: 1 }),
      density: 1000,
      conductivity: { k0: 0.1, k1: 0.01 },
      shells: 2,
      shape: SHAPE_SLAB,
    });
    const area = 1;
    const thickness = 0.1;
    const p = parcels.spawn({
      substance: swingy,
      mass: 1000 * area * thickness,
      temperature: 300,
      area,
    });
    parcels.setShellTemperature(p, 0, 800);

    const hot = parcels.shellTemperatureOf(p, 0);
    const cold = parcels.shellTemperatureOf(p, 1);
    const kHot = 0.1 + 0.01 * (hot - 298.15);
    const kCold = 0.1 + 0.01 * (cold - 298.15);
    const harmonic = (2 * kHot * kCold) / (kHot + kCold);
    const arithmetic = (kHot + kCold) / 2;

    const before = parcels.shellEnthalpyOf(p, 1);
    const dt = 1e-4;
    parcels.conduct(p, dt);
    const moved = parcels.shellEnthalpyOf(p, 1) - before;

    /* dx is half of shell 0 plus half of shell 1, which for two equal slabs is the full 0.05 m. */
    const expected = (k: number): number => (k * area * (hot - cold) * dt) / 0.05;
    expect(moved / expected(harmonic)).toBeCloseTo(1, 2);
    expect(moved / expected(arithmetic)).toBeLessThan(0.2);
  });

  it('refuses a substance with no conductivity, naming it', () => {
    const vague = substances.define({
      id: 'vague',
      composition: massFractions(species, { SiO2: 1 }),
      density: 1000,
      shells: 4,
      shape: SHAPE_SLAB,
    });
    const p = parcels.spawn({ substance: vague, mass: 1, temperature: AMBIENT, area: 0.01 });
    expect(() => parcels.conduct(p, 1 / 60)).toThrow(/vague/);
  });

  it('refuses a parcel with no area, because depth is volume over area', () => {
    const p = parcels.spawn({ substance: oak, mass: 1, temperature: AMBIENT });
    expect(() => parcels.conduct(p, 1 / 60)).toThrow(/area/);
  });

  it('KINDLING CATCHES AND A LOG DOES NOT, under exactly the same flux', () => {
    /*
     * **The acceptance test of this phase**, and the single most important qualitative fact about
     * fire: thin things ignite and thick things do not. Every slab below is the same oak, the same
     * area and the same 20 kW/m² a real fire delivers at about 400 mm. The only thing that differs
     * is how deep it goes.
     *
     * Measured, at the moment the surface passes 300 °C:
     *
     *      2 mm   29.2 s        20 mm  119.0 s
     *      5 mm   50.4 s        40 mm  212.1 s
     *     10 mm   73.2 s        80 mm  399.6 s
     *
     * **The interesting part is that it is sub-linear.** Forty times the thickness costs fourteen
     * times the time, not forty — because a thick slab is *thermally thick*: the heat front never
     * reaches the far side, so the surface stops caring how much wood is behind it and its rise
     * approaches the semi-infinite `q·sqrt(t/(π·k·ρ·c))`. A parcel with one temperature has the
     * opposite behaviour, exactly linear in mass, and is wrong at both ends.
     */
    const AREA = 0.01;
    const FLUX = 20000;
    const IGNITION = 573.15;
    const DT = 0.1;

    const timeToIgnite = (thickness: number): number => {
      const p = slab(thickness, AREA);
      for (let step = 0; step < 500000; step++) {
        parcels.addSurfaceHeat(p, FLUX * AREA * DT);
        parcels.conduct(p, DT);
        if (parcels.surfaceTemperatureOf(p) >= IGNITION) return (step + 1) * DT;
      }
      return Number.POSITIVE_INFINITY;
    };

    const thicknesses = [0.002, 0.005, 0.01, 0.02, 0.04, 0.08];
    const times = thicknesses.map(timeToIgnite);

    for (let i = 1; i < times.length; i++) {
      expect(
        times[i] as number,
        `${thicknesses[i]} m against ${thicknesses[i - 1]} m`,
      ).toBeGreaterThan(times[i - 1] as number);
    }

    const thinnest = times[0] as number;
    const thickest = times[times.length - 1] as number;
    expect(thinnest).toBeLessThan(35);
    expect(thickest / thinnest).toBeGreaterThan(10);
    /* And sub-linear: forty times the depth is nowhere near forty times the time. */
    expect(thickest / thinnest).toBeLessThan(40);
  });

  it('leaves a log’s core untouched while its surface chars, and a twig’s does not', () => {
    /*
     * The same fact with no threshold in it, and it is the one that reads on screen. At the moment
     * the surface passes 280 °C:
     *
     *      2 mm core 466.9 K       20 mm core 296.0 K
     *      5 mm core 366.4 K       80 mm core 293.2 K
     *
     * An eighty-millimetre log's core is five hundredths of a kelvin above the room while its
     * surface is charring. That is why a log has to be turned, why a thick steak needs resting, and
     * why a seared surface says nothing whatever about the middle.
     */
    const AREA = 0.01;
    const FLUX = 20000;
    const DT = 0.1;

    const coreWhenSurfaceReaches = (thickness: number, target: number): number => {
      const p = slab(thickness, AREA);
      for (let step = 0; step < 500000; step++) {
        parcels.addSurfaceHeat(p, FLUX * AREA * DT);
        parcels.conduct(p, DT);
        if (parcels.surfaceTemperatureOf(p) >= target) return parcels.coreTemperatureOf(p);
      }
      return Number.NaN;
    };

    const twig = coreWhenSurfaceReaches(0.002, 553.15);
    const log = coreWhenSurfaceReaches(0.08, 553.15);

    /* The twig follows its own surface most of the way up. */
    expect(twig).toBeGreaterThan(450);
    /* The log has not noticed. */
    expect(log).toBeLessThan(AMBIENT + 2);
    expect(twig - log).toBeGreaterThan(150);
  });
});

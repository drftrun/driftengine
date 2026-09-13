import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { STANDARD_AIR } from '../field/ambient.ts';
import { AtmosphereField } from '../field/atmosphere.ts';
import { type SmokeOptions, type SmokeTarget, emitSmoke, smokeColour } from './smoke.ts';

function target(capacity: number): SmokeTarget {
  return {
    positions: new Float32Array(capacity * 3),
    velocities: new Float32Array(capacity * 3),
    colors: new Float32Array(capacity * 3),
    alphas: new Float32Array(capacity),
    sizes: new Float32Array(capacity),
    ages: new Float32Array(capacity),
    seeds: new Float32Array(capacity),
    count: 0,
    capacity,
  };
}

function field(): AtmosphereField {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  return new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR, maxChunks: 1 });
}

const options: SmokeOptions = { threshold: 1e-8, size: 0.5, wind: 0 };

describe('smoke, which is the field made visible', () => {
  it('COLOURS A PLUME BY WHAT IS IN IT, and nothing chose a colour', () => {
    /*
     * `§17`: soot's albedo is about 0.03 and condensed water aerosol's is near one, so the ratio
     * between them **is** the colour. A green log steams white while a rich fire beside it smokes
     * black, and a fire doing both does both in the right places.
     */
    const out = new Float32Array(3);
    smokeColour(1e-5, 0, out);
    const sooty = out[0] as number;
    smokeColour(0, 1e-5, out);
    const steamy = out[0] as number;
    expect(sooty).toBeLessThan(0.1);
    expect(steamy).toBeGreaterThan(0.8);
    /* Half and half sits between them rather than at either end. */
    smokeColour(1e-5, 1e-5, out);
    expect(out[0] as number).toBeGreaterThan(sooty);
    expect(out[0] as number).toBeLessThan(steamy);
  });

  it('EMITS WHERE THERE IS SMOKE AND NOWHERE ELSE', () => {
    const air = field();
    const particles = target(64);
    /* Clean air puts nothing anywhere. */
    expect(emitSmoke(air, 0, 0, 0, 8, particles, options)).toBe(0);

    air.addSoot(2.5, 2.5, 2.5, 1e-5);
    const written = emitSmoke(air, 0, 0, 0, 8, particles, options);
    expect(written).toBe(1);
    expect(particles.count).toBe(1);
    /* At the centre of the cell it was found in. */
    expect(particles.positions[0]).toBeCloseTo(2.5, 5);
    expect(particles.positions[1]).toBeCloseTo(2.5, 5);
  });

  it('CARRIES A PARTICLE AT THE SPEED THE GAS CARRYING IT RISES', () => {
    /*
     * Not a chosen rate: the vertical component is the field's own `riseAt`, which is the same
     * function transport uses to move the gas. Heat the cell and the smoke in it goes up faster,
     * because the gas does.
     */
    const air = field();
    air.addSoot(2.5, 2.5, 2.5, 1e-5);
    const cold = target(64);
    emitSmoke(air, 0, 0, 0, 8, cold, options);
    const still = cold.velocities[1] as number;

    /*
     * Stepped after heating, and it has to be. CH-4's own finding: pressure is `n·T`, so heating a
     * cell changes no moles and therefore no density until transport lets it expand. A cell that has
     * been heated and not yet stepped is hot and exactly as heavy as it was.
     */
    air.addHeat(2.5, 2.5, 2.5, 400000);
    for (let i = 0; i < 10; i++) air.step(1 / 60);
    const hot = target(64);
    const written = emitSmoke(air, 0, 0, 0, 8, hot, options);

    /*
     * The *fastest* particle, not the first. Once the plume has run for a moment the soot is spread
     * over many cells and the first one the scan finds is a trace at the edge — which is genuinely
     * drifting slowly, and asserting on it would be asserting on the wrong cell.
     */
    let fastest = 0;
    for (let i = 0; i < written; i++) {
      const rise = hot.velocities[i * 3 + 1] as number;
      if (rise > fastest) fastest = rise;
    }
    expect(fastest).toBeGreaterThan(still);
    /* Measured at 2.4 m/s at the core of a 400 kJ plume, which is what a real one does. */
    expect(fastest).toBeGreaterThan(1);
  });

  it('takes opacity from extinction over the particle, not from a curve', () => {
    /* The same Koschmieder extinction `visibilityAt` is derived from, over the particle's own size.
       Thicker smoke is more opaque because there is more of it in the way. */
    const air = field();
    air.addSoot(2.5, 2.5, 2.5, 1e-6);
    const thin = target(8);
    emitSmoke(air, 0, 0, 0, 8, thin, options);

    air.addSoot(2.5, 2.5, 2.5, 1e-3);
    const thick = target(8);
    emitSmoke(air, 0, 0, 0, 8, thick, options);
    expect(thick.alphas[0] as number).toBeGreaterThan(thin.alphas[0] as number);
    expect(thick.alphas[0] as number).toBeLessThanOrEqual(1);
  });

  it("STOPS AT THE TARGET'S CAPACITY rather than writing past it", () => {
    const air = field();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) air.addSoot(x + 0.5, y + 0.5, 2.5, 1e-5);
    }
    const particles = target(4);
    expect(emitSmoke(air, 0, 0, 0, 8, particles, options)).toBe(4);
    expect(particles.count).toBe(4);
  });

  it('ALLOCATES NOTHING, because this runs every frame', async () => {
    /*
     * A small box, deliberately. The three windows have to be comparable in *duration* as well as in
     * what they do: the observer counts every collection in the isolate while it is open, so a quiet
     * loop that runs for a second catches a second of background rubbish and a floor loop that runs
     * for a millisecond catches none. That is not a measurement, it is a stopwatch.
     */
    const air = field();
    for (let x = 0; x < 2; x++) air.addSoot(x + 0.5, 0.5, 0.5, 1e-5);
    const particles = target(64);

    const collections = async (work: () => void): Promise<number> => {
      let n = 0;
      const observer = new PerformanceObserver((list) => {
        n += list.getEntries().length;
      });
      observer.observe({ entryTypes: ['gc'] });
      work();
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return n;
    };
    let sink: unknown;
    let sum = 0;
    const ROUNDS = 50000;
    for (let i = 0; i < ROUNDS; i++) emitSmoke(air, 0, 0, 0, 2, particles, options);
    for (let i = 0; i < ROUNDS; i++) sum += i;

    const floor = await collections(() => {
      for (let i = 0; i < ROUNDS; i++) sum += i;
    });
    const quiet = await collections(() => {
      for (let i = 0; i < ROUNDS; i++) emitSmoke(air, 0, 0, 0, 2, particles, options);
    });
    const noisy = await collections(() => {
      for (let i = 0; i < ROUNDS * 200; i++) sink = { at: i, of: [i] };
    });
    expect(noisy, 'the control must separate the two states').toBeGreaterThan(30);
    expect(floor, 'a loop that cannot allocate sets the floor').toBeLessThan(noisy / 8);
    expect(quiet, 'emitting must sit at that floor').toBeLessThan(noisy / 8);
    expect(sink).not.toBe(undefined);
    expect(sum).toBeGreaterThan(0);
  }, 60000);
});

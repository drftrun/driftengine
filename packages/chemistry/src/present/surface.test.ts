import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ParcelStore } from '../parcel/store.ts';
import { installLibrary } from '../library/library.ts';
import { ORGANIC } from '../library/organic.ts';
import { MINERAL } from '../library/mineral.ts';
import { type SurfaceTarget, writeSurface } from './surface.ts';

function surface(capacity: number): SurfaceTarget {
  return {
    albedos: new Float32Array(capacity * 3),
    emissives: new Float32Array(capacity * 3),
    roughness: new Float32Array(capacity),
    scales: new Float32Array(capacity),
    count: 0,
  };
}

describe('what a burning thing looks like', () => {
  let species: SpeciesRegistry;
  let substances: SubstanceRegistry;
  let parcels: ParcelStore;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
    const reactions = new ReactionRegistry(species);
    substances = new SubstanceRegistry(species, reactions);
    installLibrary(ORGANIC, species, reactions, substances);
    installLibrary(MINERAL, species, reactions, substances);
    parcels = new ParcelStore(substances);
  });

  const spawn = (id: string, mass = 2, temperature = 293.15): number =>
    parcels.spawn({ substance: substances.indexOf(id), mass, temperature, area: 0.5 });

  it("starts at the substance's own albedo, unchanged", () => {
    const log = spawn('oak');
    const out = surface(4);
    writeSurface(parcels, [log], out);
    expect(out.albedos[0]).toBeCloseTo(0.32, 4);
    expect(out.albedos[1]).toBeCloseTo(0.22, 4);
    expect(out.scales[0]).toBeCloseTo(1, 5);
  });

  it('DARKENS AS IT CHARS, over the time the pyrolysis takes', () => {
    /*
     * `§17`: wood goes brown, then dark brown, then black, in the order and over the time the
     * pyrolysis does. The lerp is by char fraction and nothing anywhere schedules it.
     */
    const log = spawn('oak');
    const char = species.indexOf('C(char)');
    const cellulose = species.indexOf('cellulose');
    const out = surface(4);

    const held = parcels.speciesMassOf(log, 0, cellulose);
    parcels.addSpeciesMass(log, 0, cellulose, -held);
    parcels.addSpeciesMass(log, 0, char, held);
    writeSurface(parcels, [log], out);
    const partly = out.albedos[0] as number;
    expect(partly).toBeLessThan(0.32);
    expect(partly).toBeGreaterThan(0.03);

    /* Char the rest of it and it reaches the substance's own char albedo, not a chosen black. */
    for (let shell = 0; shell < parcels.shellCount(log); shell++) {
      for (const id of ['cellulose', 'hemicellulose', 'lignin', 'extractives', 'H2O(l)', 'ash']) {
        const s = species.indexOf(id);
        const mass = parcels.speciesMassOf(log, shell, s);
        if (mass > 0) {
          parcels.addSpeciesMass(log, shell, s, -mass);
          parcels.addSpeciesMass(log, shell, char, mass);
        }
      }
    }
    writeSurface(parcels, [log], out);
    expect(out.albedos[0]).toBeCloseTo(0.03, 3);
  });

  it('GLOWS ONLY WHEN IT IS ACTUALLY HOT, and the colour is its temperature', () => {
    const log = spawn('oak');
    const out = surface(4);
    writeSurface(parcels, [log], out);
    expect(out.emissives[0]).toBe(0);

    parcels.setTemperature(log, 1100);
    writeSurface(parcels, [log], out);
    expect(out.emissives[0] as number).toBeGreaterThan(0);
    /* Red-dominant at 1,100 K, which is what a blackbody at 1,100 K is. */
    expect(out.emissives[0] as number).toBeGreaterThan(out.emissives[2] as number);
  });

  it('SHRINKS AS MASS LEAVES, which is the tell a fire is not a decal', () => {
    /*
     * `§17`: a log that burns for ten minutes and stays the same size gives the whole thing away.
     * Written as a scale factor — the **cube root** of the volume ratio, because a scale is linear
     * and a volume is not.
     */
    const log = spawn('oak', 8);
    const out = surface(4);
    writeSurface(parcels, [log], out);
    expect(out.scales[0]).toBeCloseTo(1, 5);

    /* Take half the mass away as gas would. */
    for (let shell = 0; shell < parcels.shellCount(log); shell++) {
      for (const id of ['cellulose', 'hemicellulose', 'lignin']) {
        const s = species.indexOf(id);
        const mass = parcels.speciesMassOf(log, shell, s);
        parcels.addSpeciesMass(log, shell, s, -mass * 0.68);
      }
    }
    writeSurface(parcels, [log], out);
    /* Half the mass is 0.79 of the size, which is the cube root of a half. */
    expect(out.scales[0] as number).toBeLessThan(0.95);
    expect(out.scales[0] as number).toBeGreaterThan(0.7);
  });

  it('DRIVES WET-FILM ROUGHNESS FROM THE SAME NUMBER THAT RESISTS IGNITION', () => {
    /*
     * `§17` calls this "the kind of coherence this track exists for": rain makes a thing look wet
     * and makes it harder to light, and it is one quantity doing both. A dry log is at its
     * substance's roughness; a soaked one is glossy.
     */
    const log = spawn('oak');
    const out = surface(4);
    writeSurface(parcels, [log], out);
    const dry = out.roughness[0] as number;

    parcels.wet(log, 0.2);
    writeSurface(parcels, [log], out);
    expect(out.roughness[0] as number).toBeLessThan(dry);
  });

  it('WRITES NOTHING FOR A SUBSTANCE NOBODY DESCRIBED, rather than grey', () => {
    /*
     * A substance with no `appearance` is one the consumer owns the look of, and quietly recolouring
     * it would be the engine overwriting an artist. The scale and the emissive are still written,
     * because both are physics rather than art.
     */
    const stone = substances.define({
      id: 'plain-stone',
      composition:
        parcels.substanceOf(spawn('limestone')) >= 0
          ? substances.definitionOf(substances.indexOf('limestone')).composition
          : substances.definitionOf(0).composition,
      density: 2600,
      conductivity: { k0: 2, k1: 0 },
    });
    const p = parcels.spawn({ substance: stone, mass: 5, temperature: 293.15, area: 1 });
    const out = surface(4);
    out.albedos[0] = 0.7;
    writeSurface(parcels, [p], out);
    expect(out.albedos[0]).toBeCloseTo(0.7, 6);
    expect(out.scales[0]).toBeCloseTo(1, 5);
  });
});

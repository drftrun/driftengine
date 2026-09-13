import { describe, expect, it } from 'vitest';
import { ORGANIC } from '../library/organic.ts';
import {
  flameHeight,
  installChemistry,
  parcelFromBounds,
  smokeColour,
  writeSurface,
} from './index.ts';
import type { InstalledChemistry, SurfaceTarget } from './index.ts';

function surfaces(capacity: number): SurfaceTarget {
  return {
    albedos: new Float32Array(capacity * 3),
    emissives: new Float32Array(capacity * 3),
    roughness: new Float32Array(capacity),
    scales: new Float32Array(capacity),
    count: 0,
  };
}

/**
 * `§24`'s hearth, as numbers.
 *
 * The design's exit test is a demo scene, and what a demo can assert is that it looks right. This is
 * the half a test can hold: **the same scene, driven the same way, checked on the quantities a
 * renderer would draw**. If the log never darkens, never glows and never smokes, the demo would show
 * a fire that is a decal, and this is where that is caught.
 */
describe('a hearth, end to end', () => {
  it('DARKENS, GLOWS AND SMOKES, from one installed library and one radiating source', () => {
    /*
     * One chunk of air and a thin log, deliberately. What is being asserted is that the six mappings
     * read a real simulation rather than a mock — and a thicker log or a wider field would assert
     * the same thing after ten times the wall clock, which is a slower test rather than a better one.
     * `ignition/timeline.test.ts` is where the thickness is load-bearing.
     */
    const chem = installChemistry({ libraries: [ORGANIC], maxChunks: 1 });
    const box = parcelFromBounds(0.02, 0.02, 0.3, 700);
    const log = chem.parcels.spawn({
      substance: chem.substances.indexOf('oak'),
      mass: box.mass,
      temperature: 293.15,
      area: box.area,
      x: 1.5,
      y: 1.5,
      z: 1.5,
    });

    const look = surfaces(4);
    writeSurface(chem.parcels, [log], look);
    const startAlbedo = look.albedos[0] as number;
    expect(look.emissives[0]).toBe(0);
    expect(look.scales[0]).toBeCloseTo(1, 5);

    let glowedAt = -1;
    const DT = 0.25;
    for (let step = 0; step < 1400 && glowedAt < 0; step++) {
      chem.world.sources.clear();
      /* A bed of embers a hand's width away: 0.1 m² at 1,300 K. */
      chem.world.sources.add(1.2, 1.5, 1.5, 1300, 0.1, 60000);
      chem.world.contacts.clear();
      chem.parcels.ignite(log);
      chem.world.simulate(DT, 0.2, 0);

      writeSurface(chem.parcels, [log], look);
      if ((look.emissives[0] as number) > 0) glowedAt = step;
    }

    expect(glowedAt).toBeGreaterThanOrEqual(0);
    writeSurface(chem.parcels, [log], look);
    /* Darker than it started, because char is dark and there is char on it now. */
    expect(look.albedos[0] as number).toBeLessThan(startAlbedo);
    /* Glowing, red-dominant, because a surface at this temperature is. */
    expect(look.emissives[0] as number).toBeGreaterThan(look.emissives[2] as number);
    /* And smaller, because mass left as gas. A fire that is a decal fails here. */
    expect(look.scales[0] as number).toBeLessThan(1);

    /*
     * **The volatiles it gave off really reached the air**, which is the coupling `writeSurface`
     * cannot see. What they do next is the cell's business.
     */
    expect(chem.air.speciesMassAt(1.5, 1.5, 1.5, chem.species.indexOf('CO'))).toBeGreaterThan(0);

    /* And the flame over it is as tall as its own output says, with nothing tuned. */
    expect(flameHeight(chem.parcels.heatReleaseOf(log) / 1000, 0.1)).toBeGreaterThanOrEqual(0);
  }, 300000);

  it("TURNS A HOT RICH CELL'S VOLATILES INTO SOOT, which is what makes smoke black", () => {
    /*
     * **The smoke half, driven where the smoke half happens: in the air.** `§8.4` says a flame
     * soots when it is rich and does not when it is lean, and there is **no gate on the equivalence
     * ratio anywhere** — soot formation needs no oxygen and oxidation needs plenty, so in a cell
     * with air the oxidation wins and in one that has run out this is the only path left.
     *
     * Driven with a hot cell rather than with a fire that heats one, and that is the honest split: a
     * plume hot enough to soot is a flame's doing, and standing one up costs the whole of
     * `ignition/timeline.test.ts`'s budget again with the field on top. What is asserted here is the
     * chemistry — that carbon leaves the gas and becomes soot — and it is asserted **as a species**,
     * so `elementTotals` still balances over it.
     */
    const chem = installChemistry({ libraries: [ORGANIC], maxChunks: 1 });
    const tar = chem.species.indexOf('tar');
    const soot = chem.species.indexOf('C(soot)');
    /* A rich, hot cell: plenty of fuel and the oxygen already spent. */
    chem.air.addSpecies(1.5, 1.5, 1.5, tar, 0.02);
    chem.air.addSpecies(1.5, 1.5, 1.5, chem.species.indexOf('O2'), -0.28);
    chem.air.addHeat(1.5, 1.5, 1.5, 1.2e6);

    expect(chem.air.sootAt(1.5, 1.5, 1.5)).toBe(0);
    for (let i = 0; i < 200; i++) chem.air.step(1 / 60);

    expect(chem.air.speciesMassAt(1.5, 1.5, 1.5, soot)).toBeGreaterThan(0);
    /* And `sootAt` sees it, which is what `emitSmoke` and `visibilityAt` are reading. */
    expect(chem.air.sootAt(1.5, 1.5, 1.5)).toBeGreaterThan(0);
    /* It is genuinely darker to look through than clean air was. */
    expect(chem.air.visibilityAt(1.5, 1.5, 1.5)).toBeLessThan(10000);
  }, 60000);

  it("TURNS A COOL CELL'S VOLATILES INTO DROPLETS, which is what makes a smoulder's smoke pale", () => {
    /*
     * **The other half of what smoke is, and the same cell decides both.** The test above puts tar
     * in a hot cell and gets soot. This puts the identical tar in a cool one and gets an aerosol,
     * and **nothing arbitrates between them**: cracking to soot and burning both climb with
     * temperature, and the dew point is a gate that closes with it. A flaming fire is above 1,200 K
     * where the gate is shut, a smouldering one is a few hundred where it is open, and neither the
     * word "flaming" nor the word "smouldering" appears in the model.
     *
     * Held at a temperature rather than lit, for the reason the soot test gives about itself: a
     * plume standing at a temperature is a fire's doing and standing one up costs the whole of
     * `ignition/timeline.test.ts` again. What is asserted here is the chemistry.
     *
     * **The tar that condenses stays inside the element ledger**, because it condenses into a
     * *species* rather than into the aerosol channel — which is why the third assertion below is
     * about `elementTotals` and not about a number going up.
     */
    const held = (kelvin: number): InstalledChemistry => {
      const chem = installChemistry({ libraries: [ORGANIC], maxChunks: 1 });
      /* Sealed, so what is measured is what reacted rather than what drifted off. */
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          for (let z = 0; z < 8; z++) {
            if (x !== 1 || y !== 1 || z !== 1) chem.air.setBlocked(x + 0.5, y + 0.5, z + 0.5, true);
          }
        }
      }
      chem.air.addSpecies(1.5, 1.5, 1.5, chem.species.indexOf('tar'), 0.02);
      /* Oxygen already spent, as it is at a smouldering surface and in a rich flame alike. */
      chem.air.addSpecies(1.5, 1.5, 1.5, chem.species.indexOf('O2'), -0.28);
      for (let i = 0; i < 200; i++) {
        const now = chem.air.temperatureAt(1.5, 1.5, 1.5);
        /* A cubic metre of air is about 1,300 J/K, so this is a thermostat rather than a source. */
        if (now < kelvin) chem.air.addHeat(1.5, 1.5, 1.5, (kelvin - now) * 1300);
        chem.air.step(1 / 60);
      }
      return chem;
    };

    const smoulder = held(400);
    const flame = held(1400);
    const condensed = smoulder.air.speciesMassAt(1.5, 1.5, 1.5, smoulder.species.indexOf('tar(l)'));

    /* Most of it is droplets now, and none of it is soot. */
    expect(condensed).toBeGreaterThan(0.5 * 0.02);
    expect(smoulder.air.sootAt(1.5, 1.5, 1.5)).toBeLessThan(1e-9);
    /* And `aerosolAt` sees it, without the field ever naming a species this library invented. */
    expect(smoulder.air.aerosolAt(1.5, 1.5, 1.5)).toBeGreaterThanOrEqual(condensed);

    /* The flame did the opposite with the same tar: soot, and not one droplet. */
    expect(flame.air.sootAt(1.5, 1.5, 1.5)).toBeGreaterThan(0.5 * 0.02 * (72 / 162.14));
    expect(flame.air.aerosolAt(1.5, 1.5, 1.5)).toBe(0);

    /*
     * **So the two read opposite colours**, which is the whole row: soot is near-black at an albedo
     * of 0.03 and a droplet is near-white at 0.92, and `§17` colours a plume from the ratio. Neither
     * number was chosen for a fire — they are what the two materials reflect.
     */
    const pale = new Float32Array(3);
    const black = new Float32Array(3);
    smokeColour(smoulder.air.sootAt(1.5, 1.5, 1.5), smoulder.air.aerosolAt(1.5, 1.5, 1.5), pale);
    smokeColour(flame.air.sootAt(1.5, 1.5, 1.5), flame.air.aerosolAt(1.5, 1.5, 1.5), black);
    expect(pale[0] as number).toBeGreaterThan(0.8);
    expect(black[0] as number).toBeLessThan(0.1);
  }, 120000);

  it('and the droplets go back to vapour over a fire, so a plume that is drawn back in darkens', () => {
    /*
     * **A one-way condensation is a sink and that is the bug this exists to prevent.** Aerosol
     * carried back over a flame — which is what the edge of any plume does — would stay pale
     * forever, so a fire would slowly wrap itself in white smoke that nothing could burn off.
     *
     * `evaporate-tar` is the same transition read upward, sharing the dew point and the band, so
     * what is asserted is that the pair is an equilibrium: heat the droplets and they are tar again,
     * and the tar then does what tar in a hot cell does.
     */
    const chem = installChemistry({ libraries: [ORGANIC], maxChunks: 1 });
    const condensedTar = chem.species.indexOf('tar(l)');
    chem.air.addSpecies(1.5, 1.5, 1.5, condensedTar, 0.02);
    expect(chem.air.aerosolAt(1.5, 1.5, 1.5)).toBeCloseTo(0.02, 9);

    chem.air.addHeat(1.5, 1.5, 1.5, 1.6e6);
    for (let i = 0; i < 200; i++) chem.air.step(1 / 60);

    expect(chem.air.speciesMassAt(1.5, 1.5, 1.5, condensedTar)).toBeLessThan(0.5 * 0.02);
    expect(chem.air.sootAt(1.5, 1.5, 1.5)).toBeGreaterThan(0);
  }, 60000);
});

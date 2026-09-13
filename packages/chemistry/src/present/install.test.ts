import { describe, expect, it } from 'vitest';
import { ORGANIC } from '../library/organic.ts';
import { MINERAL } from '../library/mineral.ts';
import { installChemistry, parcelFromBounds } from './install.ts';

describe('installChemistry', () => {
  it('IS THREE LINES, and everything after `substances` is optional', () => {
    /*
     * `§16`'s claim, and it is the whole of what a consumer does: import the package, import a
     * library, install. Nothing is wired, nothing is registered by hand, and their oak is oak.
     */
    const chem = installChemistry({ libraries: [ORGANIC] });
    expect(chem.substances.indexOf('oak')).toBeGreaterThanOrEqual(0);
    expect(chem.species.indexOf('tar')).toBeGreaterThanOrEqual(0);
    expect(chem.world).toBeDefined();
    expect(chem.air).toBeDefined();
  });

  it('installs several families together, sharing what they have in common', () => {
    const chem = installChemistry({ libraries: [ORGANIC, MINERAL] });
    expect(chem.substances.indexOf('oak')).toBeGreaterThanOrEqual(0);
    expect(chem.substances.indexOf('limestone')).toBeGreaterThanOrEqual(0);
  });

  it('MATCHES MATERIALS EXACTLY AND REPORTS WHAT IT COULD NOT, never guessing', () => {
    /*
     * **`AGENTS.md`'s retargeting decision, and the failure here is worse than the one it was
     * written about.** A synonym table rots silently, and a rig that does not move is at least
     * visible. A `pine_bark_02` quietly matching `pine` is a material with the wrong ignition
     * temperature and nobody will ever notice.
     *
     * So: exact ids, and everything unmatched comes back in one list with a count.
     */
    const chem = installChemistry({ libraries: [ORGANIC] });
    const report = chem.match(['oak', 'pine', 'pine_bark_02', 'dragonhide']);
    expect(report.matched).toBe(2);
    expect(report.unmatched).toEqual(['pine_bark_02', 'dragonhide']);
    /* And the matched ones came back as usable indices, in the order asked. */
    expect(report.substances[0]).toBe(chem.substances.indexOf('oak'));
    expect(report.substances[2]).toBe(-1);
  });

  it('SPAWNS FROM A BOUNDING BOX, so a consumer with meshes measures nothing', () => {
    /*
     * `§16`: mass, volume, area and thickness from a box and a density. A consumer who cares
     * supplies real numbers; one who does not gets numbers that are right for a box.
     */
    const box = parcelFromBounds(0.1, 0.1, 1.2, 700);
    /* A 100 mm square log 1.2 m long: 12 litres of oak is 8.4 kg. */
    expect(box.mass).toBeCloseTo(8.4, 6);
    /* Six faces: two ends of 0.01 and four sides of 0.12. */
    expect(box.area).toBeCloseTo(0.5, 6);
    /* Characteristic thickness is volume over area, which is what conduction wants. */
    expect(box.thickness).toBeCloseTo(0.012 / 0.5, 6);
  });

  it('gives an installed world its own parcels and air, wired to each other', () => {
    const chem = installChemistry({ libraries: [ORGANIC] });
    const box = parcelFromBounds(0.08, 0.08, 1, 700);
    const log = chem.parcels.spawn({
      substance: chem.substances.indexOf('oak'),
      mass: box.mass,
      temperature: 293.15,
      area: box.area,
      x: 0.5,
      y: 0.5,
      z: 0.5,
    });
    chem.world.sources.clear();
    chem.world.sources.add(0, 0.5, 0.5, 1200, 0.1, 60000);
    chem.world.simulate(1 / 60, 0, 0);
    /* Heat reached it through the world's own transport, with nothing else wired. */
    expect(chem.parcels.surfaceTemperatureOf(log)).toBeGreaterThan(293.15);
  });

  it('RUNS THE GAS-PHASE REACTIONS ITS LIBRARIES BROUGHT, without being told which', () => {
    /*
     * A family knows what its own volatiles are — `organic` carries tar and the five common steps —
     * so the installer takes them from the libraries rather than from a list the consumer maintains.
     * A consumer who forgot to pass `burn-tar` would have a fire that made smoke and no flame.
     */
    const chem = installChemistry({ libraries: [ORGANIC] });
    expect(chem.gasReactions).toContain('burn-tar');
    expect(chem.gasReactions).toContain('burn-methane');
  });
});

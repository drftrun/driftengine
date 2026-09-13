import { describe, expect, it } from 'vitest';
import {
  BLOW_OFF_SPEED,
  EXTINCT_BLOWN_OFF,
  EXTINCT_COOLED,
  EXTINCT_FUEL,
  EXTINCT_NONE,
  EXTINCT_OXYGEN,
  type IgnitionModel,
  extinguishes,
  ignitionProgress,
  ignites,
  smoulders,
  surfaceFuelFraction,
} from './criteria.ts';

/** Oak: 350 °C piloted, 500 °C auto, 3.5 g/m²·s. */
const OAK: IgnitionModel = {
  pilotedSurfaceK: 623,
  autoSurfaceK: 773,
  criticalMassFlux: 0.0035,
};

/** A dry surface: everything coming off it can burn. */
const READY = { flux: 0.05, oxygen: 0.209, still: 0 };

describe('ignites', () => {
  it('catches when all five hold', () => {
    expect(ignites(OAK, 700, READY.flux, READY.flux, READY.oxygen, READY.still, true)).toBe(true);
  });

  it('REFUSES A MATCH HELD TO A COLD SURFACE', () => {
    /*
     * `§11`: `ignite` supplies a pilot and does not start a fire. Holding a match to wet wood does
     * exactly nothing, which is correct and is the API telling the truth about what a match is.
     */
    expect(ignites(OAK, 400, READY.flux, READY.flux, READY.oxygen, READY.still, true)).toBe(false);
  });

  it('refuses a hot surface that is not giving off enough to burn', () => {
    /* The mass flux is the real criterion. A surface can be well past its ignition temperature and
       still not be producing a flammable mixture — which is exactly what wet wood does. */
    expect(ignites(OAK, 700, 0.001, 0.001, READY.oxygen, READY.still, true)).toBe(false);
  });

  it('needs a pilot below the autoignition temperature and not above it', () => {
    /* The 150 K between 623 and 773 is the whole reason a spark matters. */
    expect(ignites(OAK, 700, READY.flux, READY.flux, READY.oxygen, READY.still, false)).toBe(false);
    expect(ignites(OAK, 800, READY.flux, READY.flux, READY.oxygen, READY.still, false)).toBe(true);
  });

  it('refuses air below the limiting oxygen index', () => {
    expect(ignites(OAK, 700, READY.flux, READY.flux, 0.12, READY.still, true)).toBe(false);
  });

  it('refuses a mixture a wind has thinned below its lower limit', () => {
    /*
     * The mixture is read **at the surface** rather than in the room, from the flux against what is
     * sweeping past it. A gale over a weak flux is lean, which is the same mechanism that blows a
     * flame off, arriving here too and for the same reason.
     */
    expect(ignites(OAK, 700, 0.004, 0.004, READY.oxygen, 0, true)).toBe(true);
    expect(ignites(OAK, 700, 0.004, 0.004, READY.oxygen, 30, true)).toBe(false);
  });
});

describe('ignitionProgress', () => {
  it('is zero for cold wood and one for wood that is ready', () => {
    expect(ignitionProgress(OAK, 293.15, 0, 0.209, true)).toBe(0);
    expect(ignitionProgress(OAK, 700, 0.01, 0.209, true)).toBe(1);
  });

  it('reads the nearest thing to ready that everything is', () => {
    /* Hot enough and airy enough, but nothing coming off it: the readout says so rather than
       averaging the shortfall away. */
    const stuck = ignitionProgress(OAK, 623, 0.00035, 0.209, true);
    expect(stuck).toBeCloseTo(0.1, 6);
  });

  it('rises as a surface heats', () => {
    let previous = -1;
    for (const t of [300, 400, 500, 560, 600, 623]) {
      const now = ignitionProgress(OAK, t, 0.01, 0.209, true);
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
  });

  it('is harder to satisfy with no pilot, because the bar is higher', () => {
    expect(ignitionProgress(OAK, 650, 0.01, 0.209, false)).toBeLessThan(
      ignitionProgress(OAK, 650, 0.01, 0.209, true),
    );
  });
});

describe('extinguishes', () => {
  it('keeps burning while everything holds', () => {
    expect(extinguishes(OAK, 0.01, 0.209, 700, 0)).toBe(EXTINCT_NONE);
  });

  it('goes out when the fuel runs out', () => {
    expect(extinguishes(OAK, 0.0001, 0.209, 700, 0)).toBe(EXTINCT_FUEL);
  });

  it('goes out below the limiting oxygen index', () => {
    expect(extinguishes(OAK, 0.01, 0.1, 700, 0)).toBe(EXTINCT_OXYGEN);
  });

  it('goes out when the surface has cooled below what feeds it', () => {
    expect(extinguishes(OAK, 0.01, 0.209, 500, 0)).toBe(EXTINCT_COOLED);
  });

  it('BLOWS OUT LIKE A CANDLE in a fast enough gas', () => {
    /* And embers do not, which is the point: there is no flame to blow off and more oxygen
       arrives. `smoulders` has no speed term at all. */
    expect(extinguishes(OAK, 0.01, 0.209, 700, BLOW_OFF_SPEED + 1)).toBe(EXTINCT_BLOWN_OFF);
    expect(smoulders(OAK, 0.3, 0.209, 900)).toBe(true);
  });
});

describe('smoulders', () => {
  it('needs char, and will not start without it', () => {
    expect(smoulders(OAK, 0, 0.209, 900)).toBe(false);
    expect(smoulders(OAK, 0.2, 0.209, 900)).toBe(true);
  });

  it('SURVIVES AIR A FLAME CANNOT', () => {
    /*
     * A flame goes out below about 14% oxygen; a smoulder persists to about 5%, because there is no
     * gas-phase flame at all — oxygen meets solid carbon at the surface. That is why smothering a
     * fire leaves embers, and why the smoulder is the half that reignites a room.
     */
    expect(extinguishes(OAK, 0.01, 0.08, 900, 0)).toBe(EXTINCT_OXYGEN);
    expect(smoulders(OAK, 0.3, 0.08, 900)).toBe(true);
    /* Below its own index, even that stops. */
    expect(smoulders(OAK, 0.3, 0.03, 900)).toBe(false);
  });

  it('needs a surface still hot enough to keep the reaction going', () => {
    expect(smoulders(OAK, 0.3, 0.209, 400)).toBe(false);
  });
});

describe('surfaceFuelFraction', () => {
  it('is rich for a strong flux and lean for a weak one', () => {
    expect(surfaceFuelFraction(1, 1, 0)).toBeGreaterThan(0.9);
    expect(surfaceFuelFraction(1e-5, 1e-5, 0)).toBeLessThan(0.01);
  });

  it('thins in a wind, which is why a gale makes a fire harder to start', () => {
    expect(surfaceFuelFraction(0.01, 0.01, 20)).toBeLessThan(surfaceFuelFraction(0.01, 0.01, 0));
  });

  it('is never negative and never above one', () => {
    for (const flux of [0, 1e-6, 0.01, 10]) {
      for (const speed of [0, 1, 50]) {
        const f = surfaceFuelFraction(flux, flux, speed);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
  });

  it('A WET SURFACE IS LEAN, because the steam counts against it', () => {
    /*
     * `§21`'s mechanism, and the one the timeline test caught missing: steam leaving a wet surface
     * dilutes the gas above it. Same fuel coming off, ten times as much total gas, and the mixture
     * drops below its lower limit — which is why a green log will not catch in front of a fire that
     * lights a seasoned one in eighty seconds.
     */
    const dryish = surfaceFuelFraction(0.004, 0.004, 0);
    const steaming = surfaceFuelFraction(0.004, 0.04, 0);
    expect(steaming).toBeLessThan(dryish);
    expect(ignites(OAK, 700, 0.004, 0.004, 0.209, 0, true)).toBe(true);
    expect(ignites(OAK, 700, 0.004, 0.4, 0.209, 0, true)).toBe(false);
  });
});

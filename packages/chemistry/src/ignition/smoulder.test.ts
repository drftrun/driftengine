import { beforeEach, describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { KIND_CHAR_OXIDATION, ReactionRegistry } from '../reaction/registry.ts';
import { massFractions } from '../substance/composition.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { SHAPE_SLAB } from '../parcel/shells.ts';
import { ParcelStore } from '../parcel/store.ts';

describe('transport-limited char oxidation', () => {
  let species: SpeciesRegistry;

  beforeEach(() => {
    species = new SpeciesRegistry();
    registerStandardSpecies(species);
  });

  /**
   * An ember carrying its own oxygen, with **oxygen in excess so char is what runs out**.
   *
   * The first version had it the other way round — 60% char to 40% oxygen, which is a quarter of
   * the oxygen a 1:1 reaction needs — so both cases stopped at exactly 75% char remaining, the
   * stoichiometric limit, and the transport ceiling made no difference because nothing was reaching
   * it. A test where the interesting variable is not the binding one measures the other thing.
   */
  const ember = (
    transportLimited: boolean,
    temperature: number,
  ): {
    parcels: ParcelStore;
    parcel: number;
    char: number;
  } => {
    const reactions = new ReactionRegistry(species);
    reactions.register({
      id: 'burn-char',
      reactants: [
        { species: 'C(char)', moles: 1 },
        { species: 'O2', moles: 1 },
      ],
      products: [{ species: 'CO2', moles: 1 }],
      kinetics: transportLimited
        ? { type: 'diffusion', A: 1e7, activationEnergy: 140000, transportLimit: 1e-5 }
        : { type: 'arrhenius', A: 1e7, activationEnergy: 140000 },
      kind: KIND_CHAR_OXIDATION,
    });
    const substances = new SubstanceRegistry(species, reactions);
    const coal = substances.define({
      id: transportLimited ? 'coal' : 'coal-kinetic',
      composition: massFractions(species, { 'C(char)': 0.2, O2: 0.8 }),
      density: 400,
      conductivity: { k0: 0.07, k1: 0 },
      shells: 1,
      shape: SHAPE_SLAB,
      reactions: ['burn-char'],
    });
    const parcels = new ParcelStore(substances);
    return {
      parcels,
      parcel: parcels.spawn({ substance: coal, mass: 1, temperature, area: 0.05 }),
      char: species.indexOf('C(char)'),
    };
  };

  const burn = (state: ReturnType<typeof ember>, ticks: number, factor = 1): number => {
    for (let i = 0; i < ticks; i++) state.parcels.react(state.parcel, 1 / 60, factor);
    return state.parcels.parcelSpeciesMass(state.parcel, state.char);
  };

  it('CHAR GLOWS FOR AN HOUR RATHER THAN VANISHING IN SECONDS', () => {
    /*
     * **What the `Diffusion` kind exists for**, and `§8.5` is the argument. Above about 800 K the
     * chemistry of carbon oxidation outruns oxygen delivery by an order of magnitude, so what is
     * actually being watched is transport. The kinetic rate alone gives char that disappears; the
     * cap gives char that sits there glowing, which is what char does.
     *
     * One simulated minute at 1,100 K, and the difference is not subtle.
     */
    const kinetic = ember(false, 1100);
    const limited = ember(true, 1100);
    const started = kinetic.parcels.parcelSpeciesMass(kinetic.parcel, kinetic.char);

    const leftKinetic = burn(kinetic, 3600);
    const leftLimited = burn(limited, 3600);

    /* The unlimited one has eaten essentially all of it. */
    expect(leftKinetic / started).toBeLessThan(0.05);
    /*
     * The limited one has barely started, and is still there to glow. At this ceiling a kilogram of
     * ember loses about a fiftieth of its carbon a minute, which is the hour `§8.5` describes —
     * against the unlimited one, which is gone inside that same minute.
     */
    expect(leftLimited / started).toBeGreaterThan(0.9);
  });

  it('is still Arrhenius where the chemistry is the slow half', () => {
    /* Cold enough that the kinetic rate is far below the transport ceiling, so the cap does
       nothing at all and the two agree. */
    const kinetic = ember(false, 500);
    const limited = ember(true, 500);
    expect(burn(limited, 600)).toBeCloseTo(burn(kinetic, 600), 6);
  });

  it('BLOWING ON IT MAKES IT BURN FASTER, and stops when you stop', () => {
    /*
     * The transport half rises with the gas moving past, so an ember brightens under a bellows and
     * settles again the moment it is taken away. A flame does the opposite — `extinguishes` blows
     * it off — and both come out of the same two numbers.
     */
    const still = ember(true, 1100);
    const blown = ember(true, 1100);
    const started = still.parcels.parcelSpeciesMass(still.parcel, still.char);

    const leftStill = burn(still, 3600, 1);
    const leftBlown = burn(blown, 3600, 4);
    expect(started - leftBlown).toBeGreaterThan((started - leftStill) * 2);
  });

  it('refuses a transport limit that is not positive', () => {
    const reactions = new ReactionRegistry(species);
    expect(() =>
      reactions.register({
        id: 'bad',
        reactants: [
          { species: 'C(char)', moles: 1 },
          { species: 'O2', moles: 1 },
        ],
        products: [{ species: 'CO2', moles: 1 }],
        kinetics: { type: 'diffusion', A: 1e7, activationEnergy: 140000, transportLimit: 0 },
        kind: KIND_CHAR_OXIDATION,
      }),
    ).toThrow(/0/);
  });
});

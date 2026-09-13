import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { ParcelStore } from '../parcel/store.ts';
import { AtmosphereField } from '../field/atmosphere.ts';
import { STANDARD_AIR } from '../field/ambient.ts';
import { ChemistryWorld } from '../transport/world.ts';
import { installLibrary } from '../library/library.ts';
import { ORGANIC } from '../library/organic.ts';
import { MINERAL } from '../library/mineral.ts';
import { fingerprintChemistry } from './fingerprint.ts';

/** A world, optionally with its parcels spawned in the other order or a second library installed. */
function world(reversed = false, extra = false): ChemistryWorld {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(ORGANIC, species, reactions, substances);
  if (extra) installLibrary(MINERAL, species, reactions, substances);

  const parcels = new ParcelStore(substances);
  const air = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR, maxChunks: 1 });
  const built = new ChemistryWorld(parcels, air);

  const oak = substances.indexOf('oak');
  const pine = substances.indexOf('pine');
  const spec = (substance: number, x: number) => ({
    substance,
    mass: 2,
    temperature: 293.15,
    area: 0.3,
    x,
    y: 0.5,
    z: 0.5,
  });
  if (reversed) {
    parcels.spawn(spec(pine, 1.5));
    parcels.spawn(spec(oak, 0.5));
  } else {
    parcels.spawn(spec(oak, 0.5));
    parcels.spawn(spec(pine, 1.5));
  }
  return built;
}

function run(w: ChemistryWorld, ticks: number): string {
  for (let i = 0; i < ticks; i++) {
    w.sources.clear();
    w.sources.add(0, 0.5, 0.5, 1200, 0.1, 60000);
    w.contacts.clear();
    w.simulate(0.25, 0.2, 0);
  }
  return fingerprintChemistry(w);
}

describe('fingerprintChemistry', () => {
  it('IS THE SAME FOR TWO RUNS OF THE SAME WORLD', () => {
    /*
     * The whole point. `§15` lists four things that make determinism a property rather than a hope,
     * and three of them already held — no transcendental on a tick, a proportional clamp that does
     * not depend on registration order, `Float64Array` throughout. Without this function those three
     * are claims about the code rather than assertions about its output.
     */
    expect(run(world(), 40)).toBe(run(world(), 40));
  });

  it('CHANGES WHEN THE STATE CHANGES, which is what makes agreement mean anything', () => {
    /* A hash that agreed with everything would agree with the test above for the wrong reason. */
    expect(run(world(), 40)).not.toBe(run(world(), 41));
  });

  it('COVERS THE SUBSTANCE REGISTRY, so two libraries are two worlds', () => {
    /*
     * `§15`: "a consumer-registered substance changes the fingerprint, and it must." Two worlds with
     * different libraries are different worlds, and a replay that crossed them should be reported as
     * a mismatch rather than surface twenty ticks later as a divergence nobody can place.
     */
    expect(run(world(false, false), 5)).not.toBe(run(world(false, true), 5));
  });

  it('DOES NOT DEPEND ON THE ORDER PARCELS WERE SPAWNED IN', () => {
    /*
     * `§25`'s row, and the same gate Track B's shuffled executor is. Two logs spawned the other way
     * round are the same two logs: the solver's clamp is proportional rather than first-come, and
     * the field's sweep is over a fixed space-filling order — so nothing in the model should be able
     * to tell. This is what says so.
     *
     * **The hash is order-insensitive by construction**: each parcel's own digest is combined by
     * addition rather than by folding into a running state, because a handle *is* the spawn order
     * and hashing one in sequence would assert the opposite of what this test is for.
     */
    expect(run(world(true), 40)).toBe(run(world(false), 40));
  });

  it('OR IN THE ORDER THEY REALISED THEIR CHUNKS, which is a different claim', () => {
    /*
     * **The test above could not have caught this and did not.** Its two logs sit a metre apart, so
     * both are in one chunk and the field's chunk list is one entry however they were spawned. Two
     * logs in *different* chunks realise them in spawn order — and everything that walks the chunk
     * list then walks it in allocation order, which is history rather than geometry.
     *
     * The consequence was not confined to the hash. `sweep` accumulates every face into shared
     * `deltas` with `+=`, and floating-point addition is not associative, so the **state** diverged
     * too: measured before the fix, two logs eight metres apart spawned the other way round left
     * **1,202 cells** differing after sixty ticks. Small — the last bit — and fed into a stiff
     * exponential rate law, which is where small differences stop being small.
     *
     * `AtmosphereField.order` is the answer: chunk indices in key order, so every sweep and every
     * reduction is a function of geometry. Watched fail before it was kept.
     *
     * **Ten metres apart and `maxChunks` well clear of the count, both deliberately.** Different
     * chunks is what this is about. And at the *cap* the two orders are genuinely two worlds, since
     * which chunk exists is decided by which was asked for first — so a capped field would fail this
     * for a reason that is the option working rather than a determinism hole.
     */
    const apart = (reversed: boolean): ChemistryWorld => {
      const species = new SpeciesRegistry();
      registerStandardSpecies(species);
      const reactions = new ReactionRegistry(species);
      const substances = new SubstanceRegistry(species, reactions);
      installLibrary(ORGANIC, species, reactions, substances);
      const parcels = new ParcelStore(substances);
      const air = new AtmosphereField(species, {
        cellSize: 1,
        ambient: STANDARD_AIR,
        maxChunks: 16,
      });
      const built = new ChemistryWorld(parcels, air);
      const spec = (substance: number, x: number) => ({
        substance,
        mass: 2,
        temperature: 293.15,
        area: 0.3,
        x,
        y: 0.5,
        z: 0.5,
      });
      const oak = substances.indexOf('oak');
      const pine = substances.indexOf('pine');
      if (reversed) {
        parcels.spawn(spec(pine, 9.5));
        parcels.spawn(spec(oak, 0.5));
      } else {
        parcels.spawn(spec(oak, 0.5));
        parcels.spawn(spec(pine, 9.5));
      }
      return built;
    };

    expect(run(apart(true), 60)).toBe(run(apart(false), 60));
  }, 60000);

  it('is sixteen hexadecimal digits, like the physics one beside it', () => {
    expect(run(world(), 1)).toMatch(/^[0-9a-f]{16}$/);
  });
});

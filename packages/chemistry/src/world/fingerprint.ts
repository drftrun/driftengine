/**
 * A 64-bit digest of everything a chemistry world holds, beside `fingerprintBodies`.
 *
 * **`§15` lists four things that make determinism a property rather than a hope, and three of them
 * already held**: no transcendental on a tick, a reaction clamp that is proportional rather than
 * first-come, and `Float64Array` for every piece of state. Without this function those three are
 * claims about the code. With it they are assertions about its output, and a replay that diverges
 * is caught at the tick it diverged rather than at the frame somebody noticed.
 *
 * ---
 *
 * ## Two departures from the physics one, and both are forced
 *
 * **Doubles, not floats.** `fingerprintBodies` narrows to `Float32Array` because that is what a body
 * *is*. Chemistry's state is doubles by decision — enthalpy differences across a burn span twelve
 * orders of magnitude — so narrowing here would make two genuinely different worlds agree, which is
 * the one thing a fingerprint may not do.
 *
 * **Order-insensitive over parcels.** Each parcel's digest is combined by **addition** rather than
 * by folding into a running state, because a parcel's handle *is* the order it was spawned in.
 * `§25` asks for a test that shuffled registration gives an identical fingerprint, and a hash that
 * folded handles in sequence would fail it while nothing was wrong. Addition costs the ability to
 * distinguish two worlds that are permutations of each other — which is exactly the distinction
 * this is asked not to make.
 *
 * **The substance registry is in it**, per `§15`: two worlds with different libraries are different
 * worlds, and a mismatch should be reported as one rather than surface later as a divergence nobody
 * can place.
 */
import type { ChemistryWorld } from '../transport/world.ts';
import { ELEMENT_COUNT } from '../element/elements.ts';

const OFFSET = 0x811c9dc5;
const PRIME = 0x01000193;

/* Scratch, module-level: this is called once a tick at most and allocating a view per double would
   be the one place a diagnostic function cost more than what it measures. */
const scratch = new Float64Array(1);
const bytes = new Uint8Array(scratch.buffer);
const elements = new Float64Array(ELEMENT_COUNT);

/** FNV-1a over the eight bytes of a double, in both directions, into a pair of 32-bit lanes. */
function mix(state: { low: number; high: number }, value: number): void {
  scratch[0] = value;
  for (let b = 0; b < 8; b++) {
    state.low = Math.imul(state.low ^ (bytes[b] as number), PRIME) >>> 0;
    state.high = Math.imul(state.high ^ (bytes[7 - b] as number), PRIME) >>> 0;
  }
}

function hex(low: number, high: number): string {
  return `${(low >>> 0).toString(16).padStart(8, '0')}${(high >>> 0).toString(16).padStart(8, '0')}`;
}

export function fingerprintChemistry(world: ChemistryWorld): string {
  const parcels = world.parcels;
  const state = { low: OFFSET, high: OFFSET };

  /*
   * The registry, folded in order, because a registry *is* ordered: a substance is an index and two
   * libraries installed the other way round genuinely are two different worlds by that index.
   */
  const substances = parcels.substanceCount;
  mix(state, substances);
  for (let s = 0; s < substances; s++) {
    mix(state, parcels.substanceDigestOf(s));
  }

  /* Each parcel's own digest, added rather than folded. See the header. */
  let low = 0;
  let high = 0;
  for (let parcel = 0; parcel < parcels.count; parcel++) {
    if (!parcels.alive(parcel)) continue;
    const own = { low: OFFSET, high: OFFSET };
    /* What it is made of, rather than which handle it got. */
    mix(own, parcels.substanceOf(parcel));
    mix(own, parcels.massOf(parcel));
    mix(own, parcels.positionX(parcel));
    mix(own, parcels.positionY(parcel));
    mix(own, parcels.positionZ(parcel));
    const shells = parcels.shellCount(parcel);
    for (let shell = 0; shell < shells; shell++) {
      mix(own, parcels.shellEnthalpyOf(parcel, shell));
      mix(own, parcels.shellMassOf(parcel, shell));
    }
    /* Composition as element totals: a species set is a property of the substance, so hashing raw
       slots would make two identical parcels of differently-ordered registries disagree. */
    parcels.elementTotalsOf(parcel, elements);
    for (let e = 0; e < ELEMENT_COUNT; e++) mix(own, elements[e] as number);
    low = (low + own.low) >>> 0;
    high = (high + own.high) >>> 0;
  }
  mix(state, low);
  mix(state, high);

  /* The air, as the one quantity that summarises every cell: moles of each element it holds. */
  const field = world.field;
  if (field !== null) {
    field.elementTotals(elements);
    for (let e = 0; e < ELEMENT_COUNT; e++) mix(state, elements[e] as number);
    mix(state, field.chunkCount);
    mix(state, field.totalEnthalpy());
  }

  return hex(state.low, state.high);
}

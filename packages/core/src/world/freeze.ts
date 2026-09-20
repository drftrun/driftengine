/**
 * What an unloaded region does, decided rather than discovered.
 *
 * **An unloaded region is frozen: it is exactly reproducible and it does not simulate.** An agent
 * in an unloaded cell does not walk anywhere, does not age, does not finish what it was doing. That
 * is a decision with consequences a consumer has to know about, which is why it is written into
 * `docs/CAPABILITIES.md` as well as here — a consumer discovering it from behaviour is the failure
 * this file exists to prevent.
 *
 * **Freezing is a simulation decision and unloading is a memory one, and that separation is the
 * whole design.** A frozen cell does not simulate whether or not its contents are resident, and
 * only a frozen cell may be unloaded. So streaming cannot change what the simulation computes; it
 * can only change where the bytes live. The alternative — unloading causes freezing — makes the
 * simulation depend on how much memory a machine had, which is a divergence that appears on one
 * player's computer and nowhere else.
 *
 * **A frozen cell still contributes to the fingerprint.** Dropping its contribution would make two
 * runs agree only at the end, once everything had thawed, and agreeing only at the end means they
 * disagreed for a while — in a rollback netcode, for a while during which those numbers were
 * already sent.
 */

/**
 * What freezing needs of a world.
 *
 * Taken as a parameter rather than imported, on `AGENTS.md`'s rule: core has no entity store and a
 * consumer may be holding one of several. Six methods, all of which any store can answer.
 */
export interface FreezableWorld {
  /** Every entity whose home is this cell, live or not. */
  entitiesIn(cell: number): readonly number[];
  /** Write an entity's whole state into `out` and return how many values were written. */
  readState(entity: number, out: Float64Array): number;
  /** Put a state back, exactly. */
  writeState(entity: number, values: Float64Array, count: number): void;
  simulating(entity: number): boolean;
  setSimulating(entity: number, on: boolean): void;
}

/**
 * One cell's frozen contents. Entities in ascending order, so the packing is deterministic.
 *
 * Exported because whoever unloads a cell has to write this somewhere and read it back.
 */
export interface FrozenCell {
  readonly entities: number[];
  /** Each entity's values, one after another. */
  readonly values: Float64Array;
  /** How many values each entity contributed, parallel to `entities`. */
  readonly counts: Int32Array;
  /** Computed once when the cell froze. Frozen state does not change, so neither does this. */
  readonly digest: number;
}

export interface FrozenCells {
  readonly cells: Map<number, FrozenCell>;
}

export function createFrozenCells(): FrozenCells {
  return { cells: new Map<number, FrozenCell>() };
}

export function isCellFrozen(frozen: FrozenCells, cell: number): boolean {
  return frozen.cells.has(cell);
}

/** The entities a cell froze, ascending. Empty for a cell that is not frozen. */
export function frozenEntities(frozen: FrozenCells, cell: number): readonly number[] {
  return frozen.cells.get(cell)?.entities ?? [];
}

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;
const SCRATCH = new Float64Array(64);
const BYTES = new DataView(new ArrayBuffer(8));

/**
 * FNV-1a over the eight bytes of every value, which is the construction `Fingerprint` uses.
 *
 * **Over the bytes and not over the numbers**, for the reason that file gives: two doubles a
 * hundredth apart may print the same and are a divergence, and the bytes are what tells them
 * apart. `-0` and `+0` therefore hash differently, and that is correct — two peers holding
 * different zeroes have genuinely diverged.
 */
function digestOf(entities: readonly number[], values: Float64Array, used: number): number {
  let h = OFFSET_BASIS;
  const eat = (value: number): void => {
    BYTES.setFloat64(0, value);
    for (let at = 0; at < 8; at += 1) {
      h = Math.imul(h ^ BYTES.getUint8(at), PRIME) >>> 0;
    }
  };
  for (const entity of entities) eat(entity);
  for (let at = 0; at < used; at += 1) eat(values[at] as number);
  return h >>> 0;
}

/**
 * Stop a cell simulating and capture exactly what it held. `false` if it was already frozen.
 *
 * **Refuses rather than throws**, because the caller is a streamer inside a frame and the honest
 * answer to "freeze this again" is that there is nothing to do.
 */
export function freezeCell(world: FreezableWorld, frozen: FrozenCells, cell: number): boolean {
  if (frozen.cells.has(cell)) return false;

  const entities = [...world.entitiesIn(cell)].sort((a, b) => a - b);
  const counts = new Int32Array(entities.length);
  let used = 0;
  for (let at = 0; at < entities.length; at += 1) {
    const entity = entities[at] as number;
    const count = world.readState(entity, SCRATCH.subarray(used));
    counts[at] = count;
    used += count;
  }

  const values = new Float64Array(used);
  values.set(SCRATCH.subarray(0, used));
  for (const entity of entities) world.setSimulating(entity, false);

  frozen.cells.set(cell, { entities, values, counts, digest: digestOf(entities, values, used) });
  return true;
}

/**
 * Put a cell back exactly as it was frozen and let it simulate again. `false` if it was not frozen.
 *
 * **Exactly as it was frozen, and never where it would have got to.** An extrapolated thaw is how
 * an unloaded region silently diverges from a loaded one: nothing throws, the numbers are
 * plausible, and the fingerprints stop matching at a frame nobody can point at.
 */
export function thawCell(world: FreezableWorld, frozen: FrozenCells, cell: number): boolean {
  const held = frozen.cells.get(cell);
  if (held === undefined) return false;

  let at = 0;
  for (let index = 0; index < held.entities.length; index += 1) {
    const entity = held.entities[index] as number;
    const count = held.counts[index] as number;
    world.writeState(entity, held.values.subarray(at, at + count), count);
    world.setSimulating(entity, true);
    at += count;
  }
  frozen.cells.delete(cell);
  return true;
}

/**
 * What a frozen cell contributes to the world's fingerprint. Zero for a cell nothing froze.
 *
 * **Constant for as long as the cell is frozen**, which is what makes a streamed run and an
 * unstreamed one agree at every frame rather than only once everything has thawed. A consumer
 * feeds this into whatever fingerprint it already keeps, alongside its live entities.
 */
export function frozenFingerprintContribution(frozen: FrozenCells, cell: number): number {
  return frozen.cells.get(cell)?.digest ?? 0;
}

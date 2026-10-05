/**
 * Graph-colour batches: constraints grouped so that no batch moves a particle twice.
 *
 * **What makes a batch parallel.** Every constraint in a batch reads and writes particles no other
 * constraint in it writes, so the batch can be solved in any order — one GPU thread a constraint —
 * and give the answer it gives in sequence. The batches themselves still run one after another,
 * which keeps the solve a Gauss–Seidel one: each batch sees what the last one moved.
 *
 * **A kinematic particle may be shared freely.** Nothing writes it, so two constraints holding the
 * same pinned particle cannot race; colouring around it would only add batches.
 *
 * Greedy, in the order the constraints are given: each takes the first colour none of its moving
 * particles has yet. Not the fewest colours there are, which is a hard problem; a chain gets two and
 * a triangle mesh's edges about six to nine, which is what a solver colouring cooked data gets too.
 */

/** Constraints reordered by colour, and where each colour's run starts. */
export interface ClothBatches {
  /** Constraint indices, batch by batch. */
  readonly order: Uint32Array;
  /** Offsets into `order`: batch `b` is `order[batches[b]]` up to `order[batches[b + 1]]`. */
  readonly batches: Uint32Array;
}

/** Colour `indices`, `arity` particles a constraint, around the particles `inverseMass` pins. */
export function colourConstraints(
  indices: Uint32Array,
  arity: number,
  inverseMass: Float32Array,
): ClothBatches {
  const constraints = indices.length / arity;
  const colour = new Int32Array(constraints);
  /* For each particle, a bit set of the colours already holding it, grown as colours are added. */
  const used: Set<number>[] = [];
  let colours = 0;
  for (let k = 0; k < constraints; k++) {
    let chosen = 0;
    for (; ; chosen++) {
      let free = true;
      for (let j = 0; j < arity && free; j++) {
        const p = indices[k * arity + j] as number;
        if ((inverseMass[p] as number) === 0) continue;
        if (used[p]?.has(chosen) === true) free = false;
      }
      if (free) break;
    }
    colour[k] = chosen;
    colours = Math.max(colours, chosen + 1);
    for (let j = 0; j < arity; j++) {
      const p = indices[k * arity + j] as number;
      if ((inverseMass[p] as number) === 0) continue;
      (used[p] ??= new Set()).add(chosen);
    }
  }
  const batches = new Uint32Array(colours + 1);
  for (let k = 0; k < constraints; k++) batches[(colour[k] as number) + 1]++;
  for (let c = 0; c < colours; c++)
    batches[c + 1] = (batches[c + 1] as number) + (batches[c] as number);
  const cursor = batches.slice(0, colours);
  const order = new Uint32Array(constraints);
  for (let k = 0; k < constraints; k++) order[cursor[colour[k] as number]++] = k;
  return { order, batches };
}

/**
 * Given batches, checked: they cover every constraint once, in order, and none moves a particle
 * twice. Refused by name, because an overlap is a race on the GPU and a wrong answer nowhere else.
 */
export function givenBatches(
  name: string,
  indices: Uint32Array,
  arity: number,
  inverseMass: Float32Array,
  batches: Uint32Array,
): ClothBatches {
  const constraints = indices.length / arity;
  if (batches[0] !== 0 || batches[batches.length - 1] !== constraints) {
    throw new Error(
      `skinned cloth: ${name} batches run from ${batches[0]} to ${batches[batches.length - 1]}, ` +
        `and must cover constraints 0 to ${constraints}`,
    );
  }
  const seen = new Int32Array(inverseMass.length).fill(-1);
  for (let b = 0; b + 1 < batches.length; b++) {
    for (let k = batches[b] as number; k < (batches[b + 1] as number); k++) {
      for (let j = 0; j < arity; j++) {
        const p = indices[k * arity + j] as number;
        if ((inverseMass[p] as number) === 0) continue;
        if (seen[p] === b) {
          throw new Error(
            `skinned cloth: ${name} batch ${b} moves particle ${p} twice, so it cannot run in parallel`,
          );
        }
        seen[p] = b;
      }
    }
  }
  return { order: Uint32Array.from({ length: constraints }, (_, k) => k), batches };
}

/**
 * A kind of constraint's batches: the set-up's own, checked, where it gives them, and coloured here
 * where it does not. One decision for both solvers, which must batch a garment the same way.
 */
export function batchesOf(
  name: string,
  indices: Uint32Array,
  arity: number,
  inverseMass: Float32Array,
  given: Uint32Array | undefined,
): ClothBatches {
  return given === undefined
    ? colourConstraints(indices, arity, inverseMass)
    : givenBatches(name, indices, arity, inverseMass, given);
}

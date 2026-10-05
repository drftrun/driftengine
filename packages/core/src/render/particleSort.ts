/**
 * A pool's particles, farthest from the eye first, for a blended batch that asks to be sorted.
 *
 * **Why a blended batch wants it.** An alpha blend is order-dependent: a near puff drawn before a
 * far one is covered by it, and a cloud of them drawn in the order they were born flickers as
 * that order and the camera disagree. Back to front is the order the blend assumes. Additive
 * blending is a sum and needs none of it, which is why sorting is the batch's choice.
 *
 * **Backend-neutral, as a copy**: the sorted particles are written into a second set of streams the
 * batch owns, and each backend uploads that set exactly as it uploads an unsorted one — so the
 * order is one decision, not two, by the 2026-08-13 rule. A merge sort into preallocated scratch,
 * so nothing is allocated per frame however many particles there are; stable, so two particles at
 * one distance keep their order and do not trade places from frame to frame.
 *
 * **What it gives up** is order between batches and within one particle: two sorted batches still
 * draw one after the other, and two crossing cards cut through each other. **What would make it
 * wrong** is a field of particles large enough that sorting it on the CPU costs a frame; the GPU
 * sorts it then.
 */
import type { ParticleInstances } from './particlePool.ts';

/** What sorting a batch keeps between frames: the order, its keys and the sorted copy. */
export interface ParticleSort {
  readonly order: Uint32Array;
  readonly scratch: Uint32Array;
  readonly keys: Float32Array;
  readonly sorted: ParticleInstances;
}

/** Room to sort `capacity` particles, allocated once with the batch. */
export function createParticleSort(capacity: number): ParticleSort {
  return {
    order: new Uint32Array(capacity),
    scratch: new Uint32Array(capacity),
    keys: new Float32Array(capacity),
    sorted: {
      positions: new Float32Array(capacity * 3),
      sizes: new Float32Array(capacity),
      spins: new Float32Array(capacity),
      colors: new Float32Array(capacity * 3),
      alphas: new Float32Array(capacity),
      ages: new Float32Array(capacity),
      seeds: new Float32Array(capacity),
      velocities: new Float32Array(capacity * 3),
      frames: new Float32Array(capacity),
      heights: new Float32Array(capacity),
      count: 0,
      capacity,
    },
  };
}

/**
 * `data`'s live particles into `sort.sorted`, farthest from `eye` first, and that copy returned.
 * At most the sort's capacity are kept.
 */
export function sortBackToFront(
  data: ParticleInstances,
  eye: ArrayLike<number>,
  sort: ParticleSort,
): ParticleInstances {
  const count = Math.min(data.count, sort.order.length);
  const { order, keys } = sort;
  const ex = eye[0] ?? 0;
  const ey = eye[1] ?? 0;
  const ez = eye[2] ?? 0;
  for (let i = 0; i < count; i++) {
    const dx = (data.positions[i * 3] as number) - ex;
    const dy = (data.positions[i * 3 + 1] as number) - ey;
    const dz = (data.positions[i * 3 + 2] as number) - ez;
    keys[i] = dx * dx + dy * dy + dz * dz;
    order[i] = i;
  }
  mergeSortFarFirst(order, sort.scratch, keys, count);

  const out = sort.sorted;
  for (let k = 0; k < count; k++) {
    const i = order[k] as number;
    copy3(data.positions, i, out.positions, k);
    copy3(data.colors, i, out.colors, k);
    copy3(data.velocities, i, out.velocities, k);
    out.sizes[k] = data.sizes[i] as number;
    out.spins[k] = data.spins[i] as number;
    out.alphas[k] = data.alphas[i] as number;
    out.ages[k] = data.ages[i] as number;
    out.seeds[k] = data.seeds[i] as number;
    (out.frames as Float32Array)[k] = data.frames?.[i] ?? 0;
    (out.heights as Float32Array)[k] = data.heights?.[i] ?? 0;
  }
  out.count = count;
  return out;
}

function copy3(from: Float32Array, i: number, to: Float32Array, k: number): void {
  to[k * 3] = from[i * 3] as number;
  to[k * 3 + 1] = from[i * 3 + 1] as number;
  to[k * 3 + 2] = from[i * 3 + 2] as number;
}

/** A bottom-up merge sort of `order` by `keys`, largest first, stable, through `scratch`. */
function mergeSortFarFirst(
  order: Uint32Array,
  scratch: Uint32Array,
  keys: Float32Array,
  count: number,
): void {
  let from = order;
  let to = scratch;
  for (let width = 1; width < count; width *= 2) {
    for (let start = 0; start < count; start += 2 * width) {
      const middle = Math.min(start + width, count);
      const end = Math.min(start + 2 * width, count);
      let a = start;
      let b = middle;
      let at = start;
      while (a < middle && b < end) {
        /* `>=` keeps the left run's particle first on a tie, which is what makes this stable. */
        if ((keys[from[a] as number] as number) >= (keys[from[b] as number] as number)) {
          to[at++] = from[a++] as number;
        } else {
          to[at++] = from[b++] as number;
        }
      }
      while (a < middle) to[at++] = from[a++] as number;
      while (b < end) to[at++] = from[b++] as number;
    }
    const swap = from;
    from = to;
    to = swap;
  }
  /* Copied by hand: a subarray would be a view allocated every frame. */
  if (from !== order) for (let i = 0; i < count; i++) order[i] = from[i] as number;
}

/** A counting sort over a sixteen-bit depth key: no comparisons, one pass, far to near, budgeted. */

/** How many buckets the depth key has. A sixteen-bit key, so 65,536 of them. */
export const SPLAT_SORT_BUCKETS = 65536;

/**
 * How many buckets the screen-space size key has.
 *
 * The key is the top sixteen bits of a positive float's own bit pattern, which reaches 32,640 for
 * an infinite ratio — so this is the next power of two above that rather than a number with a
 * meaning of its own. See `sortSplatsByDepth` for why those bits are a usable key at all.
 */
export const SPLAT_SIZE_BUCKETS = 32768;

/**
 * One sort, as the worker protocol and as the function's own parameter list.
 *
 * **One object rather than eleven arguments, and the worker is the reason.** `createSplatSortWorker`
 * posts this and hands `event.data` straight to the sort, so the message shape and the call shape
 * cannot disagree — which is the failure the 2026-08-17 rule is about, in the one place here where
 * a decision genuinely does cross a thread boundary.
 */
export interface SplatSortRequest {
  /** Three per splat, in the capture's own space. */
  readonly positions: Float32Array;
  /** One per splat: `SplatData.extents`, the largest sigma. Only read when there is a budget. */
  readonly extents: Float32Array;
  readonly count: number;
  /**
   * The camera's forward **in the capture's own space**, unit length.
   *
   * Not the world-space forward: a batch with a model matrix is looked at from a different
   * direction in its own frame, and `resolveSplatView` is what converts one to the other. One
   * sorter therefore serves one batch and two batches need no merged order.
   */
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  /**
   * The camera's position in the capture's own space.
   *
   * **Invisible in the order and load-bearing in the budget.** Shifting every splat by the same
   * amount cannot reorder them, so depth alone never needed this; the size key is `extent` over
   * the *distance*, and a distance needs a point to measure from.
   */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  /** The most splats to keep. Zero, or anything at or above `count`, keeps all of them. */
  readonly budget: number;
  /** The buffer to fill and hand back, so the pair can ping-pong rather than allocate. */
  readonly out: Uint32Array;
}

/**
 * What a sort answers with: the filled buffer, and how many entries of it are real.
 *
 * **The count is not the request's count once a budget bites**, and it comes back rather than
 * being recomputed, because only the sort knows how its ration of the straddling size bucket
 * fell out. A caller that assumed the capture's own count would walk off the end of a valid order
 * into whatever the buffer held before — stale indices drawn as splats, which reads as a corrupt
 * capture rather than as an off-by-one.
 */
export interface SplatSortResult {
  /** The buffer that was handed in, or the same storage after a worker transferred it twice. */
  readonly order: Uint32Array;
  readonly count: number;
}

/**
 * How a sort actually happens.
 *
 * **A capability the caller may replace, which is `AGENTS.md`'s rule about platform APIs and not a
 * convenience.** The shipped default is a worker; a consumer under a strict CSP, in a test, or on
 * a runtime with no `Worker` at all supplies its own and nothing here has to know.
 */
export type SplatSortFn = (request: SplatSortRequest) => Promise<SplatSortResult>;

/**
 * The arrays a sort reuses, allocated once by the caller.
 *
 * **A sort allocates nothing**, which is the whole reason this is a parameter rather than a local:
 * the two histograms are 384 KB between them, and a capture re-sorts whenever the view turns. Doing
 * that in a worker does not make an allocation free — it makes it somebody else's garbage.
 */
export interface SplatSortScratch {
  /** The depth bucket of each splat, carried from the counting pass to the scatter. */
  readonly keys: Uint16Array;
  /** The depth histogram, then the prefix sum over it. */
  readonly counts: Uint32Array;
  /** The size bucket of each splat, overwritten by the counting pass with whether it survived. */
  readonly sizes: Uint16Array;
  /** The size histogram, walked from the top to find the budget's threshold. */
  readonly sizeCounts: Uint32Array;
  /**
   * Two views of one four-byte buffer, for reading a float's bits without allocating a view.
   *
   * A pair rather than a `DataView` because this is read once per splat per sort and the typed
   * pair is one store and one load. It is in the scratch rather than at module scope for the same
   * reason everything else here is: the sort is stringified into a worker and closes over nothing.
   */
  readonly bits: Float32Array;
  readonly bitsAsUint: Uint32Array;
}

export function createSplatSortScratch(count: number): SplatSortScratch {
  const bits = new ArrayBuffer(4);
  return {
    keys: new Uint16Array(Math.max(1, count)),
    counts: new Uint32Array(SPLAT_SORT_BUCKETS),
    sizes: new Uint16Array(Math.max(1, count)),
    sizeCounts: new Uint32Array(SPLAT_SIZE_BUCKETS),
    bits: new Float32Array(bits),
    bitsAsUint: new Uint32Array(bits),
  };
}

/**
 * Order the splats worth drawing far to near, writing indices into `request.out`.
 *
 * Returns how many were written, which is `count` unless a budget cut it.
 *
 * **Far to near, and the direction is the one thing a test can catch that a screenshot cannot.**
 * A near-to-far order looks *plausible* — the cloud is still a cloud — and is wrong at every
 * silhouette, because `over` compositing is not commutative. `dir` is the camera's forward in the
 * capture's own space, so a larger projection along it is farther away and this sorts descending.
 *
 * **A counting sort rather than a comparison sort**, which is what makes it affordable at a
 * million splats: one pass for the range, one to bucket, one prefix sum, one to scatter, all
 * linear. `Array.prototype.sort` on a million indices is tens of milliseconds and allocates.
 *
 * **Sixteen bits is 65,536 distinct depths across the capture's whole extent.** At a capture ten
 * metres deep that is 0.15 mm a bucket, far below what any ordering error could show. What it
 * gives up is exactness: two splats inside one bucket keep their input order rather than their
 * true order, which is a tie broken arbitrarily and invisible. What would make it wrong is a
 * capture whose depth range is dominated by one distant outlier, which squeezes everything else
 * into a handful of buckets — the same failure a histogram always has, and the reason the range
 * is measured rather than assumed.
 *
 * **A budget selects by screen-space size, and taking a prefix of the order instead would be
 * wrong in a way that looks deliberate.** The order is far to near, so its front is the far end:
 * `splatBudget.test.ts` measures that, rather than leaving it to be recalled. A prefix therefore
 * keeps the distant half of a capture and throws away everything close to the camera — the splats
 * covering the most pixels, and most of what a viewer is looking at. A suffix inverts the mistake
 * and drops the backdrop. Neither is a budget; both are a capture with a piece missing.
 *
 * So the splats kept are the ones largest **on screen**, which is the extent over the distance,
 * and the ones dropped are by construction smaller than every one kept. What that gives up is
 * stability: as the camera closes on a capture, splats cross the threshold and appear, which is
 * a pop bounded by the size of the smallest splat still being drawn — around a pixel at any
 * budget worth setting, and unmissable at a budget of a few thousand. What would make it wrong is
 * a capture of very flat splats seen edge-on, where the largest sigma over-estimates the pixels
 * covered; `SplatData.extents` carries that same caveat, because it is the same approximation.
 */
export function sortSplatsByDepth(request: SplatSortRequest, scratch: SplatSortScratch): number {
  const { positions, extents, count, dirX, dirY, dirZ, originX, originY, originZ, out } = request;
  if (count <= 0) return 0;
  const { keys, counts, sizes, sizeCounts, bits, bitsAsUint } = scratch;
  /*
   * **The bucket counts come from the scratch, not from the module constants, and that is what
   * lets this function be stringified into a worker.** `createSplatSortWorker` ships
   * `sortSplatsByDepth.toString()` so there is one implementation of the ordering rather than two
   * — and a stringified function loses its scope, so any module-scope binding it referenced would
   * be an undefined identifier the moment a bundler renamed or dropped it. Reading `.length`
   * closes over nothing. `splatSort.test.ts` asserts the source is free of such references.
   */
  const buckets = counts.length;
  /* Normalised to zero, so every test below is against one number rather than against two. */
  const budget = request.budget > 0 && request.budget < count ? request.budget : 0;

  let min = Infinity;
  let max = -Infinity;
  if (budget > 0) sizeCounts.fill(0);
  for (let index = 0; index < count; index++) {
    const p = index * 3;
    const depth =
      ((positions[p] ?? 0) - originX) * dirX +
      ((positions[p + 1] ?? 0) - originY) * dirY +
      ((positions[p + 2] ?? 0) - originZ) * dirZ;
    if (depth < min) min = depth;
    if (depth > max) max = depth;

    if (budget > 0) {
      /*
       * The screen-space radius is the focal length times `extent / depth`, and the focal length
       * is the same for every splat in a frame — so it drops out of a ranking and this is the
       * whole key.
       *
       * **The key is the top sixteen bits of the ratio's own float bits**, which for a positive
       * float is exactly monotone: IEEE 754 lays out sign, then exponent, then mantissa, so a
       * larger positive float has a larger bit pattern, and taking the high half keeps the sign,
       * all eight exponent bits and seven of the mantissa. That is a logarithmic quantisation —
       * 128 buckets an octave, so a threshold lands within half a percent of the ideal size cut —
       * at the cost of one store and one load rather than a `Math.log2` per splat per sort. What
       * would make it wrong is a negative key, which cannot happen: the guard below sends
       * everything that is not a positive ratio to bucket zero.
       *
       * A splat at or behind the camera has no screen-space size, so `depth <= 0` fails
       * `ratio > 0` and lands in bucket zero, where the budget drops it first. So does a `NaN`,
       * because every comparison against one is false — which is the honest answer for a splat
       * whose size cannot be computed.
       */
      const ratio = (extents[index] ?? 0) / depth;
      let key = 0;
      if (ratio > 0) {
        bits[0] = ratio;
        key = (bitsAsUint[0] ?? 0) >>> 16;
      }
      sizes[index] = key;
      sizeCounts[key] = (sizeCounts[key] ?? 0) + 1;
    }
  }

  /*
   * The threshold, and the quota that trims the bucket straddling it.
   *
   * Walking down from the largest size, `above` is everything strictly bigger than `threshold`
   * and fits inside the budget by construction. The bucket that would overflow it is *included*
   * and then rationed: `quota` splats from it are admitted in index order and the rest are not.
   * Without that ration a capture whose splats are all one size — which is most synthetic ones,
   * and any capture from a fixed-scale exporter — would put every splat in one bucket and the
   * threshold alone would answer either everything or nothing. Nothing is a blank screen on
   * exactly the device the budget exists for.
   */
  let threshold = 0;
  let quota = 0;
  if (budget > 0) {
    let above = 0;
    for (let bucket = sizeCounts.length - 1; bucket >= 0; bucket--) {
      const howMany = sizeCounts[bucket] ?? 0;
      threshold = bucket;
      if (above + howMany > budget) break;
      above += howMany;
    }
    quota = budget - above;
  }

  /*
   * A capture with no depth range at all — one splat, or a plane exactly side-on. Every key would
   * be a division by zero, so the scale is zero and every splat lands in bucket 0 in input order.
   * That is a legal answer: with no range there is no ordering to get wrong.
   *
   * The range spans every splat rather than only the ones inside the budget, because it is
   * measured before the threshold is known. What that costs is depth resolution when a budget
   * discards a distant tail; at 65,536 buckets there is a great deal to spare.
   */
  const range = max - min;
  const scale = range > 0 ? (buckets - 1) / range : 0;

  counts.fill(0);
  let admitted = 0;
  let remaining = quota;
  for (let index = 0; index < count; index++) {
    if (budget > 0) {
      const size = sizes[index] ?? 0;
      const keep = size > threshold || (size === threshold && remaining > 0);
      if (keep && size === threshold) remaining--;
      /* Overwritten with the verdict, so the scatter admits exactly this set without re-running
         the ration. The size itself is not wanted again. */
      sizes[index] = keep ? 1 : 0;
      if (!keep) continue;
    }
    const p = index * 3;
    const depth =
      ((positions[p] ?? 0) - originX) * dirX +
      ((positions[p + 1] ?? 0) - originY) * dirY +
      ((positions[p + 2] ?? 0) - originZ) * dirZ;
    /*
     * Inverted, so that an *ascending* bucket walk comes out far to near. Doing it here rather
     * than by walking the histogram backwards keeps the scatter a plain forward loop, and a
     * backwards scatter is where a stable sort quietly stops being stable.
     */
    const bucket = buckets - 1 - Math.round((depth - min) * scale);
    keys[index] = bucket;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    admitted++;
  }

  /* Prefix sum in place: each bucket becomes where its first splat goes. */
  let running = 0;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const howMany = counts[bucket] ?? 0;
    counts[bucket] = running;
    running += howMany;
  }

  for (let index = 0; index < count; index++) {
    if (budget > 0 && sizes[index] === 0) continue;
    const bucket = keys[index] ?? 0;
    const at = counts[bucket] ?? 0;
    out[at] = index;
    counts[bucket] = at + 1;
  }

  return admitted;
}

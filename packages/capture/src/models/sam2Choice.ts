/**
 * Which of a frame's four decoded masks a SAM 2 tracker keeps, and which pointer goes with it, as the
 * upstream's video decoder chooses.
 *
 * **A prompt of one point or none keeps the best of the three ambiguous masks** by predicted quality,
 * and that mask token's pointer. **More points keep the single mask**, unless its stability — pixels
 * above +0.05 over pixels above −0.05, one where there are none — is under 0.98, when the best of the
 * three is kept instead; **the pointer is the single mask's either way**, as the upstream slices its
 * tokens before it falls back. **An object whose score is not positive is absent**: its mask is −1024
 * everywhere and its pointer the learned one for no object. A box counts as its two corner points.
 */

const NO_OBJECT = -1024;
const STABILITY_DELTA = 0.05;
const STABILITY_THRESHOLD = 0.98;

/**
 * The kept mask's logits and pointer, from `masks`, `[4, cells]`, `quality`, `[4]`, `pointers`,
 * `[4, dim]`, the object's score, the prompt's point count and the no-object pointer.
 */
export function chooseMask(
  masks: Float32Array,
  quality: Float32Array,
  pointers: Float32Array,
  score: number,
  points: number,
  noObject: Float32Array,
): { readonly lowRes: Float32Array; readonly pointer: Float32Array } {
  const count = quality.length;
  const cells = masks.length / count;
  const dim = pointers.length / count;
  let best = 1;
  for (let m = 2; m < count; m += 1)
    if ((quality[m] as number) > (quality[best] as number)) best = m;
  let mask = best;
  let token = best;
  if (points > 1) {
    mask = stability(masks.subarray(0, cells)) >= STABILITY_THRESHOLD ? 0 : best;
    token = 0;
  }
  if (score <= 0) {
    return {
      lowRes: new Float32Array(cells).fill(NO_OBJECT),
      pointer: Float32Array.from(noObject),
    };
  }
  return {
    lowRes: Float32Array.from(masks.subarray(mask * cells, (mask + 1) * cells)),
    pointer: Float32Array.from(pointers.subarray(token * dim, (token + 1) * dim)),
  };
}

/* Pixels above +δ over pixels above −δ, and one where none are. */
function stability(logits: Float32Array): number {
  let inside = 0;
  let union = 0;
  for (let i = 0; i < logits.length; i += 1) {
    if ((logits[i] as number) > STABILITY_DELTA) inside += 1;
    if ((logits[i] as number) > -STABILITY_DELTA) union += 1;
  }
  return union > 0 ? inside / union : 1;
}

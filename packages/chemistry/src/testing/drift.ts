/**
 * How far two element vectors have drifted apart, for the conservation harness.
 *
 * Relative rather than absolute, because the elements in a burning world span many orders of
 * magnitude at once: a scene may hold a kilomole of nitrogen and a micromole of sulphur, and an
 * absolute tolerance either passes on a broken sulphur balance or fails on a correct nitrogen one.
 *
 * **With one exception that matters.** Where both sides are effectively zero, a relative measure
 * has nothing to divide by — and an element that appeared from nowhere would then report as no
 * drift at all, which is the single failure this harness exists to catch. So the denominator has a
 * floor of one, making the measure absolute in that regime.
 *
 * Test-side rather than runtime: nothing in the simulation calls it.
 */
export function maxElementDrift(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    throw new Error(`element vectors are ${a.length} and ${b.length} wide`);
  }
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as number;
    const right = b[i] as number;
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    const drift = Math.abs(left - right) / scale;
    if (drift > worst) worst = drift;
  }
  return worst;
}

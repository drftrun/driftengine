/**
 * Adam over a cloud's parameters, one moment pair per number.
 *
 * **Why Adam and not a plain descent.** The six families being fitted are in wildly different
 * units — metres, logarithms of metres, a quaternion, a colour on nought to one — and a single
 * step size that suits one of them moves another by nothing or by everything. Adam divides each
 * number's step by the size of its own recent gradients, so a rate here is a *fraction of the
 * parameter's own scale* and the families become comparable. It is also what makes the loss's
 * absolute size irrelevant: a frame of a million pixels and one of a thousand descend alike.
 *
 * **The bias correction is a running product rather than a power.** `β₁ⁿ` would want `**`, which
 * `packages/capture` may not use — the determinism gate refuses it, because an exponent is one of
 * the operations a platform may round its own way. Multiplying by β each step is the same number
 * by the same arithmetic the rest of the fit uses.
 */

const BETA1 = 0.9;
const BETA2 = 0.999;
const EPSILON = 1e-8;

/**
 * One optimised family: the values, their gradient, and Adam's two moments.
 *
 * Every array is allocated at the cloud's budget and used to `count * stride`, because the budget
 * is the one thing the cloud may not exceed — so densification never reallocates and a plan can
 * gather into the same arrays it reads.
 */
export interface Family {
  /** Numbers per Gaussian. */
  readonly stride: number;
  /** The step size, as a fraction of what this family's own gradients have been. */
  readonly rate: number;
  readonly values: Float64Array;
  readonly gradient: Float64Array;
  readonly moment: Float64Array;
  readonly second: Float64Array;
}

export function createFamily(stride: number, rate: number, budget: number): Family {
  return {
    stride,
    rate,
    values: new Float64Array(budget * stride),
    gradient: new Float64Array(budget * stride),
    moment: new Float64Array(budget * stride),
    second: new Float64Array(budget * stride),
  };
}

/** How far into the decay the fit is: β₁ⁿ and β₂ⁿ, carried rather than raised. */
export interface AdamState {
  unbias1: number;
  unbias2: number;
}

export function createAdamState(): AdamState {
  return { unbias1: 1, unbias2: 1 };
}

/**
 * One step over every family, on the gradients standing in them.
 *
 * **The gradient is read and not owned**: the caller writes every number of it before every step,
 * so there is nothing here to clear. A caller that accumulated into it instead would need that
 * clear back, and would be the one to add it.
 */
export function adamStep(families: readonly Family[], count: number, state: AdamState): void {
  state.unbias1 *= BETA1;
  state.unbias2 *= BETA2;
  const correction1 = 1 - state.unbias1;
  const correction2 = 1 - state.unbias2;
  for (const family of families) {
    const { values, gradient, moment, second, rate, stride } = family;
    const end = count * stride;
    for (let at = 0; at < end; at += 1) {
      const g = gradient[at] as number;
      const m = BETA1 * (moment[at] as number) + (1 - BETA1) * g;
      const v = BETA2 * (second[at] as number) + (1 - BETA2) * g * g;
      moment[at] = m;
      second[at] = v;
      values[at] =
        (values[at] as number) -
        (rate * (m / correction1)) / (Math.sqrt(v / correction2) + EPSILON);
    }
  }
}

/**
 * Rewrite every family by a plan: slot `i` takes its values from `sources[i]`.
 *
 * **A slot marked fresh starts Adam over.** A Gaussian that was just split off its parent has none
 * of that parent's history — its gradients are about to be different ones — and carrying the
 * moments across would take a step sized for a shape that no longer exists. The reference
 * implementation zeroes them for the same reason, and it is also what separates two halves of a
 * split: identical values with identical moments receive identical steps forever.
 */
export function gather(
  families: readonly Family[],
  sources: Int32Array,
  fresh: Uint8Array,
  count: number,
  scratch: Float64Array,
): void {
  for (const family of families) {
    gatherArray(family.values, family.stride, sources, fresh, count, scratch, false);
    gatherArray(family.moment, family.stride, sources, fresh, count, scratch, true);
    gatherArray(family.second, family.stride, sources, fresh, count, scratch, true);
  }
}

/** One array gathered through `scratch`, because a slot may take from a slot below itself. */
function gatherArray(
  array: Float64Array,
  stride: number,
  sources: Int32Array,
  fresh: Uint8Array,
  count: number,
  scratch: Float64Array,
  blankWhenFresh: boolean,
): void {
  for (let slot = 0; slot < count; slot += 1) {
    const from = (sources[slot] as number) * stride;
    for (let c = 0; c < stride; c += 1) scratch[slot * stride + c] = array[from + c] as number;
  }
  for (let slot = 0; slot < count; slot += 1) {
    const blank = blankWhenFresh && (fresh[slot] as number) !== 0;
    for (let c = 0; c < stride; c += 1) {
      array[slot * stride + c] = blank ? 0 : (scratch[slot * stride + c] as number);
    }
  }
}

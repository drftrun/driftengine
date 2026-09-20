/**
 * A small network evaluator, and the only one this engine has.
 *
 * **Three things use it**: a DriftTexture's decode, reconstruction's refinement tier, and capture's
 * reconstruction. That is the argument for building it carefully and once — a second inference path
 * is a second set of numerical conventions to keep in step, and the first symptom of them drifting
 * is a picture that is slightly wrong everywhere.
 *
 * **The constraint that shapes it: WebGPU exposes no hardware matrix units.** The desktop graphics
 * interfaces reach them through cooperative vectors and the published neural-texture work depends
 * on that. So the network here has to be small enough that ordinary vector arithmetic suffices,
 * and its size is decided by measurement against a frame budget rather than by copying an
 * architecture that assumed hardware this platform does not have.
 *
 * **The activation applies to hidden layers and not to the output.** Applying it to the output
 * clamps every channel into the activation's range, which produces a washed-out picture that a
 * training loss will not reveal — the network simply learns around it and infers badly.
 */
import { fromHalfBits, roundHalf } from './half.ts';

export interface NetworkShape {
  readonly inputs: number;
  readonly hidden: readonly number[];
  readonly outputs: number;
}

/** How many weights and biases a shape needs, laid out layer by layer. */
export function networkWeightCount(shape: NetworkShape): number {
  let total = 0;
  let previous = shape.inputs;
  for (const width of shape.hidden) {
    total += previous * width + width;
    previous = width;
  }
  return total + previous * shape.outputs + shape.outputs;
}

/** Rectified linear, which is what the generated shader will use too. */
function activate(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * Evaluate the network, writing `shape.outputs` values into `out`.
 *
 * Weights are read in layer order: for each layer, the weight matrix row-major by output, then the
 * biases. `scratch` must hold at least twice the widest layer and is reused across calls so this
 * allocates nothing.
 */
export function evalNetwork(
  shape: NetworkShape,
  weights: Float32Array,
  input: Float32Array,
  out: Float32Array,
  scratch: Float32Array,
): void {
  const widest = Math.max(shape.inputs, shape.outputs, ...shape.hidden, 1);
  let current = scratch.subarray(0, widest);
  let next = scratch.subarray(widest, widest * 2);
  for (let i = 0; i < shape.inputs; i += 1) current[i] = input[i] as number;

  let at = 0;
  let previous = shape.inputs;
  for (const width of shape.hidden) {
    for (let o = 0; o < width; o += 1) {
      let sum = 0;
      for (let i = 0; i < previous; i += 1) {
        sum += (current[i] as number) * (weights[at + o * previous + i] as number);
      }
      next[o] = activate(sum + (weights[at + width * previous + o] as number));
    }
    at += previous * width + width;
    previous = width;
    const swap = current;
    current = next;
    next = swap;
  }

  for (let o = 0; o < shape.outputs; o += 1) {
    let sum = 0;
    for (let i = 0; i < previous; i += 1) {
      sum += (current[i] as number) * (weights[at + o * previous + i] as number);
    }
    /* No activation here. See the header. */
    out[o] = sum + (weights[at + shape.outputs * previous + o] as number);
  }
}

/*
 * The most one rounding can move a value of this magnitude: half a unit in the last place, which is
 * 2^-11 of the value for a normal half-precision number and 2^-25 below them. Single precision's
 * own rounding, which the reference and the device do too, is the same argument at 2^-24.
 */
function halfRounding(magnitude: number): number {
  return Math.max(magnitude * 2 ** -11, 2 ** -25);
}

function singleRounding(magnitude: number): number {
  return Math.max(magnitude * 2 ** -24, 2 ** -150);
}

/**
 * How far the half-precision evaluation of this network, at this input, can sit from the
 * single-precision one.
 *
 * **A bound per network rather than one tolerance for all**, because a sampled tolerance is a claim
 * about the corpus that sampled it — 2,400 networks put the worst relative error at 0.00213, the
 * device's own corpus reached 0.0039, and 40,000 reached 0.0066. This carries the error instead:
 * the weights' and the input's own rounding exactly, then half a unit in the last place for every
 * product, every partial sum and the bias, through each layer — a rectifier moves no error, since
 * it is one-Lipschitz. **It holds whichever form a device computes**: every operation rounded, or
 * each multiply-add contracted into a single rounding, which WGSL permits and this project's
 * development machine does. It assumes no value overflows, which `activationBound` is for.
 */
export function halfPrecisionErrorBound(
  shape: NetworkShape,
  weights: Float32Array,
  input: Float32Array,
): number {
  let value = Array.from({ length: shape.inputs }, (_, i) => input[i] as number);
  let error = value.map((x) => Math.abs(roundHalf(x) - x) + singleRounding(Math.abs(x)));
  let worst = 0;
  let at = 0;
  let previous = shape.inputs;
  const layers = shape.hidden.length + 1;
  for (let layer = 0; layer < layers; layer += 1) {
    const width = layer < shape.hidden.length ? (shape.hidden[layer] as number) : shape.outputs;
    const hidden = layer < shape.hidden.length;
    const nextValue: number[] = [];
    const nextError: number[] = [];
    for (let o = 0; o < width; o += 1) {
      let exact = 0;
      let carried = 0;
      let magnitude = 0;
      let rounding = 0;
      for (let i = 0; i < previous; i += 1) {
        const weight = weights[at + o * previous + i] as number;
        const drift = Math.abs(roundHalf(weight) - weight);
        const x = value[i] as number;
        const e = error[i] as number;
        exact += x * weight;
        /* |xh·wh − x·w| ≤ |xh − x|·|wh| + |x|·|wh − w|. */
        carried += e * (Math.abs(weight) + drift) + Math.abs(x) * drift;
        const product = (Math.abs(x) + e) * (Math.abs(weight) + drift);
        magnitude += product + rounding;
        rounding +=
          halfRounding(product) +
          halfRounding(magnitude) +
          singleRounding(product) +
          singleRounding(magnitude);
      }
      const bias = weights[at + width * previous + o] as number;
      const biasDrift = Math.abs(roundHalf(bias) - bias);
      exact += bias;
      carried += biasDrift;
      magnitude += Math.abs(bias) + biasDrift + rounding;
      rounding += halfRounding(magnitude) + singleRounding(magnitude);
      const total = carried + rounding;
      if (hidden) {
        nextValue.push(Math.max(0, exact));
        nextError.push(total);
      } else {
        worst = Math.max(worst, total);
      }
    }
    at += previous * width + width;
    previous = width;
    value = nextValue;
    error = nextError;
  }
  return worst;
}

/**
 * Evaluate the network as a device with `enable f16` would, writing `shape.outputs` values into
 * `out`.
 *
 * **Every multiply and every add is rounded**, because that is what a sixteen-bit adder does, and
 * the arithmetic is in doubles so the rounding is the only approximation. The order is the
 * device's: the weighted inputs summed in index order, then the bias, then the rectifier —
 * `render/shaders/network.wgsl.ts` in `@driftengine/core` is written to match it.
 *
 * `weights` are half-precision bits, as `halfWeights` produces and an `NNET` chunk stores. Inputs
 * are rounded to half precision on the way in. `scratch` holds at least twice the widest layer.
 */
export function evalNetworkHalf(
  shape: NetworkShape,
  weights: Uint16Array,
  input: Float32Array,
  out: Float32Array,
  scratch: Float64Array,
  contract = false,
): void {
  const widest = Math.max(shape.inputs, shape.outputs, ...shape.hidden, 1);
  let current = scratch.subarray(0, widest);
  let next = scratch.subarray(widest, widest * 2);
  for (let i = 0; i < shape.inputs; i += 1) current[i] = roundHalf(input[i] as number);

  let at = 0;
  let previous = shape.inputs;
  const layers = shape.hidden.length + 1;
  for (let layer = 0; layer < layers; layer += 1) {
    const width = layer < shape.hidden.length ? (shape.hidden[layer] as number) : shape.outputs;
    const hidden = layer < shape.hidden.length;
    for (let o = 0; o < width; o += 1) {
      let sum = 0;
      for (let i = 0; i < previous; i += 1) {
        const product =
          (current[i] as number) * fromHalfBits(weights[at + o * previous + i] as number);
        sum = contract ? roundHalf(sum + product) : roundHalf(sum + roundHalf(product));
      }
      sum = roundHalf(sum + fromHalfBits(weights[at + width * previous + o] as number));
      const value = hidden ? (sum > 0 ? sum : 0) : sum;
      if (hidden) next[o] = value;
      else out[o] = value;
    }
    at += previous * width + width;
    previous = width;
    const swap = current;
    current = next;
    next = swap;
  }
}

/**
 * The largest magnitude any product, partial sum or output of the network can reach over the given
 * input box.
 *
 * **What a consumer asks before it chooses half precision.** Past 65,504 the format has no finite
 * value, and a partial sum can pass that on its way to a total that does not — so this bounds each
 * neuron by its bias plus the sum of every weight times the largest magnitude its input can take,
 * which covers every prefix of the sum at once. Intervals are carried through the layers, and a
 * rectifier clips them, which is what keeps the bound from growing without cause.
 */
export function activationBound(
  shape: NetworkShape,
  weights: Float32Array,
  low: Float32Array,
  high: Float32Array,
): number {
  let lower = Array.from({ length: shape.inputs }, (_, i) => low[i] as number);
  let upper = Array.from({ length: shape.inputs }, (_, i) => high[i] as number);
  let bound = 0;
  for (let i = 0; i < shape.inputs; i += 1) {
    bound = Math.max(bound, Math.abs(lower[i] as number), Math.abs(upper[i] as number));
  }
  let at = 0;
  let previous = shape.inputs;
  const layers = shape.hidden.length + 1;
  for (let layer = 0; layer < layers; layer += 1) {
    const width = layer < shape.hidden.length ? (shape.hidden[layer] as number) : shape.outputs;
    const hidden = layer < shape.hidden.length;
    const nextLower: number[] = [];
    const nextUpper: number[] = [];
    for (let o = 0; o < width; o += 1) {
      const bias = weights[at + width * previous + o] as number;
      let magnitude = Math.abs(bias);
      let min = bias;
      let max = bias;
      for (let i = 0; i < previous; i += 1) {
        const weight = weights[at + o * previous + i] as number;
        const a = weight * (lower[i] as number);
        const b = weight * (upper[i] as number);
        min += Math.min(a, b);
        max += Math.max(a, b);
        magnitude += Math.max(Math.abs(a), Math.abs(b));
      }
      bound = Math.max(bound, magnitude);
      nextLower.push(hidden ? Math.max(0, min) : min);
      nextUpper.push(hidden ? Math.max(0, max) : max);
    }
    at += previous * width + width;
    previous = width;
    lower = nextLower;
    upper = nextUpper;
  }
  return bound;
}

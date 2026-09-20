import { describe, expect, test } from 'vitest';
import { HALF_MAX, halfWeights, roundHalf } from './half.ts';
import {
  activationBound,
  evalNetwork,
  evalNetworkHalf,
  halfPrecisionErrorBound,
  networkWeightCount,
} from './inference.ts';
import type { NetworkShape } from './inference.ts';

test('the weight count matches the layers a shape declares', () => {
  const shape: NetworkShape = { inputs: 2, hidden: [3], outputs: 1 };
  expect(networkWeightCount(shape)).toBe(2 * 3 + 3 + 3 * 1 + 1);
});

test('a one-layer identity network returns its input', () => {
  const shape: NetworkShape = { inputs: 2, hidden: [], outputs: 2 };
  const weights = Float32Array.from([1, 0, 0, 1, 0, 0]);
  const out = new Float32Array(2);
  evalNetwork(shape, weights, Float32Array.from([0.25, -3]), out, new Float32Array(8));
  expect(Array.from(out)).toEqual([0.25, -3]);
});

test('a hand-computed two-layer network returns the hand-computed answer', () => {
  const shape: NetworkShape = { inputs: 1, hidden: [2], outputs: 1 };
  /* hidden = relu([2,-1] * x + [0, 1]); out = [1, 1] . hidden + 0 */
  const weights = Float32Array.from([2, -1, 0, 1, 1, 1, 0]);
  const out = new Float32Array(1);
  evalNetwork(shape, weights, Float32Array.from([3]), out, new Float32Array(8));
  /* hidden = relu([6, -2]) = [6, 0]; out = 6 */
  expect(out[0]).toBeCloseTo(6, 6);
});

test('the activation applies to hidden layers and not to the output', () => {
  const shape: NetworkShape = { inputs: 1, hidden: [1], outputs: 1 };
  /* hidden = relu(1 * x + 0) = x for x > 0; out = -1 * hidden + 0, which must stay negative. */
  const weights = Float32Array.from([1, 0, -1, 0]);
  const out = new Float32Array(1);
  evalNetwork(shape, weights, Float32Array.from([2]), out, new Float32Array(8));
  expect(out[0]).toBeCloseTo(-2, 6);
});

test('the activation does clamp a hidden layer', () => {
  const shape: NetworkShape = { inputs: 1, hidden: [1], outputs: 1 };
  const weights = Float32Array.from([1, 0, 1, 0]);
  const out = new Float32Array(1);
  evalNetwork(shape, weights, Float32Array.from([-5]), out, new Float32Array(8));
  expect(out[0]).toBe(0);
});

test('evaluation is deterministic', () => {
  const shape: NetworkShape = { inputs: 2, hidden: [4, 3], outputs: 2 };
  const weights = new Float32Array(networkWeightCount(shape));
  for (let i = 0; i < weights.length; i += 1) weights[i] = Math.sin(i) * 0.5;
  const a = new Float32Array(2);
  const b = new Float32Array(2);
  const input = Float32Array.from([0.3, -0.7]);
  evalNetwork(shape, weights, input, a, new Float32Array(16));
  evalNetwork(shape, weights, input, b, new Float32Array(16));
  expect(Array.from(a)).toEqual(Array.from(b));
});

/** A small deterministic generator, so a failing corpus names the seed that reproduces it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A network of the size the device runs, with weights in [-1, 1]. */
function randomNetwork(next: () => number): { shape: NetworkShape; weights: Float32Array } {
  const layers = Math.floor(next() * 3);
  const hidden = Array.from({ length: layers }, () => 1 + Math.floor(next() * 16));
  const shape: NetworkShape = {
    inputs: 1 + Math.floor(next() * 4),
    hidden,
    outputs: 1 + Math.floor(next() * 4),
  };
  const weights = new Float32Array(networkWeightCount(shape));
  for (let i = 0; i < weights.length; i += 1) weights[i] = next() * 2 - 1;
  return { shape, weights };
}

describe('the half-precision path', () => {
  test('small integers survive it exactly, so the hand-computed network still answers six', () => {
    const shape: NetworkShape = { inputs: 1, hidden: [2], outputs: 1 };
    const weights = halfWeights(Float32Array.from([2, -1, 0, 1, 1, 1, 0]));
    const out = new Float32Array(1);
    evalNetworkHalf(shape, weights, Float32Array.from([3]), out, new Float64Array(8));
    expect(out[0]).toBe(6);
  });

  test('the activation applies to hidden layers and not to the output, here too', () => {
    const shape: NetworkShape = { inputs: 1, hidden: [1], outputs: 1 };
    const out = new Float32Array(1);
    const scratch = new Float64Array(8);
    evalNetworkHalf(
      shape,
      halfWeights(Float32Array.from([1, 0, -1, 0])),
      Float32Array.from([2]),
      out,
      scratch,
    );
    expect(out[0]).toBe(-2);
    evalNetworkHalf(
      shape,
      halfWeights(Float32Array.from([1, 0, 1, 0])),
      Float32Array.from([-5]),
      out,
      scratch,
    );
    expect(out[0]).toBe(0);
  });

  test('every intermediate is rounded, not only the weights', () => {
    /*
     * 1/3 rounds to 0x3555 = 0.333251953125, and three of those summed round again at each step. A
     * reference that rounded only the weights would answer 0.999755859375; one that rounds each sum
     * answers what a sixteen-bit adder does.
     */
    const shape: NetworkShape = { inputs: 3, hidden: [], outputs: 1 };
    const weights = halfWeights(Float32Array.from([1 / 3, 1 / 3, 1 / 3, 0]));
    const out = new Float32Array(1);
    evalNetworkHalf(shape, weights, Float32Array.from([1, 1, 1]), out, new Float64Array(8));
    const third = roundHalf(1 / 3);
    expect(out[0]).toBe(roundHalf(roundHalf(third + third) + third));
  });

  test('a partial sum that lands on a tie is rounded there, not only at the end', () => {
    /*
     * 1 + 2^-11 is exactly halfway between 1 and the next half-precision value, so it rounds to the
     * even neighbour, 1 — twice. Rounded only once at the end, the same sum is 1 + 2^-10.
     */
    const shape: NetworkShape = { inputs: 3, hidden: [], outputs: 1 };
    const weights = halfWeights(Float32Array.from([1, 2 ** -11, 2 ** -11, 0]));
    const out = new Float32Array(1);
    evalNetworkHalf(shape, weights, Float32Array.from([1, 1, 1]), out, new Float64Array(8));
    expect(out[0]).toBe(1);
  });

  test('the bias is added in half precision too', () => {
    const shape: NetworkShape = { inputs: 1, hidden: [], outputs: 1 };
    const weights = halfWeights(Float32Array.from([1, 2 ** -11]));
    const out = new Float32Array(1);
    evalNetworkHalf(shape, weights, Float32Array.from([1]), out, new Float64Array(8));
    expect(out[0]).toBe(1);
  });

  test('a contracted multiply-add rounds once, and can land on a different value', () => {
    /*
     * 1.25 times 1 + 2^-10 is 1.25 + 1.25 units of 2^-10, which rounds to one unit. Added to 1 that
     * is 2.25 + 2^-10, exactly halfway at 2.25's scale, and the tie goes to 2.25. Contracted, the
     * sum is 2.25 + 1.25 units of 2^-10 before any rounding, and that rounds up. A device may do
     * either, and this project's development machine does the second.
     */
    const shape: NetworkShape = { inputs: 2, hidden: [], outputs: 1 };
    const weights = halfWeights(Float32Array.from([1, 1 + 2 ** -10, 0]));
    const input = Float32Array.from([1, 1.25]);
    const out = new Float32Array(1);
    evalNetworkHalf(shape, weights, input, out, new Float64Array(8));
    expect(out[0]).toBe(2.25);
    evalNetworkHalf(shape, weights, input, out, new Float64Array(8), true);
    expect(out[0]).toBe(2.25 + 2 ** -9);
  });

  test('an input is rounded on the way in, before it is multiplied', () => {
    /*
     * 1 + 2^-11 rounds to 1, and 1 times (2 - 2^-10) is exact. Multiplied first, the same product is
     * 2 - 2^-21, which rounds to 2.
     */
    const shape: NetworkShape = { inputs: 1, hidden: [], outputs: 1 };
    const weights = halfWeights(Float32Array.from([2 - 2 ** -10, 0]));
    const out = new Float32Array(1);
    evalNetworkHalf(shape, weights, Float32Array.from([1 + 2 ** -11]), out, new Float64Array(8));
    expect(out[0]).toBe(2 - 2 ** -10);
  });

  test('it stays within its own error bound of the single-precision path, in either form', () => {
    /*
     * **A bound per network, not one tolerance for all.** A sampled tolerance is a claim about the
     * corpus that sampled it: 2,400 cases put the worst relative error at 0.00213, the device's own
     * corpus reached 0.0039 and 40,000 networks reached 0.0066. `halfPrecisionErrorBound` carries
     * half a unit in the last place through every rounding instead, so it holds for a network nobody
     * sampled — in both forms a device may compute, every operation rounded or each multiply-add
     * contracted into one rounding.
     */
    const scratch32 = new Float32Array(64);
    const scratch16 = new Float64Array(64);
    const single = new Float32Array(4);
    const half = new Float32Array(4);
    const input = new Float32Array(4);
    let breaches = 0;
    let tightest = 0;
    let cases = 0;
    for (let seed = 1; seed <= 1500; seed += 1) {
      const next = random(seed);
      const { shape, weights } = randomNetwork(next);
      const bits = halfWeights(weights);
      for (let i = 0; i < shape.inputs; i += 1) input[i] = next();
      const bound = halfPrecisionErrorBound(shape, weights, input.subarray(0, shape.inputs));
      evalNetwork(shape, weights, input, single, scratch32);
      for (const contract of [false, true]) {
        evalNetworkHalf(shape, bits, input, half, scratch16, contract);
        for (let o = 0; o < shape.outputs; o += 1) {
          const error = Math.abs((half[o] as number) - (single[o] as number));
          if (error > bound) breaches += 1;
          tightest = Math.max(tightest, error / bound);
        }
      }
      cases += 1;
    }
    expect(cases).toBe(1500);
    expect(breaches).toBe(0);
    /* And the bound is a bound on this arithmetic, not a number too large to mean anything. */
    expect(tightest).toBeGreaterThan(0.05);
  });

  test('the bound is its derivation, term by term, for a small network', () => {
    /*
     * **A corpus shows the bound holds; it cannot show every term is there**, because the
     * allowances overlap and dropping one rarely lets a sampled error through. So this is the
     * derivation written out, neuron by neuron, for a network with two inputs and two hidden
     * neurons — one of which the rectifier zeroes — and a term left out of the implementation is a
     * different number here.
     */
    const f = Math.fround;
    const half = (v: number) => Math.max(v * 2 ** -11, 2 ** -25);
    const single = (v: number) => Math.max(v * 2 ** -24, 2 ** -150);
    const drift = (v: number) => Math.abs(roundHalf(v) - v);

    /** One neuron: each input's error carried, each product and partial sum allowed a rounding. */
    const neuron = (inputs: Array<[number, number]>, weights: number[], bias: number) => {
      let exact = 0;
      let carried = 0;
      let magnitude = 0;
      let rounding = 0;
      for (const [k, [value, error]] of inputs.entries()) {
        const w = weights[k] as number;
        exact += value * w;
        carried += error * (Math.abs(w) + drift(w)) + Math.abs(value) * drift(w);
        const product = (Math.abs(value) + error) * (Math.abs(w) + drift(w));
        /* The magnitude a partial sum can reach includes the rounding already allowed for. */
        magnitude += product + rounding;
        rounding += half(product) + half(magnitude) + single(product) + single(magnitude);
      }
      exact += bias;
      carried += drift(bias);
      magnitude += Math.abs(bias) + drift(bias) + rounding;
      rounding += half(magnitude) + single(magnitude);
      return { exact, error: carried + rounding };
    };

    const x = [f(0.7), f(1 / 3)];
    const inputs: Array<[number, number]> = x.map((v) => [v, drift(v) + single(v)]);
    const hidden = [
      neuron(inputs, [f(1 / 3), f(-0.6)], f(0.2)),
      neuron(inputs, [f(-1.7), f(0.25)], f(-0.1)),
    ];
    expect(hidden[1]?.exact).toBeLessThan(0);
    const out = neuron(
      hidden.map((n) => [Math.max(0, n.exact), n.error]),
      [f(3.1), f(-2.3)],
      f(-0.45),
    );

    const shape: NetworkShape = { inputs: 2, hidden: [2], outputs: 1 };
    const weights = Float32Array.from([
      f(1 / 3),
      f(-0.6),
      f(-1.7),
      f(0.25),
      f(0.2),
      f(-0.1),
      f(3.1),
      f(-2.3),
      f(-0.45),
    ]);
    expect(halfPrecisionErrorBound(shape, weights, Float32Array.from(x))).toBeCloseTo(
      out.error,
      15,
    );
  });

  test('the bound is a few units in the last place where nothing rounds, and grows with the weights', () => {
    const shape: NetworkShape = { inputs: 1, hidden: [], outputs: 1 };
    /*
     * One times one plus zero: every value is exact in sixteen bits, and what is left is the
     * allowance for rounding a device might have done — half a unit in the last place per
     * operation, of which this network has three.
     */
    const exact = halfPrecisionErrorBound(shape, Float32Array.from([1, 0]), Float32Array.from([1]));
    expect(exact).toBeGreaterThan(0);
    expect(exact).toBeLessThanOrEqual(4 * 2 ** -11);
    const small = halfPrecisionErrorBound(
      shape,
      Float32Array.from([0.3, 0.1]),
      Float32Array.from([0.7]),
    );
    const large = halfPrecisionErrorBound(
      shape,
      Float32Array.from([300, 100]),
      Float32Array.from([0.7]),
    );
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small * 100);
  });

  test('a network that leaves the format overflows, and the bound says so first', () => {
    const shape: NetworkShape = { inputs: 1, hidden: [1], outputs: 1 };
    const weights = Float32Array.from([300, 0, 300, 0]);
    const out = new Float32Array(1);
    evalNetworkHalf(shape, halfWeights(weights), Float32Array.from([1]), out, new Float64Array(8));
    expect(out[0]).toBe(Infinity);
    const bound = activationBound(shape, weights, Float32Array.from([0]), Float32Array.from([1]));
    expect(bound).toBeGreaterThan(HALF_MAX);
  });
});

describe('the activation bound', () => {
  test('is exact for one linear neuron', () => {
    const shape: NetworkShape = { inputs: 1, hidden: [], outputs: 1 };
    const bound = activationBound(
      shape,
      Float32Array.from([2, 1]),
      Float32Array.from([0]),
      Float32Array.from([3]),
    );
    expect(bound).toBe(7);
  });

  test('covers every product, every partial sum and every output a network reaches', () => {
    /*
     * The bound is what makes the half path safe to choose, so it has to hold for the arithmetic
     * as a sixteen-bit adder sees it — including a partial sum larger than the total it ends at.
     */
    let observed = 0;
    let breaches = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed * 7919);
      const { shape, weights } = randomNetwork(next);
      for (let i = 0; i < weights.length; i += 1) weights[i] = (weights[i] as number) * 40;
      const low = Float32Array.from({ length: shape.inputs }, () => -next() * 3);
      const high = Float32Array.from(
        { length: shape.inputs },
        (_, i) => (low[i] as number) + next() * 6,
      );
      const bound = activationBound(shape, weights, low, high);
      for (let k = 0; k < 16; k += 1) {
        let current = Array.from(
          { length: shape.inputs },
          (_, i) => (low[i] as number) + next() * ((high[i] as number) - (low[i] as number)),
        );
        let at = 0;
        const widths = [...shape.hidden, shape.outputs];
        for (let layer = 0; layer < widths.length; layer += 1) {
          const width = widths[layer] as number;
          const nextLayer: number[] = [];
          for (let o = 0; o < width; o += 1) {
            let sum = 0;
            for (let i = 0; i < current.length; i += 1) {
              const product =
                (current[i] as number) * (weights[at + o * current.length + i] as number);
              sum += product;
              if (Math.abs(product) > bound * (1 + 1e-6)) breaches += 1;
              if (Math.abs(sum) > bound * (1 + 1e-6)) breaches += 1;
              observed = Math.max(observed, Math.abs(sum));
            }
            sum += weights[at + width * current.length + o] as number;
            if (Math.abs(sum) > bound * (1 + 1e-6)) breaches += 1;
            nextLayer.push(layer < widths.length - 1 ? Math.max(0, sum) : sum);
          }
          at += current.length * width + width;
          current = nextLayer;
        }
      }
    }
    expect(breaches).toBe(0);
    /* The corpus reaches values a half-precision adder would care about. */
    expect(observed).toBeGreaterThan(1000);
  });

  test('counts an input outside the format, which a network of zeros never multiplies up', () => {
    const shape: NetworkShape = { inputs: 1, hidden: [], outputs: 1 };
    const bound = activationBound(
      shape,
      Float32Array.from([0, 0]),
      Float32Array.from([-100000]),
      Float32Array.from([3]),
    );
    expect(bound).toBe(100000);
  });

  test('is tighter through an activation than without one', () => {
    /* A hidden neuron that is always negative contributes nothing after the rectifier. */
    const shape: NetworkShape = { inputs: 1, hidden: [1], outputs: 1 };
    const weights = Float32Array.from([-1, -10, 1000, 0]);
    const bound = activationBound(shape, weights, Float32Array.from([0]), Float32Array.from([1]));
    /* The hidden pre-activation reaches 11 in magnitude; the output is 1000 times zero. */
    expect(bound).toBe(11);
  });
});

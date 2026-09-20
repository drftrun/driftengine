/**
 * A multilayer perceptron that trains, in the layout the engine's evaluator reads.
 *
 * **One implementation of backpropagation and Adam, and nothing else**, because the networks the
 * engine evaluates are small enough that a framework would be a toolchain for one task. The weights
 * are `evalNetwork`'s: for each layer, the matrix row by row by output, then the biases — so what
 * this trains is uploaded as it stands, and `mlp.test.ts` holds its forward pass to the evaluator's
 * on weights that went through the `NNET` chunk and back.
 *
 * **Rectified hidden layers and a linear output**, which is the evaluator's convention and its
 * reason: an activation on the output clamps every channel into its range.
 *
 * **The arithmetic is double precision and the weights single**, since single is what is exported.
 * What it gives up: each step rounds the weights to single precision, which a learning rate small
 * enough to move a weight by less than its last place would stall on — far below any rate used here.
 */
import { networkWeightCount, type NetworkShape } from '../../packages/texture/src/inference.ts';

const BETA1 = 0.9;
const BETA2 = 0.999;
const EPSILON = 1e-8;

export class Mlp {
  /** What is exported: `evalNetwork`'s layout, single precision. */
  readonly weights: Float32Array;
  /** The loss's gradient, summed over the samples accumulated since the last step. */
  readonly gradient: Float64Array;
  private readonly moment: Float64Array;
  private readonly second: Float64Array;
  private steps = 0;
  private samples = 0;
  /* Each layer's activations, input first, and the loss's derivative against each. */
  private readonly layers: Float64Array[];
  private readonly deltas: Float64Array[];
  private readonly widths: number[];

  constructor(
    readonly shape: NetworkShape,
    random: () => number,
  ) {
    const count = networkWeightCount(shape);
    this.weights = new Float32Array(count);
    this.gradient = new Float64Array(count);
    this.moment = new Float64Array(count);
    this.second = new Float64Array(count);
    this.widths = [shape.inputs, ...shape.hidden, shape.outputs];
    this.layers = this.widths.map((width) => new Float64Array(width));
    this.deltas = this.widths.map((width) => new Float64Array(width));
    /* He initialisation for a rectifier, drawn uniform: a variance of 2 / fan-in, biases at zero. */
    let at = 0;
    for (let layer = 1; layer < this.widths.length; layer += 1) {
      const fanIn = this.widths[layer - 1] as number;
      const width = this.widths[layer] as number;
      const bound = Math.sqrt(6 / fanIn);
      for (let w = 0; w < fanIn * width; w += 1) this.weights[at + w] = (random() * 2 - 1) * bound;
      at += fanIn * width + width;
    }
  }

  /** Evaluate the network, as `evalNetwork` does. */
  forward(input: ArrayLike<number>, out: Float32Array): void {
    this.run(input);
    const last = this.layers[this.layers.length - 1] as Float64Array;
    for (let o = 0; o < this.shape.outputs; o += 1) out[o] = last[o] as number;
  }

  /**
   * Add one sample's gradient of half the squared error to `gradient`, and return that loss.
   */
  accumulate(input: ArrayLike<number>, target: ArrayLike<number>): number {
    this.run(input);
    const depth = this.widths.length - 1;
    const output = this.layers[depth] as Float64Array;
    const outDelta = this.deltas[depth] as Float64Array;
    let loss = 0;
    for (let o = 0; o < this.shape.outputs; o += 1) {
      const error = (output[o] as number) - (target[o] as number);
      outDelta[o] = error;
      loss += error * error;
    }
    let end = this.weights.length;
    for (let layer = depth; layer >= 1; layer -= 1) {
      const fanIn = this.widths[layer - 1] as number;
      const width = this.widths[layer] as number;
      const at = end - fanIn * width - width;
      const below = this.layers[layer - 1] as Float64Array;
      const delta = this.deltas[layer] as Float64Array;
      const belowDelta = this.deltas[layer - 1] as Float64Array;
      belowDelta.fill(0);
      for (let o = 0; o < width; o += 1) {
        const d = delta[o] as number;
        if (d === 0) continue;
        const row = at + o * fanIn;
        for (let i = 0; i < fanIn; i += 1) {
          this.gradient[row + i] = (this.gradient[row + i] as number) + d * (below[i] as number);
          belowDelta[i] = (belowDelta[i] as number) + d * (this.weights[row + i] as number);
        }
        const bias = at + fanIn * width + o;
        this.gradient[bias] = (this.gradient[bias] as number) + d;
      }
      /* Through the rectifier beneath, which passes a derivative only where it passed a value. */
      if (layer > 1) {
        for (let i = 0; i < fanIn; i += 1) if ((below[i] as number) <= 0) belowDelta[i] = 0;
      }
      end = at;
    }
    this.samples += 1;
    return loss / 2;
  }

  /** One Adam step on the mean of the accumulated gradient, which is then cleared. */
  step(rate: number): void {
    if (this.samples === 0) return;
    this.steps += 1;
    const scale = 1 / this.samples;
    const unbias1 = 1 - BETA1 ** this.steps;
    const unbias2 = 1 - BETA2 ** this.steps;
    for (let w = 0; w < this.weights.length; w += 1) {
      const g = (this.gradient[w] as number) * scale;
      const m = BETA1 * (this.moment[w] as number) + (1 - BETA1) * g;
      const v = BETA2 * (this.second[w] as number) + (1 - BETA2) * g * g;
      this.moment[w] = m;
      this.second[w] = v;
      this.weights[w] =
        (this.weights[w] as number) - (rate * (m / unbias1)) / (Math.sqrt(v / unbias2) + EPSILON);
    }
    this.gradient.fill(0);
    this.samples = 0;
  }

  private run(input: ArrayLike<number>): void {
    const first = this.layers[0] as Float64Array;
    for (let i = 0; i < this.shape.inputs; i += 1) first[i] = input[i] as number;
    let at = 0;
    const depth = this.widths.length - 1;
    for (let layer = 1; layer <= depth; layer += 1) {
      const fanIn = this.widths[layer - 1] as number;
      const width = this.widths[layer] as number;
      const below = this.layers[layer - 1] as Float64Array;
      const here = this.layers[layer] as Float64Array;
      for (let o = 0; o < width; o += 1) {
        let sum = this.weights[at + fanIn * width + o] as number;
        const row = at + o * fanIn;
        for (let i = 0; i < fanIn; i += 1)
          sum += (below[i] as number) * (this.weights[row + i] as number);
        here[o] = layer < depth && sum < 0 ? 0 : sum;
      }
      at += fanIn * width + width;
    }
  }
}

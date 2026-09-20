/**
 * A convolution with the batch norm after it folded in, once, where the weights are converted.
 *
 * **Folded as the upstream's `Conv2d_BN.fuse` folds it**: the kernel scaled by `γ/√(var + ε)` per
 * output, and the bias `β − mean·γ/√(var + ε)`. The converted file holds the folded pair under
 * names of its own and none of the statistics, and the step counter a batch norm keeps is set aside
 * by name. ε is PyTorch's default, 1e-5.
 *
 * What it gives up: the fold is computed in double precision and rounded once, where the upstream
 * evaluates the norm after the convolution in single precision — the two agree to a rounding.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

const EPSILON = 1e-5;

/**
 * `conv2d` of `x` by the convolution and batch norm under `p` — `c.` and `bn.`, the upstream's
 * names — padded to keep the grid at stride one.
 */
export function convBatchNorm(
  weights: Weights,
  graph: GraphBuilder,
  p: string,
  x: string,
  cin: number,
  cout: number,
  kernel: number,
  stride: number,
  groups: number,
): string {
  const shape = [cout, cin / groups, kernel, kernel];
  const scale = (values: (part: string, shape?: readonly number[]) => Float32Array): number[] => {
    const variance = values(`${p}bn.running_var`, [cout]);
    return Array.from(
      values(`${p}bn.weight`, [cout]),
      (gamma, o) => gamma / Math.sqrt((variance[o] as number) + EPSILON),
    );
  };
  const weight = weights.derive(`${p}folded.weight`, shape, (values) => {
    const factor = scale(values);
    const per = (cin / groups) * kernel * kernel;
    return Float32Array.from(
      values(`${p}c.weight`, shape),
      (w, i) => w * (factor[Math.floor(i / per)] as number),
    );
  });
  const bias = weights.derive(`${p}folded.bias`, [cout], (values) => {
    const factor = scale(values);
    const mean = values(`${p}bn.running_mean`, [cout]);
    return Float32Array.from(
      values(`${p}bn.bias`, [cout]),
      (beta, o) => beta - (mean[o] as number) * (factor[o] as number),
    );
  });
  weights.ignore(`${p}bn.num_batches_tracked`);
  return graph.node('conv2d', [x, weight, bias], { stride, padding: (kernel - 1) / 2, groups });
}

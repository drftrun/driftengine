/**
 * CLIP's encoder tower, which OWLv2's image and text graphs are each one of.
 *
 * **Pre-norm layers**: a layer norm, attention over the row's own window, and the projection added
 * back; then a layer norm, a perceptron, and that added back. The activation is the upstream's
 * quick GELU, `x·σ(1.702·x)`, which is the logistic and two multiplies rather than the error
 * function `gelu` computes.
 *
 * **A causal tower masks its scores** with −10⁴ above the diagonal, where the upstream uses the
 * least finite single. Both give a masked key a weight of exactly zero — exp of anything below
 * −104 is zero in single precision, and scores stay within a few hundred of each other — and −10⁴
 * is exact at half precision, where the upstream's value would be infinite and a device may assume
 * no infinities. **What would make it wrong** is scores reaching thousands, which would need a
 * checkpoint whose norms let them.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

export interface ClipTowerConfig {
  readonly dim: number;
  readonly heads: number;
  readonly depth: number;
  readonly hidden: number;
}

const EPSILON = 1e-5;
const MASKED = -1e4;

/**
 * CLIP's layers over `x`, `[batch · rows, dim]`, each batch's rows attending among themselves —
 * causally when `causal` is set.
 */
export function clipLayers(
  weights: Weights,
  graph: GraphBuilder,
  prefix: string,
  config: ClipTowerConfig,
  x: string,
  batch: number,
  rows: number,
  causal: boolean,
): string {
  const { dim, heads, hidden } = config;
  const node = graph.node.bind(graph);
  const w = (name: string, shape: readonly number[]): string =>
    weights.read(`${prefix}${name}`, shape);
  const linear = (value: string, p: string, out: number, inputs: number): string =>
    node('linear', [value, w(`${p}.weight`, [out, inputs]), w(`${p}.bias`, [out])]);
  const norm = (value: string, p: string): string =>
    node('layerNorm', [value, w(`${p}.weight`, [dim]), w(`${p}.bias`, [dim])], {
      epsilon: EPSILON,
    });
  const quick = weights.constant(
    `quick_gelu.${hidden}`,
    [hidden],
    new Float32Array(hidden).fill(1.702),
  );
  let mask: string | null = null;
  if (causal) {
    const table = new Float32Array(heads * rows * rows);
    for (let h = 0; h < heads; h += 1) {
      for (let q = 0; q < rows; q += 1) {
        for (let k = q + 1; k < rows; k += 1) table[(h * rows + q) * rows + k] = MASKED;
      }
    }
    mask = weights.constant(`causal.${heads}x${rows}`, [heads, rows, rows], table);
  }
  const batched = (value: string): string =>
    batch > 1 || mask !== null ? node('reshape', [value], { shape: [batch, rows, dim] }) : value;

  let out = x;
  for (let i = 0; i < config.depth; i += 1) {
    const p = `encoder.layers.${i}.`;
    const h = norm(out, `${p}layer_norm1`);
    const q = batched(linear(h, `${p}self_attn.q_proj`, dim, dim));
    const k = batched(linear(h, `${p}self_attn.k_proj`, dim, dim));
    const v = batched(linear(h, `${p}self_attn.v_proj`, dim, dim));
    let attended = node('attention', mask === null ? [q, k, v] : [q, k, v, mask], { heads });
    if (batch > 1 || mask !== null) {
      attended = node('reshape', [attended], { shape: [batch * rows, dim] });
    }
    out = node('add', [out, linear(attended, `${p}self_attn.out_proj`, dim, dim)]);
    const inner = linear(norm(out, `${p}layer_norm2`), `${p}mlp.fc1`, hidden, dim);
    const activated = node('mul', [inner, node('sigmoid', [node('mul', [inner, quick])])]);
    out = node('add', [out, linear(activated, `${p}mlp.fc2`, dim, hidden)]);
  }
  return out;
}

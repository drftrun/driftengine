/**
 * SAM's two-way transformer: a prompt's tokens and an image's, each attending to the other — the
 * part SAM, MobileSAM and SAM 2 share, under whichever names their checkpoints give it.
 *
 * **The tokens attend to themselves, then to the image, then pass an MLP; then the image attends back
 * to them.** Queries and keys are given their positions afresh at every attention — the tokens as
 * they were first given, the image by its grid's positions — while values are not. **The first
 * layer's self-attention replaces the tokens rather than adding to them**, and gives them no
 * positions, as the upstream's `skip_first_layer_pe` does; every later one is a residual. Attention
 * between tokens and image narrows to `dim / downsample`. Norms take PyTorch's default ε, 1e-5, and
 * the MLP's activation is ReLU in every checkpoint here.
 *
 * **One definition under two sets of names**, not two definitions: the original's checkpoints say
 * `out_proj`, `norm1` and `lin1` where Transformers' SAM 2 says `o_proj`, `layer_norm1` and
 * `proj_in`, and a copy for each would be two implementations of one network, free to drift.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

export interface TwoWayConfig {
  readonly dim: number;
  readonly heads: number;
  readonly mlp: number;
  readonly depth: number;
  readonly downsample: number;
}

/** What the two checkpoint layouts call the transformer's parts. */
export interface TwoWayNames {
  /** An attention's output projection. */
  readonly out: string;
  /** A layer's `i`-th norm, 1 to 4. */
  readonly norm: (i: number) => string;
  readonly finalNorm: string;
  /** The MLP's two projections. */
  readonly mlp: readonly [string, string];
}

/** The original SAM's names, which MobileSAM keeps. */
export const SAM_NAMES: TwoWayNames = {
  out: 'out_proj',
  norm: (i) => `norm${i}`,
  finalNorm: 'norm_final_attn',
  mlp: ['lin1', 'lin2'],
};

/** Transformers' names for SAM 2. */
export const SAM2_NAMES: TwoWayNames = {
  out: 'o_proj',
  norm: (i) => `layer_norm${i}`,
  finalNorm: 'layer_norm_final_attn',
  mlp: ['proj_in', 'proj_out'],
};

const EPSILON = 1e-5;

/**
 * The transformer under `prefix` over `tokens`, `[count, dim]`, and `image`, `[cells, dim]` in token
 * layout with `positions` of the same shape; answers both, attended.
 */
export function twoWay(
  weights: Weights,
  graph: GraphBuilder,
  prefix: string,
  config: TwoWayConfig,
  names: TwoWayNames,
  tokens: string,
  image: string,
  positions: string,
): { readonly queries: string; readonly keys: string } {
  const node = graph.node.bind(graph);
  const { dim, heads } = config;
  const read = weights.read.bind(weights);
  const linear = (x: string, p: string, out: number, inputs: number): string =>
    node('linear', [x, read(`${p}weight`, [out, inputs]), read(`${p}bias`, [out])]);
  const norm = (x: string, p: string): string =>
    node('layerNorm', [x, read(`${p}weight`, [dim]), read(`${p}bias`, [dim])], {
      epsilon: EPSILON,
    });
  const attend = (p: string, q: string, k: string, v: string, narrow: number): string => {
    const inner = dim / narrow;
    const attended = node(
      'attention',
      [
        linear(q, `${p}q_proj.`, inner, dim),
        linear(k, `${p}k_proj.`, inner, dim),
        linear(v, `${p}v_proj.`, inner, dim),
      ],
      { heads },
    );
    return linear(attended, `${p}${names.out}.`, dim, inner);
  };
  const [into, outOf] = names.mlp;

  let queries = tokens;
  let keys = image;
  for (let i = 0; i < config.depth; i += 1) {
    const p = `${prefix}layers.${i}.`;
    if (i === 0) {
      queries = attend(`${p}self_attn.`, queries, queries, queries, 1);
    } else {
      const q = node('add', [queries, tokens]);
      queries = node('add', [queries, attend(`${p}self_attn.`, q, q, queries, 1)]);
    }
    queries = norm(queries, `${p}${names.norm(1)}.`);
    let q = node('add', [queries, tokens]);
    let k = node('add', [keys, positions]);
    const toImage = attend(`${p}cross_attn_token_to_image.`, q, k, keys, config.downsample);
    queries = norm(node('add', [queries, toImage]), `${p}${names.norm(2)}.`);
    const hidden = node('relu', [linear(queries, `${p}mlp.${into}.`, config.mlp, dim)]);
    const mixed = linear(hidden, `${p}mlp.${outOf}.`, dim, config.mlp);
    queries = norm(node('add', [queries, mixed]), `${p}${names.norm(3)}.`);
    q = node('add', [queries, tokens]);
    k = node('add', [keys, positions]);
    const toTokens = attend(`${p}cross_attn_image_to_token.`, k, q, queries, config.downsample);
    keys = norm(node('add', [keys, toTokens]), `${p}${names.norm(4)}.`);
  }
  const q = node('add', [queries, tokens]);
  const k = node('add', [keys, positions]);
  const final = attend(`${prefix}final_attn_token_to_image.`, q, k, keys, config.downsample);
  queries = norm(node('add', [queries, final]), `${prefix}${names.finalNorm}.`);
  return { queries, keys };
}

/**
 * Multi-head attention, as a composition of the dense operators.
 *
 * **Heads are contiguous runs of channels, in the upstream order**: head `h` of `heads` owns
 * channels `h·d` to `(h+1)·d − 1`, where `d` is the channel count over the head count. A port that
 * interleaves them instead evaluates a network nobody trained.
 *
 * The queries, keys and values arrive already projected — the projections are matrix multiplies a
 * graph states on its own — so this is the part that is attention's alone: scores scaled by
 * `1/√d`, a stable softmax over each query's row, and the weighted sum of values.
 *
 * **A bias is added to the scaled scores**, `[heads][queries][keys]`, as a relative-position table
 * or a mask is upstream; and **a batch is independent windows**, each attending over its own keys
 * with the one bias. Queries and keys may differ in number, as they do where one set of tokens
 * reads another.
 */
import { softmax } from './linear.ts';

/**
 * `out[batch][queries][channels]` from `q` of that shape and `k` and `v` of
 * `[batch][keys][channels]`. `scratch` holds at least `queries × keys` values and is overwritten.
 */
export function attention(
  out: Float32Array,
  q: Float32Array,
  k: Float32Array,
  v: Float32Array,
  queries: number,
  keys: number,
  channels: number,
  heads: number,
  scratch: Float32Array,
  bias: Float32Array | null = null,
  batch = 1,
): void {
  const d = channels / heads;
  if (!Number.isInteger(d)) {
    throw new RangeError(`attention: ${channels} channels do not split into ${heads} heads`);
  }
  const scale = 1 / Math.sqrt(d);
  for (let b = 0; b < batch; b += 1) {
    const qAt = b * queries * channels;
    const kAt = b * keys * channels;
    for (let head = 0; head < heads; head += 1) {
      const first = head * d;
      for (let query = 0; query < queries; query += 1) {
        for (let key = 0; key < keys; key += 1) {
          let dot = 0;
          for (let c = 0; c < d; c += 1) {
            dot +=
              (q[qAt + query * channels + first + c] as number) *
              (k[kAt + key * channels + first + c] as number);
          }
          const at = query * keys + key;
          scratch[at] = dot * scale;
          if (bias !== null) {
            scratch[at] = (scratch[at] as number) + (bias[head * queries * keys + at] as number);
          }
        }
      }
      softmax(scratch, queries, keys, scratch);
      for (let query = 0; query < queries; query += 1) {
        for (let c = 0; c < d; c += 1) {
          let sum = 0;
          for (let key = 0; key < keys; key += 1) {
            sum +=
              (scratch[query * keys + key] as number) *
              (v[kAt + key * channels + first + c] as number);
          }
          out[qAt + query * channels + first + c] = sum;
        }
      }
    }
  }
}

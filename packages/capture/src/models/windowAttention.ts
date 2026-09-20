/**
 * Attention within the windows of a grid, as TinyViT attends: each window a batch of tokens, each
 * head's scores given a learned bias by the two tokens' distance.
 *
 * **Windows are partitioned as the upstream partitions them**: a grid the window does not divide is
 * padded with zeros after its last row and column *before* the attention's own norm, so a padded
 * token is the norm's β and is attended to as a key like any other — and the padding is sliced away
 * afterwards. A grid exactly one window across is attended whole.
 *
 * **The bias table is laid out once, at conversion**, `[heads, n, n]` from the learned vector of
 * `side²` distances, numbered in the order the upstream first meets them. What it gives up: the
 * table costs MobileSAM's file 2.4 MB at half precision, where a gather on the device would keep the
 * 3,000 learned values instead.
 *
 * **Queries, keys and values come out of one projection per head**, `[q k v]` for each head in turn
 * where the attention operator takes all queries, then all keys, then all values; the projection's
 * rows are reordered at conversion, which is where a head could otherwise be read as the wrong one's
 * keys. The norm takes PyTorch's default ε, 1e-5.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

const EPSILON = 1e-5;

/**
 * `[rows · cols, dim]` from `x` of that shape: the attention under `p` — `norm.`, `qkv.`, `proj.` and
 * `attention_biases`, the upstream's names — within windows `side` tokens square.
 */
export function windowAttention(
  weights: Weights,
  graph: GraphBuilder,
  p: string,
  x: string,
  dim: number,
  heads: number,
  side: number,
  rows: number,
  cols: number,
): string {
  const node = graph.node.bind(graph);
  const norm = (value: string, q: string): string =>
    node('layerNorm', [value, weights.read(`${q}weight`, [dim]), weights.read(`${q}bias`, [dim])], {
      epsilon: EPSILON,
    });
  const linear = (value: string, q: string, out: number, inputs: number): string =>
    node('linear', [
      value,
      weights.read(`${q}weight`, [out, inputs]),
      weights.read(`${q}bias`, [out]),
    ]);
  const n = side * side;
  const whole = rows === side && cols === side;
  const padRows = (side - (rows % side)) % side;
  const padCols = (side - (cols % side)) % side;
  const across = (rows + padRows) / side;
  const down = (cols + padCols) / side;
  const count = whole ? 1 : across * down;
  let tokens = x;
  if (!whole) {
    let grid = node('reshape', [x], { shape: [rows, cols, dim] });
    if (padRows > 0 || padCols > 0) grid = node('pad', [grid], { after: [padRows, padCols, 0] });
    const parts = node('reshape', [grid], { shape: [across, side, down, side, dim] });
    tokens = node('reshape', [node('permute', [parts], { order: [0, 2, 1, 3, 4] })], {
      shape: [count * n, dim],
    });
  }
  const qkv = node('linear', [
    norm(tokens, `${p}norm.`),
    splitHeads(weights, `${p}qkv.weight`, [3 * dim, dim], heads),
    splitHeads(weights, `${p}qkv.bias`, [3 * dim], heads),
  ]);
  const part = (i: number): string =>
    node('reshape', [node('slice', [qkv], { axis: 1, start: i * dim, end: (i + 1) * dim })], {
      shape: [count, n, dim],
    });
  const attended = node(
    'attention',
    [part(0), part(1), part(2), biasTable(weights, p, heads, side)],
    { heads },
  );
  const projected = linear(
    node('reshape', [attended], { shape: [count * n, dim] }),
    `${p}proj.`,
    dim,
    dim,
  );
  if (whole) return projected;
  const back = node(
    'permute',
    [node('reshape', [projected], { shape: [across, down, side, side, dim] })],
    {
      order: [0, 2, 1, 3, 4],
    },
  );
  let grid = node('reshape', [back], { shape: [rows + padRows, cols + padCols, dim] });
  if (padRows > 0) grid = node('slice', [grid], { axis: 0, start: 0, end: rows });
  if (padCols > 0) grid = node('slice', [grid], { axis: 1, start: 0, end: cols });
  return node('reshape', [grid], { shape: [rows * cols, dim] });
}

/**
 * The projection `name` with its rows in the attention operator's order — every head's queries,
 * then keys, then values — from the upstream's, where each head's three sit together.
 */
function splitHeads(
  weights: Weights,
  name: string,
  shape: readonly number[],
  heads: number,
): string {
  const rows = shape[0] as number;
  const width = rows / 3 / heads;
  const columns = shape.length === 2 ? (shape[1] as number) : 1;
  return weights.derive(name.replace(/\.(weight|bias)$/, '.split.$1'), shape, (values) => {
    const from = values(name, shape);
    const out = new Float32Array(from.length);
    for (let head = 0; head < heads; head += 1) {
      for (let part = 0; part < 3; part += 1) {
        for (let j = 0; j < width; j += 1) {
          const source = (head * 3 + part) * width + j;
          const target = part * heads * width + head * width + j;
          out.set(from.subarray(source * columns, (source + 1) * columns), target * columns);
        }
      }
    }
    return out;
  });
}

/**
 * `[heads, n, n]`: each pair of a window's tokens given its head's learned bias for their distance
 * in rows and in columns, the distances numbered in the order the upstream first meets them.
 */
function biasTable(weights: Weights, p: string, heads: number, side: number): string {
  const n = side * side;
  return weights.derive(`${p}attention_bias_table`, [heads, n, n], (values) => {
    const learned = values(`${p}attention_biases`, [heads, n]);
    const numbered = new Map<number, number>();
    const index = new Int32Array(n * n);
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) {
        const offset =
          Math.abs(Math.floor(a / side) - Math.floor(b / side)) * side +
          Math.abs((a % side) - (b % side));
        if (!numbered.has(offset)) numbered.set(offset, numbered.size);
        index[a * n + b] = numbered.get(offset) as number;
      }
    }
    const out = new Float32Array(heads * n * n);
    for (let head = 0; head < heads; head += 1) {
      for (let i = 0; i < n * n; i += 1)
        out[head * n * n + i] = learned[head * n + (index[i] as number)] as number;
    }
    return out;
  });
}

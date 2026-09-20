/**
 * One Hiera block's attention: within windows of its grid, or over the whole grid, its queries
 * pooled 2×2 within each window where the block changes stage.
 *
 * **Windows are partitioned after the block's norm**, padded with zeros where the window does not
 * divide the grid — so a padded token is zero, where TinyViT's is its norm's β — and unpartitioned
 * by the queries' window, the padding recomputed for the pooled grid, as the upstream's
 * `window_unpartition` is given it. The projection lays each head's queries, keys and values out
 * contiguously, as the attention operator takes them.
 */
import type { GraphBuilder, Weights } from '@driftengine/texture';

/**
 * `[rows² or (rows/2)², out]` from `normed`, `[rows², dim]`: the attention under `p` within windows
 * of `side` — the whole grid for 0 — pooling its queries when `pool`.
 */
export function hieraAttention(
  weights: Weights,
  graph: GraphBuilder,
  p: string,
  normed: string,
  rows: number,
  dim: number,
  out: number,
  heads: number,
  side: number,
  pool: boolean,
): string {
  const node = graph.node.bind(graph);
  const linear = (x: string, q: string, outputs: number, inputs: number): string =>
    node('linear', [
      x,
      weights.read(`${q}weight`, [outputs, inputs]),
      weights.read(`${q}bias`, [outputs]),
    ]);

  const span = side === 0 ? rows : side;
  const pad = (span - (rows % span)) % span;
  const across = (rows + pad) / span;
  const count = across * across;
  let tokens = normed;
  if (side > 0) {
    let map = node('reshape', [normed], { shape: [rows, rows, dim] });
    if (pad > 0) map = node('pad', [map], { after: [pad, pad, 0] });
    tokens = node(
      'reshape',
      [
        node('permute', [node('reshape', [map], { shape: [across, span, across, span, dim] })], {
          order: [0, 2, 1, 3, 4],
        }),
      ],
      { shape: [count * span * span, dim] },
    );
  }
  const qkv = linear(tokens, `${p}attn.qkv.`, 3 * out, dim);
  const part = (i: number): string =>
    node('slice', [qkv], { axis: 1, start: i * out, end: (i + 1) * out });
  let queries = node('reshape', [part(0)], { shape: [count, span * span, out] });
  let qSpan = span;
  if (pool) {
    /* Each window's queries as a map, pooled 2×2: windows and channels together as the pool's planes. */
    const maps = node(
      'reshape',
      [
        node('permute', [node('reshape', [part(0)], { shape: [count, span, span, out] })], {
          order: [0, 3, 1, 2],
        }),
      ],
      { shape: [count * out, span, span] },
    );
    qSpan = span / 2;
    queries = node(
      'reshape',
      [
        node(
          'permute',
          [
            node('reshape', [node('maxPool2d', [maps], { kernel: 2 })], {
              shape: [count, out, qSpan, qSpan],
            }),
          ],
          { order: [0, 2, 3, 1] },
        ),
      ],
      { shape: [count, qSpan * qSpan, out] },
    );
  }
  const keys = node('reshape', [part(1)], { shape: [count, span * span, out] });
  const values = node('reshape', [part(2)], { shape: [count, span * span, out] });
  const attended = node('attention', [queries, keys, values], { heads });
  const projected = linear(
    node('reshape', [attended], { shape: [count * qSpan * qSpan, out] }),
    `${p}attn.proj.`,
    out,
    out,
  );
  if (side === 0) return projected;
  /* Unpartitioned by the queries' window, the padding recomputed for the pooled grid. */
  const pooledRows = pool ? rows / 2 : rows;
  const qPad = (qSpan - (pooledRows % qSpan)) % qSpan;
  const qAcross = (pooledRows + qPad) / qSpan;
  let map = node(
    'reshape',
    [
      node(
        'permute',
        [node('reshape', [projected], { shape: [qAcross, qAcross, qSpan, qSpan, out] })],
        { order: [0, 2, 1, 3, 4] },
      ),
    ],
    { shape: [pooledRows + qPad, pooledRows + qPad, out] },
  );
  if (qPad > 0) {
    map = node('slice', [node('slice', [map], { axis: 0, start: 0, end: pooledRows })], {
      axis: 1,
      start: 0,
      end: pooledRows,
    });
  }
  return node('reshape', [map], { shape: [pooledRows * pooledRows, out] });
}

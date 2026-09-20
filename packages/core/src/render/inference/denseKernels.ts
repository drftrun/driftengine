/**
 * The dense operators on the device: projections, activations, normalisation, softmax, attention.
 * The logistic is `1/(1 + exp(−x))` as written, which overflows to 0 far to the left, as it should.
 *
 * **`linear` is the engine's first kernel to use workgroup memory**: a 16 by 16 tile of the input
 * and one of the weight are staged per step, so each value read from storage serves sixteen
 * multiply-adds rather than one. Its sum runs in tile order, not the reference's index order, so it
 * agrees with the reference to within a bound on its rounding rather than bit for bit — which
 * `scripts/inference-parity.mjs` derives per output from the inputs, never samples.
 *
 * **Normalisation and softmax take one workgroup per row**, reducing through workgroup memory.
 * **Attention takes one invocation per window, query and head**, over its own window's keys with any
 * bias added to the scaled scores, and makes one pass over them with the running-maximum softmax: each new maximum rescales what has been gathered so far, so the scores
 * are computed once and nothing of size tokens × tokens is ever stored. What it gives up is reuse:
 * every invocation reads every key and value from storage. At a depth model's shapes that is 1.65
 * ms of each 2.8 ms block (an RX 9070 XT, measured in the encoder), so attention is the first
 * kernel to tile when a budget asks — keys and values staged in workgroup memory, read once a
 * workgroup rather than once an invocation.
 *
 * **GELU is the exact one, through an `erf` accurate to 1.5e-7** (Abramowitz and Stegun 7.1.26) —
 * the tanh approximation differs by 4e-4 and is a different network. The bound it costs is stated
 * with the parity check.
 */
import { tiledAttention, tiledAttentionFits } from './attentionTiled.ts';
import {
  type KernelGenerator,
  type KernelRequest,
  float,
  header,
  num,
  perElement,
  perRow,
  read,
  size,
} from './kernelKit.ts';

/**
 * The tile edge `linear` stages in workgroup memory, chosen by `tools/capture-weights/opbudget.ts`:
 * at a depth model's shapes — 1,370 rows, 384 and 1,536 wide — 16 took 0.36 ms a multiply where 8
 * took 0.40 on the two wide ones, and the two tied on the narrow one (an RX 9070 XT on Dawn,
 * 2026-09-19). What would change it is a device that runs 256 invocations a workgroup badly: 8 is
 * the other edge a device's default limit admits.
 */
export const LINEAR_TILE = 16;

/**
 * The tiled multiply at a given tile edge, which is a parameter only so the cost tool can measure
 * the alternatives: a tile of `t` is `t × t` invocations, so 8 and 16 are the two a device's default
 * limit of 256 admits.
 *
 * **A `gelu` activation is applied as the sum is written**, which is what `fuse.ts` asks for when a
 * GELU is the only reader of a multiply: one dispatch and one buffer fewer, and the pre-activation
 * value never reaches memory.
 */
export function linearKernel(tile: number): KernelGenerator {
  return (request) => {
    const [rows, ins] = request.inputShapes[0] as [number, number];
    const outs = (request.inputShapes[1] as readonly number[])[0] as number;
    const bias = request.inputShapes.length > 2 ? ` + ${read(request, 2, 'col')}` : '';
    const gelu = request.attributes['activation'] === 'gelu';
    const value = gelu ? `geluExact(sum${bias})` : `sum${bias}`;
    return {
      code: `${header(request)}
${gelu ? `\n${GELU}\n` : ''}
var<workgroup> tileA: array<f32, ${tile * tile}>;
var<workgroup> tileW: array<f32, ${tile * tile}>;

@compute @workgroup_size(${tile}, ${tile})
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let row = group.y * ${tile}u + local.y;
  let col = group.x * ${tile}u + local.x;
  let weightRow = group.x * ${tile}u + local.y;
  var sum = 0.0;
  for (var t = 0u; t < ${ins}u; t = t + ${tile}u) {
    let a = t + local.x;
    tileA[local.y * ${tile}u + local.x] = select(0.0, ${read(request, 0, `min(row * ${ins}u + a, ${rows * ins - 1}u)`)}, row < ${rows}u && a < ${ins}u);
    tileW[local.x * ${tile}u + local.y] = select(0.0, ${read(request, 1, `min(weightRow * ${ins}u + a, ${outs * ins - 1}u)`)}, weightRow < ${outs}u && a < ${ins}u);
    workgroupBarrier();
    for (var k = 0u; k < ${tile}u; k = k + 1u) {
      sum = sum + tileA[local.y * ${tile}u + k] * tileW[k * ${tile}u + local.x];
    }
    workgroupBarrier();
  }
  if (row < ${rows}u && col < ${outs}u) {
    output[row * ${outs}u + col] = ${value};
  }
}
`,
      workgroups: [Math.ceil(outs / tile), Math.ceil(rows / tile), 1],
    };
  };
}

const unary =
  (expression: (x: string) => string, prelude = ''): KernelGenerator =>
  (request) => {
    const body = `  let x = ${read(request, 0, 'i')};\n  output[i] = ${expression('x')};`;
    const source = perElement(request, size(request.outputShape), body);
    return prelude === ''
      ? source
      : { ...source, code: source.code.replace('\n@compute', `\n${prelude}\n@compute`) };
  };

const ERF = `fn erfApprox(x: f32) -> f32 {
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return select(y, -y, x < 0.0);
}`;

/* The exact GELU over that erf, shared by the activation and a multiply it is fused into. */
const GELU = `${ERF}

fn geluExact(x: f32) -> f32 {
  return 0.5 * x * (1.0 + erfApprox(x * 0.70710678118654752));
}`;

const binary =
  (operator: string): KernelGenerator =>
  (request) => {
    const right = size(request.inputShapes[1] as readonly number[]);
    const index = right === size(request.outputShape) ? 'i' : `i % ${right}u`;
    return perElement(
      request,
      size(request.outputShape),
      `  output[i] = ${read(request, 0, 'i')} ${operator} ${read(request, 1, index)};`,
    );
  };

/* A tree reduction of `partial` over the workgroup, leaving the total in `partial[0]`. */
function reduce(combine: string): string {
  return `  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride = stride / 2u) {
    if (local.x < stride) {
      partial[local.x] = ${combine.replace('A', 'partial[local.x]').replace('B', 'partial[local.x + stride]')};
    }
    workgroupBarrier();
  }`;
}

function perRowKernel(
  request: KernelRequest,
  rows: number,
  body: string,
): { code: string; workgroups: [number, number, number] } {
  const grid = perRow(rows);
  return {
    code: `${header(request)}

var<workgroup> partial: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let row = ${grid.row};
  if (row >= ${rows}u) { return; }
${body}
}
`,
    workgroups: grid.workgroups,
  };
}

const layerNorm: KernelGenerator = (request) => {
  const [rows, cols] = request.inputShapes[0] as [number, number];
  const epsilon = num(request.attributes, 'epsilon', 1e-6);
  const x = (c: string): string => read(request, 0, `row * ${cols}u + ${c}`);
  return perRowKernel(
    request,
    rows,
    `  var sum = 0.0;
  for (var c = local.x; c < ${cols}u; c = c + 64u) { sum = sum + ${x('c')}; }
  partial[local.x] = sum;
${reduce('A + B')}
  let mean = partial[0] / ${float(cols)};
  workgroupBarrier();
  var squares = 0.0;
  for (var c = local.x; c < ${cols}u; c = c + 64u) { let d = ${x('c')} - mean; squares = squares + d * d; }
  partial[local.x] = squares;
${reduce('A + B')}
  let denominator = partial[0] / ${float(cols)} + ${float(epsilon)};
  let scale = select(0.0, inverseSqrt(denominator), denominator > 0.0);
  for (var c = local.x; c < ${cols}u; c = c + 64u) {
    output[row * ${cols}u + c] = (${x('c')} - mean) * scale * ${read(request, 1, 'c')} + ${read(request, 2, 'c')};
  }`,
  );
};

const softmax: KernelGenerator = (request) => {
  const shape = request.inputShapes[0] as readonly number[];
  const cols = shape[shape.length - 1] as number;
  const rows = size(shape) / cols;
  const x = (c: string): string => read(request, 0, `row * ${cols}u + ${c}`);
  return perRowKernel(
    request,
    rows,
    `  var largest = -3.4028234e38;
  for (var c = local.x; c < ${cols}u; c = c + 64u) { largest = max(largest, ${x('c')}); }
  partial[local.x] = largest;
${reduce('max(A, B)')}
  let top = partial[0];
  workgroupBarrier();
  var total = 0.0;
  for (var c = local.x; c < ${cols}u; c = c + 64u) { total = total + exp(${x('c')} - top); }
  partial[local.x] = total;
${reduce('A + B')}
  let sum = partial[0];
  for (var c = local.x; c < ${cols}u; c = c + 64u) {
    output[row * ${cols}u + c] = exp(${x('c')} - top) / sum;
  }`,
  );
};

/*
 * Attention, in one of three forms by how many queries and keys it has: the tiled form of
 * `attentionTiled.ts` for many of both, and otherwise one of these two by how many keys each query
 * reads.
 *
 * **Few keys: one invocation per window, query and head**, walking its window's keys with the
 * running-maximum softmax. **Many keys: one workgroup per window, query and head**, its 64 threads
 * each walking every 64th key the same way, then merging: the query's largest score found in a
 * tree, each thread's total and values rescaled to it by `exp` of its own maximum less that, and
 * summed in a tree. A query reading thousands of keys — a prompt's few tokens against an image —
 * otherwise runs on as many invocations as it has tokens and heads, which is a few dozen on a
 * device that wants tens of thousands.
 *
 * A bias is read at the head's, query's and key's score and added once scaled, in both.
 */
export function attentionKernel(
  splitKeys: number,
  tiled: { readonly queries: number; readonly keys: number } | null = null,
): KernelGenerator {
  return (request) => {
    const queryShape = request.inputShapes[0] as readonly number[];
    const [queries, channels] = queryShape.slice(-2) as [number, number];
    const keys = (request.inputShapes[1] as readonly number[]).at(-2) as number;
    const batch = queryShape.length === 3 ? (queryShape[0] as number) : 1;
    const heads = num(request.attributes, 'heads', 1);
    const d = channels / heads;
    if (tiled !== null && queries >= tiled.queries && keys >= tiled.keys && tiledAttentionFits(d)) {
      return tiledAttention(request);
    }
    const at = (i: number, token: string, c: string): string =>
      read(request, i, `${token} * ${channels}u + first + ${c}`);
    const bias =
      request.inputShapes.length > 3
        ? ` + ${read(request, 3, `(head * ${queries}u + row % ${queries}u) * ${keys}u + key`)}`
        : '';
    const setup = `  let row = i / ${heads}u;
  let head = i % ${heads}u;
  let first = head * ${d}u;
  let keyRow = (row / ${queries}u) * ${keys}u;
  var largest = -3.4028234e38;
  var total = 0.0;
  var gathered: array<f32, ${d}>;`;
    const walk = (
      from: string,
      step: string,
    ): string => `  for (var key = ${from}; key < ${keys}u; key = key + ${step}) {
    var dot = 0.0;
    for (var c = 0u; c < ${d}u; c = c + 1u) { dot = dot + ${at(0, 'row', 'c')} * ${at(1, '(keyRow + key)', 'c')}; }
    let score = dot * ${float(1 / Math.sqrt(d))}${bias};
    let top = max(largest, score);
    let rescale = exp(largest - top);
    let weight = exp(score - top);
    total = total * rescale + weight;
    for (var c = 0u; c < ${d}u; c = c + 1u) { gathered[c] = gathered[c] * rescale + weight * ${at(2, '(keyRow + key)', 'c')}; }
    largest = top;
  }`;
    if (keys < splitKeys) {
      return perElement(
        request,
        batch * queries * heads,
        `${setup}
${walk('0u', '1u')}
  for (var c = 0u; c < ${d}u; c = c + 1u) { output[row * ${channels}u + first + c] = gathered[c] / total; }`,
      );
    }
    /*
     * The merge: the workgroup's largest score first, then each thread's total and values rescaled
     * to it once and summed in a tree — the values `CHUNK` channels at a time, so the workgroup's
     * memory holds 64 threads' worth of one chunk however wide a head is.
     */
    const chunk = Math.ceil(d / Math.ceil(d / CHUNK));
    const tree = (step: string): string => `  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride = stride / 2u) {
    if (local.x < stride) { ${step} }
    workgroupBarrier();
  }`;
    const grid = perRow(batch * queries * heads);
    return {
      code: `${header(request)}

var<workgroup> tops: array<f32, 64>;
var<workgroup> totals: array<f32, 64>;
var<workgroup> sums: array<f32, ${64 * chunk}>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let i = ${grid.row};
  if (i >= ${batch * queries * heads}u) { return; }
${setup}
${walk('local.x', '64u')}
  tops[local.x] = largest;
${tree('tops[local.x] = max(tops[local.x], tops[local.x + stride]);')}
  let scale = exp(largest - tops[0]);
  totals[local.x] = total * scale;
${tree('totals[local.x] = totals[local.x] + totals[local.x + stride];')}
  let sum = totals[0];
  for (var part = 0u; part < ${d}u; part = part + ${chunk}u) {
    for (var c = 0u; c < ${chunk}u; c = c + 1u) {
      if (part + c < ${d}u) { sums[local.x * ${chunk}u + c] = gathered[part + c] * scale; }
    }
${tree(`for (var c = 0u; c < ${chunk}u; c = c + 1u) { sums[local.x * ${chunk}u + c] = sums[local.x * ${chunk}u + c] + sums[(local.x + stride) * ${chunk}u + c]; }`)}
    if (local.x == 0u) {
      for (var c = 0u; c < ${chunk}u; c = c + 1u) {
        if (part + c < ${d}u) { output[row * ${channels}u + first + part + c] = sums[c] / sum; }
      }
    }
    workgroupBarrier();
  }
}
`,
      workgroups: grid.workgroups,
    };
  };
}

/*
 * The most channels merged at a time: 64 threads' worth of 60 is 15 KB of the workgroup's 16, with
 * the maxima and totals beside them. A head is split into as few equal chunks as that allows.
 */
const CHUNK = 60;

/*
 * Where the split form starts, measured by `tools/capture-weights/opbudget.ts` on an RX 9070 XT:
 * split, a prompt's 7 tokens over 4,096 keys went from 1.42 ms to 0.031, 1,024 tokens from 1.47
 * to 0.98 and Depth Anything 3's 1,370 from 1.93 to 1.57 — and 512 tokens from 0.21 to 0.28, 256
 * from 0.104 to 0.121, and TinyViT's windows of 49 from 0.070 to 5.5, where a workgroup's merge
 * costs more than the keys it shares out. **What would move it** is a device whose invocations
 * cost differently against its workgroup memory; the number is this one's.
 *
 * **The merge's own cost**: rescaling at every level of the tree instead, carrying whole heads, was
 * 0.82 ms at 1,024 tokens where this is 0.98, and 1.48 at Depth Anything 3's shape where this is
 * 1.57 — and could not hold a head wider than 62 channels, which a memory attention's 256 is.
 */
export const ATTENTION_SPLIT_KEYS = 1024;

/*
 * Where the tiled form (`attentionTiled.ts`) takes over from both, measured the same way: from 64
 * queries and 128 keys. Tiled, 128 tokens in four heads of 64 went from 0.18 ms to 0.035, Depth
 * Anything 3's 721 from 1.02 to 0.33 and its 1,370 from 1.5 to 1.0, OWLv2's 3,601 from 22 to 10.5,
 * and a memory attention's 4,096 queries over 4,096 keys at a head of 256 from 57 to 12 — while a
 * prompt's 7 tokens over 4,096 keys went from 0.030 to 0.59, 4,096 queries over 7 keys from 0.007
 * to 0.015, and windows of 49 from 0.067 to 0.18, which the other two forms keep. Windows of 196
 * are nearly even, 0.23 against 0.20.
 */
export const ATTENTION_TILED = { queries: 64, keys: 128 } as const;

export const DENSE_KERNELS: readonly (readonly [string, KernelGenerator])[] = [
  ['linear', linearKernel(LINEAR_TILE)],
  ['relu', unary((x) => `max(${x}, 0.0)`)],
  ['gelu', unary((x) => `geluExact(${x})`, GELU)],
  ['sigmoid', unary((x) => `1.0 / (1.0 + exp(-${x}))`)],
  ['add', binary('+')],
  ['mul', binary('*')],
  ['layerNorm', layerNorm],
  ['softmax', softmax],
  ['attention', attentionKernel(ATTENTION_SPLIT_KEYS, ATTENTION_TILED)],
];

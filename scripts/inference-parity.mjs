/**
 * Do the network operators on the device agree with their references?
 *
 * **Each operator's kernel, dispatched once, against `@driftengine/texture`'s evaluator on a graph
 * of that one node**, at shapes that reach the kernel's branches — ragged tiles, strided rows, a
 * padded border, a clamped tap — and with seeded inputs, so a disagreement is reproducible from its
 * case alone. **Both precisions**: at half, every input a network would hold as a weight is stored
 * as half-precision bits on the device, and the reference runs on the same values rounded to half,
 * so the two are held to the single-precision bound — half precision here is storage, not
 * arithmetic (`schedule.ts`).
 *
 * **The bound is derived per output from the inputs** (`inferenceBounds.mjs`), and the operators
 * that only move values — the shape operators, `relu` — are held to bit equality, as are `add` and
 * `mul`, which are correctly rounded on the device and in the reference alike. Each operator also
 * has an **anchor**, a case worked by hand, which both the reference and the device must meet: the
 * two agreeing proves nothing if both are wrong the same way.
 *
 * **`--perturb=<name>` breaks one kernel as a real defect would**, and the run must then fail on
 * that operator: the check's bounds are only worth their tightness, and this is how that is shown.
 * The names are the keys of `PERTURBATIONS` below.
 *
 * Not a `*.test.mjs`, for the reason `gpu-parity.mjs` is not: it needs a GPU. It has a script of
 * its own rather than sections there because that one is about the GPU-driven pipeline. Run by
 * hand:
 *
 *     node scripts/inference-parity.mjs [--perturb=<name>]
 */
import { openGpuCompute } from '../packages/core/scripts/gpuCompute.mjs';
import { boundsFor, compareOutputs, describeOutcome, evaluateNode } from './inferenceCheck.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { DEVICE_KERNELS } = await import(`${ROOT}packages/core/src/render/inference/kernels.ts`);
const { toHalfFloats } = await import(`${ROOT}packages/core/src/render/halfFloat.ts`);
const { mulberry32 } = await import(`${ROOT}packages/core/src/core/rng.ts`);
const { fromHalfBits, roundHalf } = await import(`${ROOT}packages/texture/src/index.ts`);

const size = (shape) => shape.reduce((total, d) => total * d, 1);

/* ------------------------------------------------------------------------------------------------
 * Inputs
 * --------------------------------------------------------------------------------------------- */

/** An input's shape and values, and whether a network would hold it as a weight. */
const value = (shape, values) => ({ shape, values, weight: false });
const weight = (shape, values) => ({ shape, values, weight: true });

/** Seeded values uniform in [−scale, scale). */
function uniform(seed, count, scale = 1) {
  const next = mulberry32(seed);
  return Float32Array.from({ length: count }, () => (next() * 2 - 1) * scale);
}

/** Seeded values uniform in [low, high). */
function between(seed, count, low, high) {
  const next = mulberry32(seed);
  return Float32Array.from({ length: count }, () => low + next() * (high - low));
}

/* Each input takes the next seed, so a run is reproducible from this file alone. */
let seeds = 1000;
const seeded = (shape, scale = 1) => uniform((seeds += 1), size(shape), scale);

const input = (shape, scale) => value(shape, seeded(shape, scale));
const weights = (shape, scale) => weight(shape, seeded(shape, scale));

/* ------------------------------------------------------------------------------------------------
 * The cases: every operator at shapes that reach its branches
 * --------------------------------------------------------------------------------------------- */

const CASES = [
  /* The tiled multiply: ragged in every dimension, a tile-multiple, and a depth model's width. */
  {
    name: 'linear 5×37 → 19, bias',
    op: 'linear',
    inputs: [input([5, 37]), weights([19, 37], 0.2), weights([19], 0.5)],
  },
  { name: 'linear 33×70 → 40', op: 'linear', inputs: [input([33, 70]), weights([40, 70], 0.2)] },
  {
    name: 'linear 20×384 → 64, bias',
    op: 'linear',
    inputs: [input([20, 384]), weights([64, 384], 0.05), weights([64], 0.5)],
  },
  {
    name: 'linear 9×50 → 30 with GELU fused',
    op: 'linear',
    attributes: { activation: 'gelu' },
    inputs: [input([9, 50]), weights([30, 50], 0.5), weights([30], 1)],
  },
  /* Few taps, so the sum's allowance is small beside GELU's own, and a GELU defect shows here too. */
  {
    name: 'linear 7×4 → 12 with GELU fused, few taps',
    op: 'linear',
    attributes: { activation: 'gelu' },
    inputs: [input([7, 4]), weights([12, 4], 0.5), weights([12], 2)],
  },
  { name: 'relu 3×41', op: 'relu', inputs: [input([3, 41])] },
  { name: 'gelu over [−6, 6]', op: 'gelu', inputs: [input([2, 50], 6)] },
  { name: 'gelu 300', op: 'gelu', inputs: [input([300], 3)] },
  { name: 'sigmoid over [−10, 10]', op: 'sigmoid', inputs: [input([3, 50], 10)] },
  { name: 'sigmoid over [−90, 90], both tails', op: 'sigmoid', inputs: [input([200], 90)] },
  { name: 'add 4×30 + 4×30', op: 'add', inputs: [input([4, 30]), input([4, 30])] },
  { name: 'add 4×30 + a row, broadcast', op: 'add', inputs: [input([4, 30]), weights([30])] },
  { name: 'mul 4×30 · 4×30', op: 'mul', inputs: [input([4, 30]), input([4, 30])] },
  { name: 'mul 4×30 · a row, broadcast', op: 'mul', inputs: [input([4, 30]), weights([30])] },
  {
    name: 'layerNorm 4×10',
    op: 'layerNorm',
    inputs: [input([4, 10], 3), weights([10]), weights([10])],
  },
  {
    name: 'layerNorm 3×384',
    op: 'layerNorm',
    inputs: [input([3, 384]), weights([384]), weights([384])],
  },
  {
    name: 'layerNorm 2×64, one row constant',
    op: 'layerNorm',
    attributes: { epsilon: 1e-5 },
    inputs: [
      value(
        [2, 64],
        Float32Array.from({ length: 128 }, (_, i) => (i < 64 ? 0.37 : Math.sin(i))),
      ),
      weights([64]),
      weights([64]),
    ],
  },
  { name: 'softmax 3×5', op: 'softmax', inputs: [input([3, 5], 4)] },
  { name: 'softmax 2×150, strided', op: 'softmax', inputs: [input([2, 150], 4)] },
  {
    name: 'softmax 4×70, logits to 100',
    op: 'softmax',
    inputs: [value([4, 70], between(77, 280, 40, 100))],
  },
  { name: 'softmax 2×3×17', op: 'softmax', inputs: [input([2, 3, 17], 5)] },
  {
    name: 'attention 7 tokens, 3 heads of 4',
    op: 'attention',
    attributes: { heads: 3 },
    inputs: [input([7, 12]), input([7, 12]), input([7, 12])],
  },
  {
    name: 'attention 20 tokens, 2 heads of 8',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [input([20, 16], 2), input([20, 16], 2), input([20, 16])],
  },
  {
    name: 'attention 12 tokens, 2 heads of 64',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [input([12, 128]), input([12, 128]), input([12, 128])],
  },
  {
    name: 'attention 4 windows of 7 tokens, 2 heads of 16, a bias',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [input([4, 7, 32]), input([4, 7, 32]), input([4, 7, 32]), weights([2, 7, 7], 2)],
  },
  {
    name: 'attention 5 queries over 40 keys, 2 heads of 8',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [input([5, 16], 2), input([40, 16], 2), input([40, 16])],
  },
  {
    name: 'attention 30 queries over 3 keys, 1 head of 8',
    op: 'attention',
    attributes: { heads: 1 },
    inputs: [input([30, 8], 2), input([3, 8], 2), input([3, 8])],
  },
  {
    name: 'attention 3 queries over 1,100 keys, 2 heads of 16, keys split',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [input([3, 32], 2), input([1100, 32], 2), input([1100, 32])],
  },
  {
    name: 'attention 2 windows of 2 queries over 1,030 keys, 1 head of 64, a bias, keys split',
    op: 'attention',
    attributes: { heads: 1 },
    inputs: [
      input([2, 2, 64]),
      input([2, 1030, 64]),
      input([2, 1030, 64]),
      weights([1, 2, 1030], 2),
    ],
  },
  {
    name: 'attention 2 queries over 1,030 keys, 1 head of 128, keys split',
    op: 'attention',
    attributes: { heads: 1 },
    inputs: [input([2, 128]), input([1030, 128]), input([1030, 128])],
  },
  {
    name: 'attention 2 queries over 1,030 keys, 1 head of 256, keys split',
    op: 'attention',
    attributes: { heads: 1 },
    inputs: [input([2, 256], 0.5), input([1030, 256], 0.5), input([1030, 256])],
  },
  {
    name: 'attention 100 queries over 300 keys, 2 heads of 64, tiled',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [input([100, 128], 2), input([300, 128], 2), input([300, 128])],
  },
  {
    name: 'attention 70 queries over 150 keys, 1 head of 256, tiled',
    op: 'attention',
    attributes: { heads: 1 },
    inputs: [input([70, 256], 0.5), input([150, 256], 0.5), input([150, 256])],
  },
  {
    name: 'attention 3 windows of 80 queries over 130 keys, 2 heads of 96, a bias, tiled',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [
      input([3, 80, 192]),
      input([3, 130, 192]),
      input([3, 130, 192]),
      weights([2, 80, 130], 2),
    ],
  },
  {
    name: 'attention 5 tokens, scores to ±20',
    op: 'attention',
    attributes: { heads: 1 },
    inputs: [input([5, 8], 3), input([5, 8], 3), input([5, 8])],
  },
  {
    name: 'conv2d 3×7×9, 3×3, padded',
    op: 'conv2d',
    attributes: { stride: 1, padding: 1 },
    inputs: [input([3, 7, 9]), weights([4, 3, 3, 3], 0.3), weights([4])],
  },
  {
    name: 'conv2d 4×10×8, 3×3, stride 2',
    op: 'conv2d',
    attributes: { stride: 2, padding: 0 },
    inputs: [input([4, 10, 8]), weights([5, 4, 3, 3], 0.3)],
  },
  {
    name: 'conv2d 6×5×5, 1×1',
    op: 'conv2d',
    inputs: [input([6, 5, 5]), weights([2, 6, 1, 1]), weights([2])],
  },
  {
    name: 'conv2d 6×9×7, 3×3 depthwise, stride 2',
    op: 'conv2d',
    attributes: { stride: 2, padding: 1, groups: 6 },
    inputs: [input([6, 9, 7]), weights([6, 1, 3, 3], 0.3), weights([6])],
  },
  {
    name: 'conv2d 6×5×5, 3×3 in three groups',
    op: 'conv2d',
    attributes: { padding: 1, groups: 3 },
    inputs: [input([6, 5, 5]), weights([9, 2, 3, 3], 0.3)],
  },
  {
    name: 'convTranspose2d 4×3×5, 2×2, stride 2',
    op: 'convTranspose2d',
    attributes: { stride: 2, padding: 0 },
    inputs: [input([4, 3, 5]), weights([4, 3, 2, 2], 0.5), weights([3])],
  },
  {
    name: 'convTranspose2d 3×2×3, 4×4, stride 4',
    op: 'convTranspose2d',
    attributes: { stride: 4, padding: 0 },
    inputs: [input([3, 2, 3]), weights([3, 2, 4, 4], 0.5)],
  },
  {
    name: 'convTranspose2d 2×4×4, 3×3, stride 2, padded',
    op: 'convTranspose2d',
    attributes: { stride: 2, padding: 1 },
    inputs: [input([2, 4, 4]), weights([2, 3, 3, 3], 0.5), weights([3])],
  },
  {
    name: 'patchEmbed 3×28×42, patch 14',
    op: 'patchEmbed',
    attributes: { patch: 14 },
    inputs: [input([3, 28, 42]), weights([8, 3, 14, 14], 0.05), weights([8])],
  },
  {
    name: 'patchEmbed 3×10×12, patch 4',
    op: 'patchEmbed',
    attributes: { patch: 4 },
    inputs: [input([3, 10, 12]), weights([5, 3, 4, 4], 0.2)],
  },
  {
    name: 'resize bilinear 2×5×7 → 9×13',
    op: 'resize',
    attributes: { height: 9, width: 13, mode: 'bilinear', alignCorners: false },
    inputs: [input([2, 5, 7])],
  },
  {
    name: 'resize bilinear 1×9×13 → 4×5',
    op: 'resize',
    attributes: { height: 4, width: 5, mode: 'bilinear', alignCorners: false },
    inputs: [input([1, 9, 13])],
  },
  {
    name: 'resize bilinear 2×5×6 → 11×7, corners aligned',
    op: 'resize',
    attributes: { height: 11, width: 7, mode: 'bilinear', alignCorners: true },
    inputs: [input([2, 5, 6])],
  },
  {
    name: 'resize bicubic 2×6×6 → 11×9, a weight',
    op: 'resize',
    attributes: { height: 11, width: 9, mode: 'bicubic', alignCorners: false },
    inputs: [weights([2, 6, 6])],
  },
  {
    name: 'resize bicubic 1×5×7 → 13×10, corners aligned',
    op: 'resize',
    attributes: { height: 13, width: 10, mode: 'bicubic', alignCorners: true },
    inputs: [input([1, 5, 7])],
  },
  {
    name: 'resize bicubic 1×12×12 → 5×7',
    op: 'resize',
    attributes: { height: 5, width: 7, mode: 'bicubic', alignCorners: false },
    inputs: [input([1, 12, 12])],
  },
  {
    /* DINOv2's positional embeddings, 37 square to 21 wide, stepped by (grid + 0.1)/37 inverted. */
    name: 'resize bicubic 8×37×37 → 37×21, stepped as DINOv2 steps',
    op: 'resize',
    attributes: {
      height: 37,
      width: 21,
      mode: 'bicubic',
      alignCorners: false,
      stepHeight: 37 / 37.1,
      stepWidth: 37 / 21.1,
    },
    inputs: [weights([8, 37, 37])],
  },
  {
    name: 'permute 2×3×4 to (2, 0, 1)',
    op: 'permute',
    attributes: { order: [2, 0, 1] },
    inputs: [input([2, 3, 4])],
  },
  {
    name: 'permute 5×6 to (1, 0)',
    op: 'permute',
    attributes: { order: [1, 0] },
    inputs: [input([5, 6])],
  },
  {
    name: 'reshape 2×3×4 to 6×4',
    op: 'reshape',
    attributes: { shape: [6, 4] },
    inputs: [input([2, 3, 4])],
  },
  {
    name: 'concat a weight row before 5 tokens',
    op: 'concat',
    attributes: { axis: 0 },
    inputs: [weights([1, 8]), input([5, 8])],
  },
  {
    name: 'concat three along axis 1',
    op: 'concat',
    attributes: { axis: 1 },
    inputs: [input([2, 3, 4]), input([2, 5, 4]), input([2, 1, 4])],
  },
  {
    name: 'pad 5×3×4 to 7×7×4, as a window partition pads',
    op: 'pad',
    attributes: { after: [2, 4, 0] },
    inputs: [input([5, 3, 4])],
  },
  {
    name: 'pad a weight 3×5 by a row',
    op: 'pad',
    attributes: { after: [1, 0] },
    inputs: [weights([3, 5])],
  },
  {
    name: 'gather 12 rows of a 300×40 weight table, the first and last among them',
    op: 'gather',
    inputs: [
      weights([300, 40]),
      value([12], Float32Array.of(0, 299, 17, 17, 150, 3, 298, 1, 0, 64, 255, 200)),
    ],
  },
  {
    name: 'resize nearest 3×5×7 → 10×14, doubled',
    op: 'resize',
    attributes: { height: 10, width: 14, mode: 'nearest' },
    inputs: [input([3, 5, 7])],
  },
  {
    name: 'resize nearest 2×9×7 → 4×5',
    op: 'resize',
    attributes: { height: 4, width: 5, mode: 'nearest' },
    inputs: [input([2, 9, 7])],
  },
  {
    name: 'resize nearest a weight 2×3×3 → 7×4',
    op: 'resize',
    attributes: { height: 7, width: 4, mode: 'nearest' },
    inputs: [weights([2, 3, 3])],
  },
  {
    name: 'maxPool2d 3×9×10, 2×2, ragged',
    op: 'maxPool2d',
    attributes: { kernel: 2 },
    inputs: [input([3, 9, 10])],
  },
  {
    name: 'maxPool2d 2×8×8, 3×3 at stride 2',
    op: 'maxPool2d',
    attributes: { kernel: 3, stride: 2 },
    inputs: [input([2, 8, 8])],
  },
  {
    name: 'slice 6×8, rows 1 to 6',
    op: 'slice',
    attributes: { axis: 0, start: 1, end: 6 },
    inputs: [input([6, 8])],
  },
  {
    name: 'slice 2×5×4, axis 1, 2 to 4',
    op: 'slice',
    attributes: { axis: 1, start: 2, end: 4 },
    inputs: [input([2, 5, 4])],
  },
];

/* ------------------------------------------------------------------------------------------------
 * Anchors: one case per operator worked by hand, which the reference and the device must both meet
 * --------------------------------------------------------------------------------------------- */

const f32 = (...values) => Float32Array.from(values);
const ANCHORS = [
  {
    /* [1 2] · [[3 4] [5 6]]ᵀ + [½ −1] = [3 + 8 + ½, 5 + 12 − 1]. */
    name: 'linear by hand',
    op: 'linear',
    inputs: [value([1, 2], f32(1, 2)), weight([2, 2], f32(3, 4, 5, 6)), weight([2], f32(0.5, -1))],
    expected: [11.5, 16],
  },
  { name: 'relu by hand', op: 'relu', inputs: [value([3], f32(-2, 0, 3))], expected: [0, 0, 3] },
  {
    /* 0·Φ(0) = 0; Φ(1) = 0.8413447460685429; 10·Φ(10) is 10 in single precision; −10·Φ(−10). */
    name: 'gelu by hand',
    op: 'gelu',
    inputs: [value([4], f32(0, 1, 10, -10))],
    expected: [0, 0.8413447460685429, 10, -7.619853024160526e-23],
  },
  {
    name: 'add by hand',
    op: 'add',
    inputs: [value([2], f32(1.5, -2)), value([2], f32(0.25, 4))],
    expected: [1.75, 2],
  },
  {
    name: 'mul by hand',
    op: 'mul',
    inputs: [value([2], f32(1.5, -2)), value([2], f32(0.25, 4))],
    expected: [0.375, -8],
  },
  {
    /* Mean 2 and variance ⅔, so ±1/√⅔ = ±√1.5 either side of the middle. */
    name: 'layerNorm by hand',
    op: 'layerNorm',
    attributes: { epsilon: 0 },
    inputs: [value([1, 3], f32(1, 2, 3)), weight([3], f32(1, 1, 1)), weight([3], f32(0, 0, 0))],
    expected: [-1.224744871391589, 0, 1.224744871391589],
  },
  {
    /* e^0 : e^(ln 3) is 1 : 3; and 1,000 against 1,001 is the logistic of 1 — not NaN. */
    name: 'softmax by hand',
    op: 'softmax',
    inputs: [value([2, 2], f32(0, Math.log(3), 1000, 1001))],
    expected: [0.25, 0.75, 0.2689414213699951, 0.7310585786300049],
  },
  {
    /* Zero queries score every key alike, so each reads the mean of the values. */
    name: 'attention by hand',
    op: 'attention',
    inputs: [
      value([2, 2], f32(0, 0, 0, 0)),
      value([2, 2], f32(1, -2, 3, 5)),
      value([2, 2], f32(1, 2, 3, 6)),
    ],
    expected: [2, 4, 2, 4],
  },
  {
    /*
     * Every score its bias, zero for the one key each head and query picks and −10⁴ for the rest —
     * which half precision holds exactly and whose exponential is zero — in two windows of values.
     */
    name: 'attention masked by hand',
    op: 'attention',
    attributes: { heads: 2 },
    inputs: [
      value([2, 2, 2], new Float32Array(8)),
      value([2, 3, 2], new Float32Array(12)),
      value([2, 3, 2], f32(1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 50, 60)),
      weight([2, 2, 3], f32(0, -1e4, -1e4, -1e4, 0, -1e4, -1e4, -1e4, 0, 0, -1e4, -1e4)),
    ],
    expected: [1, 6, 3, 2, 10, 60, 30, 20],
  },
  {
    /* 1,024 equal scores, split across a workgroup: every weight one, so the mean of 0..1023. */
    name: 'attention with keys split by hand',
    op: 'attention',
    inputs: [
      value([1, 1], f32(0)),
      value([1024, 1], new Float32Array(1024)),
      value(
        [1024, 1],
        Float32Array.from({ length: 1024 }, (_, i) => i),
      ),
    ],
    expected: [511.5],
  },
  {
    /* 1..9, a 3×3 of ones padded by one: each output sums the window around it. */
    name: 'conv2d by hand',
    op: 'conv2d',
    attributes: { padding: 1 },
    inputs: [
      value([1, 3, 3], f32(1, 2, 3, 4, 5, 6, 7, 8, 9)),
      weight([1, 1, 3, 3], new Float32Array(9).fill(1)),
    ],
    expected: [12, 21, 16, 27, 45, 33, 24, 39, 28],
  },
  {
    /* Depthwise: all ones over 1..9, only the centre over 10..90, and neither sees the other. */
    name: 'conv2d depthwise by hand',
    op: 'conv2d',
    attributes: { groups: 2 },
    inputs: [
      value([2, 3, 3], f32(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90)),
      weight([2, 1, 3, 3], f32(1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0)),
    ],
    expected: [45, 50],
  },
  {
    /* σ(0) = ½ exactly; σ(ln 3) = ¾ and σ(−ln 3) = ¼, each to a rounding. */
    name: 'sigmoid by hand',
    op: 'sigmoid',
    inputs: [value([3], f32(0, Math.log(3), -Math.log(3)))],
    expected: [0.5, 0.75, 0.25],
  },
  {
    /* 1..4 doubled: each pixel a 2×2 block. */
    name: 'resize nearest by hand',
    op: 'resize',
    attributes: { height: 4, width: 4, mode: 'nearest' },
    inputs: [value([1, 2, 2], f32(1, 2, 3, 4))],
    expected: [1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4],
  },
  {
    /* 1..15 over 3 rows of 5, pooled 2×2: {1,2,6,7} and {3,4,8,9}, the ragged edge dropped. */
    name: 'maxPool2d by hand',
    op: 'maxPool2d',
    attributes: { kernel: 2 },
    inputs: [
      value(
        [1, 3, 5],
        Float32Array.from({ length: 15 }, (_, i) => i + 1),
      ),
    ],
    expected: [7, 9],
  },
  {
    /* [1 2 3; 4 5 6] padded by a row and two columns: zeros after the end, and nothing moved. */
    name: 'pad by hand',
    op: 'pad',
    attributes: { after: [1, 2] },
    inputs: [value([2, 3], f32(1, 2, 3, 4, 5, 6))],
    expected: [1, 2, 3, 0, 0, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    /* Rows 2, 0 and 2 of [1 2; 3 4; 5 6]. */
    name: 'gather by hand',
    op: 'gather',
    inputs: [value([3, 2], f32(1, 2, 3, 4, 5, 6)), value([3], f32(2, 0, 2))],
    expected: [5, 6, 1, 2, 5, 6],
  },
  {
    /* A 2×2 of ones at stride 2 writes each input into a block of its own. */
    name: 'convTranspose2d by hand',
    op: 'convTranspose2d',
    attributes: { stride: 2 },
    inputs: [value([1, 2, 2], f32(1, 2, 3, 4)), weight([1, 1, 2, 2], new Float32Array(4).fill(1))],
    expected: [1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4],
  },
  {
    /* Two 2×2 patches of 1..8 in a 2×4, summed: 1 + 2 + 5 + 6 and 3 + 4 + 7 + 8. */
    name: 'patchEmbed by hand',
    op: 'patchEmbed',
    attributes: { patch: 2 },
    inputs: [
      value([1, 2, 4], f32(1, 2, 3, 4, 5, 6, 7, 8)),
      weight([1, 1, 2, 2], new Float32Array(4).fill(1)),
    ],
    expected: [14, 22],
  },
  {
    /* PyTorch's own table for x + 2y at 2×2 resized to 4×4, half-pixel centres. */
    name: 'resize bilinear by hand',
    op: 'resize',
    attributes: { height: 4, width: 4, mode: 'bilinear', alignCorners: false },
    inputs: [value([1, 2, 2], f32(0, 1, 2, 3))],
    expected: [0, 0.25, 0.75, 1, 0.5, 0.75, 1.25, 1.5, 1.5, 1.75, 2.25, 2.5, 2, 2.25, 2.75, 3],
  },
  {
    /*
     * 0..3 to seven with aligned corners reads 0, ½, 1, … 3. At ½ the taps are the border 0, then
     * 0, 1, 2, weighed −0.09375, 0.59375, 0.59375, −0.09375: 0.40625; at 2½ they are 1, 2, 3 and
     * the border 3: 2.59375. At 1½ the four taps are inside and symmetric about it, so it reads 1½;
     * at a whole number the tap under it has all the weight.
     */
    name: 'resize bicubic by hand',
    op: 'resize',
    attributes: { height: 1, width: 7, mode: 'bicubic', alignCorners: true },
    inputs: [value([1, 1, 4], f32(0, 1, 2, 3))],
    expected: [0, 0.40625, 1, 1.5, 2, 2.59375, 3],
  },
  {
    name: 'permute by hand',
    op: 'permute',
    attributes: { order: [1, 0] },
    inputs: [value([2, 3], f32(1, 2, 3, 4, 5, 6))],
    expected: [1, 4, 2, 5, 3, 6],
  },
  {
    name: 'reshape by hand',
    op: 'reshape',
    attributes: { shape: [3, 2] },
    inputs: [value([2, 3], f32(1, 2, 3, 4, 5, 6))],
    expected: [1, 2, 3, 4, 5, 6],
  },
  {
    name: 'concat by hand',
    op: 'concat',
    attributes: { axis: 1 },
    inputs: [value([2, 2], f32(1, 2, 3, 4)), value([2, 1], f32(5, 6))],
    expected: [1, 2, 5, 3, 4, 6],
  },
  {
    name: 'slice by hand',
    op: 'slice',
    attributes: { axis: 0, start: 2, end: 5 },
    inputs: [value([6], f32(0, 1, 2, 3, 4, 5))],
    expected: [2, 3, 4],
  },
];

/* ------------------------------------------------------------------------------------------------
 * Perturbations: one real defect each, which the run must then fail on
 * --------------------------------------------------------------------------------------------- */

/** Each names the operator it breaks, and rewrites that operator's kernel as the defect would. */
const PERTURBATIONS = {
  /* One of A&S's coefficients wrong in its fourth figure. */
  'erf-coefficient': {
    ops: ['gelu', 'linear'],
    apply: (code) => code.replace('1.421413741', '1.421513741'),
  },
  /* The weight read as though it were stored inputs by outputs. */
  'weight-transposed': {
    ops: ['linear'],
    apply: (code, request) =>
      code.replace(
        /min\(weightRow \* \d+u \+ a, (\d+)u\)/,
        (_, last) => `min(a * ${request.inputShapes[1][0]}u + weightRow, ${last}u)`,
      ),
  },
  /* Both halves of a tile's edge guard dropped, so a ragged tile reads its neighbours. */
  'tile-edge': {
    ops: ['linear'],
    apply: (code, request) => code.replaceAll(` && a < ${request.inputShapes[0][1]}u)`, ')'),
  },
  /* The kernel flipped, which is a correlation read as a convolution. */
  'kernel-flipped': {
    ops: ['conv2d'],
    apply: (code, request) =>
      code.replace('u32(ky)) *', `u32(${request.inputShapes[1][2] - 1} - ky)) *`),
  },
  /* Every output reading the first group's channels, which a depthwise port gets wrong. */
  'group-ignored': {
    ops: ['conv2d'],
    apply: (code) => code.replace(/let first = \(o \/ \d+u\) \* (\d+)u;/, 'let first = 0u * $1u;'),
  },
  /* The half-pixel centre forgotten, which is the resize bug every port has. */
  'half-pixel': { ops: ['resize'], apply: (code) => code.replaceAll(' + 0.5) * ', ') * ') },
  /* The maximum not subtracted, so a large logit overflows. */
  'softmax-unstabilised': { ops: ['softmax'], apply: (code) => code.replaceAll(' - top)', ')') },
  /* The variance divided by one fewer than the row. */
  'variance-unbiased': {
    ops: ['layerNorm'],
    apply: (code, request) =>
      code.replace(
        /partial\[0\] \/ [\d.]+ \+ /,
        `partial[0] / ${request.inputShapes[0][1] - 1}.0 + `,
      ),
  },
  /* Scores not scaled by 1/√d. */
  'attention-unscaled': {
    ops: ['attention'],
    apply: (code) =>
      code
        .replace(/let score = dot \* [^;]+;/, 'let score = dot;')
        .replace(/(let score = partial\[[^\]]+\]) \* [\d.e+-]+/, '$1'),
  },
  /* Split keys merged without rescaling each thread's partial to the query's largest score. */
  'split-unrescaled': {
    ops: ['attention'],
    apply: (code) => code.replace('let scale = exp(largest - tops[0]);', 'let scale = 1.0;'),
  },
  /* Only the first chunk of a wide head's channels merged, the rest left unwritten. */
  'split-first-chunk-only': {
    ops: ['attention'],
    apply: (code) =>
      code.replace(/part < (\d+)u; part = part \+ (\d+)u/, 'part < $2u; part = part + $2u'),
  },
  /* Every split thread starting a key late, so each workgroup's first key is never read. */
  'split-first-key-skipped': {
    ops: ['attention'],
    apply: (code) =>
      code.replace(
        'for (var key = local.x; key <',
        'for (var key = local.x + select(0u, 1u, local.x == 0u); key <',
      ),
  },
  /* Each dot's shares summed over one group fewer, which drops a slice of every head. */
  'tiled-share-dropped': {
    ops: ['attention'],
    apply: (code) =>
      code.replace(
        /for \(var j = 0u; j < (\d+)u; j = j \+ 1u\) \{ sum = sum \+ partial/,
        (_, g) => `for (var j = 0u; j < ${Number(g) - 1}u; j = j + 1u) { sum = sum + partial`,
      ),
  },
  /* A ragged key tile read past the keys instead of stopping, which counts the last key again. */
  'tiled-ragged-keys': {
    ops: ['attention'],
    apply: (code) =>
      code.replace(/if \(key >= (\d+)u\) \{ break; \}/, 'if (key >= $1u + 3u) { break; }'),
  },
  /* Every window attending over the first window's keys. */
  'window-ignored': {
    ops: ['attention'],
    apply: (code) =>
      code
        .replace(/let keyRow = \(row \/ (\d+)u\)/, 'let keyRow = 0u * (row / $1u)')
        .replace(/let keyRow = window \* (\d+)u;/, 'let keyRow = 0u * window * $1u;'),
  },
  /* Every head reading the first head's bias, as a relative-position table indexed without it. */
  'bias-one-head': {
    ops: ['attention'],
    apply: (code) =>
      code
        .replace(/\(head \* (\d+)u \+ row/, '(0u * head * $1u + row')
        .replace(/\(head \* (\d+)u \+ min\(query/, '(0u * head * $1u + min(query'),
  },
  /* The logistic's exponent with its sign lost, which is `1 − σ`. */
  'sigmoid-sign': {
    ops: ['sigmoid'],
    apply: (code) => code.replace('exp(-', 'exp(0.0 + '),
  },
  /* Nearest rounding to the closer source instead of flooring, which is `nearest-exact`. */
  'nearest-rounded': {
    ops: ['resize'],
    apply: (code) =>
      code.replace(
        /u32\(floor\(f32\(i % (\d+)u\) \* ([\d.e+-]+)\)\)/,
        'u32(round(f32(i % $1u) * $2))',
      ),
  },
  /* A pool's window read one column short, missing its right edge. */
  'pool-window-narrow': {
    ops: ['maxPool2d'],
    apply: (code) => code.replace(/kx < (\d+)u;/, (_, k) => `kx < ${Number(k) - 1}u;`),
  },
  /* Every element read, the padding included, from wherever the index lands. */
  'pad-unguarded': {
    ops: ['pad'],
    apply: (code) =>
      code.replace(
        /if \(([^{]+)\) \{ output\[i\] = ([^;]+); \} else \{ output\[i\] = 0\.0; \}/,
        'output[i] = $2;',
      ),
  },
  /* Every row read one past the one named. */
  'gather-row-off': {
    ops: ['gather'],
    apply: (code) =>
      code.replace(/let row = min\(u32\((.+)\), (\d+)u\);/, 'let row = min(u32($1) + 1u, $2u);'),
  },
  /* A weight narrowed to half by truncation — the defect `halfBits` had until this wave. */
  'half-truncated': { ops: [], apply: (code) => code },
};

const perturbation = process.argv.find((arg) => arg.startsWith('--perturb='))?.slice(10);
if (perturbation !== undefined && PERTURBATIONS[perturbation] === undefined) {
  throw new Error(
    `no perturbation "${perturbation}"; there are ${Object.keys(PERTURBATIONS).join(', ')}`,
  );
}
let perturbed = 0;

/** Half-precision bits, as the runner uploads them — or truncated, under that perturbation. */
function halfBitsOf(values) {
  const bits = toHalfFloats(values);
  if (perturbation !== 'half-truncated') return bits;
  for (let i = 0; i < bits.length; i += 1) {
    if (Math.abs(fromHalfBits(bits[i])) > Math.abs(values[i])) {
      bits[i] -= 1;
      perturbed += 1;
    }
  }
  return bits;
}

/* ------------------------------------------------------------------------------------------------
 * Running a case
 * --------------------------------------------------------------------------------------------- */

/** The kernel for a case, as the runner would generate it, perturbed if this run asked. */
function kernelFor(op, attributes, inputs, outputShape, half) {
  const request = {
    inputShapes: inputs.map((entry) => entry.shape),
    outputShape,
    attributes,
    inputTypes: inputs.map((entry) => (half && entry.weight ? 'f16' : 'f32')),
  };
  const kernel = DEVICE_KERNELS.get(op)(request);
  const broken = PERTURBATIONS[perturbation];
  if (broken === undefined || !broken.ops.includes(op)) return { request, kernel };
  const code = broken.apply(kernel.code, request);
  if (code !== kernel.code) perturbed += 1;
  return { request, kernel: { ...kernel, code } };
}

async function runCase(compute, kase, half, expected) {
  const attributes = kase.attributes ?? {};
  /* At half, the reference reads what the device will: each weight rounded to the nearest half. */
  const inputs = kase.inputs.map((entry) =>
    half && entry.weight ? { ...entry, values: entry.values.map(roundHalf) } : entry,
  );
  const evaluated = evaluateNode(kase.op, attributes, inputs);
  const reference = expected ?? evaluated.y;
  const shape = evaluated.shape;
  const { request, kernel } = kernelFor(kase.op, attributes, kase.inputs, shape, half);
  const buffers = kase.inputs.map((entry, i) =>
    request.inputTypes[i] === 'f16'
      ? { type: 'f16', values: halfBitsOf(entry.values), readOnly: true }
      : { values: entry.values, readOnly: true },
  );
  buffers.push({ length: size(shape), read: true });
  const result = await compute.run({
    wgsl: kernel.code,
    workgroups: [...kernel.workgroups],
    features: request.inputTypes.includes('f16') ? ['shader-f16'] : [],
    buffers,
  });
  const device = result[kase.inputs.length];
  return compareOutputs(device, reference, boundsFor(kase.op, attributes, inputs, reference));
}

function describe(name, precision, outcome) {
  for (const line of describeOutcome(`${name} [${precision}]`, outcome)) console.log(line);
}

/* ------------------------------------------------------------------------------------------------
 * The run
 * --------------------------------------------------------------------------------------------- */

const missing = [...DEVICE_KERNELS.keys()].filter(
  (op) => !CASES.some((kase) => kase.op === op) || !ANCHORS.some((anchor) => anchor.op === op),
);
if (missing.length > 0) {
  throw new Error(`no case or no anchor for ${missing.join(', ')}: every kernel is checked`);
}

const compute = await openGpuCompute();
const failed = [];
try {
  const adapter = await compute.adapter();
  console.log(
    `adapter: ${adapter.vendor} ${adapter.architecture} ${adapter.description}`.trim() +
      (adapter.fallback ? ' — A FALLBACK ADAPTER' : '') +
      `; shader-f16 ${adapter.features.includes('shader-f16') ? 'yes' : 'no'}`,
  );
  if (adapter.fallback) throw new Error('a fallback adapter is not the device a player has');
  if (perturbation !== undefined) console.log(`perturbed: ${perturbation}`);

  for (const anchor of ANCHORS) {
    const expected = Float32Array.from(anchor.expected);
    const reference = evaluateNode(anchor.op, anchor.attributes ?? {}, anchor.inputs).y;
    const bounds = boundsFor(anchor.op, anchor.attributes ?? {}, anchor.inputs, expected);
    const off = [...reference].findIndex((v, i) => !(Math.abs(v - expected[i]) <= bounds[i]));
    if (off >= 0) {
      console.log(`FAIL ${anchor.name}: the reference gives ${reference[off]} at ${off}`);
      failed.push(anchor.name);
    }
    const outcome = await runCase(compute, anchor, false, expected);
    describe(anchor.name, 'single', outcome);
    if (outcome.outside.length > 0) failed.push(anchor.name);
  }
  for (const kase of CASES) {
    for (const half of [false, true]) {
      const outcome = await runCase(compute, kase, half);
      describe(kase.name, half ? 'half' : 'single', outcome);
      if (outcome.outside.length > 0) failed.push(`${kase.name} [${half ? 'half' : 'single'}]`);
    }
  }
} finally {
  await compute.close();
}

if (perturbation !== undefined && perturbed === 0) {
  throw new Error(`the perturbation "${perturbation}" changed nothing, so it tested nothing`);
}
if (failed.length > 0) {
  console.log(`\n${failed.length} disagreed: ${failed.join('; ')}`);
  process.exit(1);
}
console.log(`\nevery operator agrees with its reference, in both precisions`);

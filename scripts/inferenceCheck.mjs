/**
 * One node of a network checked against its reference: evaluate it, bound it, compare.
 *
 * **Shared by the two device checks, so there is one way to hold a node to its reference.**
 * `inference-parity.mjs` dispatches each operator's kernel alone in Chrome; `opbudget.ts` runs whole
 * graphs through the runner on Dawn and holds every node of the chain to its reference *given the
 * inputs the device actually produced for it* — which is what makes a derived bound usable on a
 * chain at all, since error compounds from layer to layer and a bound on the whole would have to
 * follow it through every one.
 *
 * An input is `{ shape, values }`; its values are what the reference reads, so a half-precision
 * weight arrives here already rounded to half.
 */
import {
  FLUSH,
  attentionBounds,
  dotBound,
  fusedGeluBound,
  geluBound,
  sigmoidBound,
  layerNormBounds,
  resizeBounds,
  softmaxBounds,
} from './inferenceBounds.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { createGraphEvaluator } = await import(`${ROOT}packages/texture/src/index.ts`);

/** The reference on a graph of one node — or a multiply and then GELU, for a fused one. */
export function evaluateNode(op, attributes, inputs) {
  const names = inputs.map((_, i) => `in${i}`);
  const fused = op === 'linear' && attributes.activation === 'gelu';
  const nodes = fused
    ? [
        { op: 'linear', inputs: names, output: 'pre', attributes: {} },
        { op: 'gelu', inputs: ['pre'], output: 'y', attributes: {} },
      ]
    : [{ op, inputs: names, output: 'y', attributes }];
  const evaluator = createGraphEvaluator({
    inputs: inputs.map((entry, i) => ({ name: names[i], shape: entry.shape })),
    outputs: fused ? ['pre', 'y'] : ['y'],
    nodes,
    tensors: new Map(),
  });
  const out = evaluator.run(new Map(inputs.map((entry, i) => [names[i], entry.values])));
  return {
    y: Float32Array.from(out.get('y')),
    pre: fused ? Float32Array.from(out.get('pre')) : null,
    shape: evaluator.shapes.get('y'),
  };
}

const absolute = (inputs) =>
  inputs.map((entry) => ({ ...entry, values: entry.values.map(Math.abs) }));

/** Each output's bound, derived from the inputs the reference was given. */
export function boundsFor(op, attributes, inputs, reference) {
  const shapes = inputs.map((entry) => entry.shape);
  const each = (bound) => Float64Array.from(reference, (_, i) => bound(i));
  const dot = (taps) => {
    const { activation, ...plain } = attributes;
    const magnitude = evaluateNode(op, plain, absolute(inputs)).y;
    if (activation !== 'gelu') {
      return each((i) => dotBound(taps, magnitude[i], reference[i]));
    }
    const { pre } = evaluateNode(op, attributes, inputs);
    return each((i) => fusedGeluBound(taps, magnitude[i], pre[i], reference[i]));
  };
  switch (op) {
    case 'linear':
      return dot(shapes[0][1]);
    case 'conv2d':
      /* The weight's own in-channels: a grouped convolution sums over its group, not the input. */
      return dot(shapes[1][1] * shapes[1][2] * shapes[1][3]);
    case 'convTranspose2d':
      return dot(shapes[0][0] * shapes[1][2] * shapes[1][3]);
    case 'patchEmbed':
      return dot(shapes[0][0] * attributes.patch ** 2);
    case 'sigmoid':
      return each((i) => sigmoidBound(inputs[0].values[i], reference[i]));
    case 'gelu':
      return each((i) => geluBound(inputs[0].values[i], reference[i]));
    case 'softmax':
      return softmaxBounds(inputs[0].values, shapes[0].at(-1), reference);
    case 'layerNorm':
      return layerNormBounds(
        inputs[0].values,
        shapes[0][1],
        inputs[1].values,
        attributes.epsilon ?? 1e-6,
        reference,
      );
    case 'attention': {
      const [q, k, v, bias] = inputs;
      const magnitude = evaluateNode(op, attributes, [
        q,
        k,
        absolute([v])[0],
        ...(bias === undefined ? [] : [bias]),
      ]).y;
      const [queries, channels] = shapes[0].slice(-2);
      return attentionBounds(
        q.values,
        k.values,
        bias?.values ?? null,
        shapes[0].length === 3 ? shapes[0][0] : 1,
        queries,
        shapes[1].at(-2),
        channels,
        attributes.heads ?? 1,
        magnitude,
        reference,
      );
    }
    case 'resize': {
      /* Nearest copies a source value, and is held bit for bit. */
      if (attributes.mode === 'nearest') return each(() => 0);
      const [channels, h, w] = shapes[0];
      return resizeBounds(
        inputs[0].values,
        channels,
        h,
        w,
        attributes.height,
        attributes.width,
        attributes.mode === 'bicubic',
        attributes.alignCorners === true,
        reference,
        typeof attributes.stepHeight === 'number'
          ? [attributes.stepHeight, attributes.stepWidth]
          : undefined,
      );
    }
    case 'add':
    case 'mul':
      /* Correctly rounded on both sides — by WGSL's rule, and by double rounding being innocuous
         for a single operation on singles (53 ≥ 2·24 + 2 bits) — so equal but for a flush. */
      return each(() => FLUSH);
    default:
      /* The shape operators and `relu` move values and compute nothing. */
      return each(() => 0);
  }
}

/** How a device's answer sits against the reference's, output by output. */
export function compareOutputs(device, reference, bounds) {
  let worst = 0;
  let share = 0;
  const outside = [];
  for (let i = 0; i < reference.length; i += 1) {
    const error = Math.abs(device[i] - reference[i]);
    /* An infinite bound would pass anything: a case that has no bound has failed. */
    if (!Number.isFinite(bounds[i]) || !(error <= bounds[i])) outside.push(i);
    worst = Math.max(worst, error);
    if (bounds[i] > 0) share = Math.max(share, error / bounds[i]);
  }
  if (device.length !== reference.length) outside.push(-1);
  return { device, reference, bounds, worst, share, outside };
}

/** One line for an outcome, and a line for each of its first three disagreements. */
export function describeOutcome(label, outcome) {
  const exact = outcome.bounds.every((bound) => bound <= FLUSH);
  const figure =
    outcome.worst === 0
      ? 'bit for bit'
      : exact
        ? `worst ${outcome.worst.toExponential(2)}`
        : `worst ${outcome.worst.toExponential(2)}, ${(outcome.share * 100).toFixed(1)}% of its bound`;
  const lines = [`${outcome.outside.length === 0 ? 'ok  ' : 'FAIL'} ${label} — ${figure}`];
  for (const i of outcome.outside.slice(0, 3)) {
    lines.push(
      i < 0
        ? `       the device wrote ${outcome.device.length} values, the reference ${outcome.reference.length}`
        : `       [${i}] device ${outcome.device[i]}, reference ${outcome.reference[i]}, bound ${outcome.bounds[i].toExponential(2)}`,
    );
  }
  return lines;
}

/**
 * OWLv2 base patch16 in the engine, finding four named things in a pinned real frame, held to its
 * upstream on the CPU and on the device at both precisions.
 *
 * **The engine half of the real model's parity.** `owlv2_parity.py` wrote the upstream's prepared
 * image, its token ids and its answers; this converts the same fetched checkpoint — verified by its
 * hash — into the image and text graphs, runs them over that very image, so preparation is not what
 * is compared, and reports how far each answer sits from the upstream's relative to its largest
 * value, how many detections agree, and how far their boxes land in the frame's own pixels.
 *
 * **The tokenizer is held to the upstream's exactly**, on the real vocabulary and on strings chosen
 * to be awkward: a token that differs is a query the text model was never asked.
 *
 * **It fails beyond a stated tolerance**, in `TOLERANCE`, each above what an RX 9070 XT measured —
 * the plan's Task 6 record has every figure.
 *
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/owlv2_parity.py
 *     npx tsx --conditions=drift-source tools/capture-weights/reference/owlv2_parity.ts [--cpu] [--device]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import gpu from '@kmamal/gpu';

import {
  OWLV2_BASE,
  clipTokenizer,
  owlv2Detections,
  owlv2Image,
  owlv2Logits,
  owlv2Text,
  owlv2Tokens,
} from '../../../packages/capture/src/index.ts';
import { openInferenceDevice } from '../../../packages/core/src/render/inference/device.ts';
import {
  createGraphRunner,
  type GraphRunner,
} from '../../../packages/core/src/render/inference/runner.ts';
import {
  createGraphEvaluator,
  graphForDevice,
  type NetworkGraph,
} from '../../../packages/texture/src/index.ts';
import { tensorFloats } from '../checkpoint.ts';
import { clipMerges } from '../clipMerges.ts';
import { convert } from '../convert.ts';
import { readSafetensors } from '../safetensors.ts';

const ROOT = new URL('../../..', import.meta.url).pathname;
const only = process.argv.includes('--cpu')
  ? 'cpu'
  : process.argv.includes('--device')
    ? 'device'
    : 'all';
const folder = path.join(ROOT, '.reference', 'owlv2-parity');
const answers = readSafetensors(
  new Uint8Array(readFileSync(path.join(folder, 'output.safetensors'))),
);
const answer = (name: string): Float32Array => tensorFloats(name, answers.get(name) as never);
const asked = JSON.parse(readFileSync(path.join(folder, 'tokens.json'), 'utf8')) as {
  queries: string[];
  strings: Record<string, number[]>;
};
const [height, width] = Array.from(answer('original')) as [number, number];
const config = OWLV2_BASE;
const count = asked.queries.length;

const { models } = JSON.parse(
  readFileSync(path.join(ROOT, 'tools', 'capture-weights', 'manifest.json'), 'utf8'),
) as {
  models: {
    name: string;
    sha256: string;
    file: string;
    extra?: { file: string; sha256: string }[];
  }[];
};
const model = models.find((entry) => entry.name === 'owlv2-base-patch16');
if (model === undefined) throw new Error('the manifest has no owlv2-base-patch16');
const at = path.join(ROOT, 'models', 'capture', model.name);
const checkpoint = new Uint8Array(readFileSync(path.join(at, path.basename(model.file))));
const pinned = { sha256: model.sha256, format: 'safetensors' } as const;
const merges = clipMerges(
  readFileSync(path.join(at, 'merges.txt'), 'utf8'),
  JSON.parse(readFileSync(path.join(at, 'vocab.json'), 'utf8')) as Record<string, number>,
);
const beside = new Map([['tokenizer.merges', { shape: [merges.length / 2, 2], data: merges }]]);
const graphs = {
  image: convert(checkpoint, owlv2Image(config), pinned, beside),
  text: convert(checkpoint, owlv2Text(config, count), pinned, beside),
};

/**
 * Each answer relative to its largest value, a detection's box in the frame's pixels, and the
 * scores absolute — each about three times the worst an RX 9070 XT measured: **2.8e-4, 4.7e-3 px
 * and 1.2e-5 in single precision**, where the CPU's own reference measures 1.0e-4, 1.1e-3 px and
 * 4.1e-6 — so most of that is twelve layers of arithmetic rather than the device; and **9.8e-2,
 * 0.62 px and 3.1e-3 with the weights in half**, where every one of the 56 detections still
 * answers the same query. A tokenizer's ids are held exactly and have no tolerance.
 */
const TOLERANCE = {
  single: { value: 1e-3, box: 2e-2, score: 5e-5 },
  half: { value: 3e-1, box: 2, score: 1e-2 },
} as const;
type Limits = (typeof TOLERANCE)[keyof typeof TOLERANCE];
const failures: string[] = [];
const check = (label: string, value: number, limit: number): string => {
  if (!(value <= limit)) failures.push(`${label}: ${value.toExponential(2)} beyond ${limit}`);
  return value.toExponential(1);
};
const relative = (actual: Float32Array, expected: Float32Array): number => {
  let worst = 0;
  let scale = 0;
  for (let i = 0; i < expected.length; i += 1) {
    worst = Math.max(worst, Math.abs((actual[i] as number) - (expected[i] as number)));
    scale = Math.max(scale, Math.abs(expected[i] as number));
  }
  return worst / scale;
};

/* The tokenizer, on the real merges: every string's ids are the upstream's or the run fails. */
const tokenizer = clipTokenizer(merges);
for (const [text, ids] of Object.entries(asked.strings)) {
  const ours = tokenizer.encode(text);
  if (ours.length !== ids.length || ours.some((id, i) => id !== ids[i])) {
    failures.push(`tokenizer ${JSON.stringify(text)}: [${ours}] against [${ids}]`);
  }
}
const { tokens, ends } = owlv2Tokens(tokenizer, asked.queries, config.text.positions);
const upstreamTokens = answer('tokens');
for (let i = 0; i < upstreamTokens.length; i += 1) {
  if (tokens[i] !== upstreamTokens[i]) {
    failures.push(`query token ${i}: ${tokens[i]} against ${upstreamTokens[i]}`);
  }
}
console.log(
  `${Object.keys(asked.strings).length} strings and ${count} queries tokenized` +
    `${failures.length === 0 ? ' as the upstream does' : ''}`,
);

type Run = (
  graph: NetworkGraph,
  inputs: ReadonlyMap<string, Float32Array>,
) => Promise<Float32Array[]>;

async function compare(label: string, run: Run, limits: Limits): Promise<void> {
  const started = performance.now();
  const [classes, shift, scale, boxes, objectness] = (await run(
    graphs.image,
    new Map([['image', answer('image')]]),
  )) as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
  const [queries] = (await run(
    graphs.text,
    new Map([
      ['tokens', tokens],
      ['ends', ends],
    ]),
  )) as [Float32Array];
  const logits = new Float32Array(shift.length * count);
  owlv2Logits({ classes, shift, scale }, queries, count, logits);

  const lines = [];
  for (const [name, values] of [
    ['classes', classes],
    ['boxes', boxes],
    ['objectness', objectness],
    ['queries', queries],
    ['logits', logits],
  ] as const) {
    const off = relative(values, answer(name));
    lines.push(`${name} ${check(`${label} ${name}`, off, limits.value)}`);
  }
  const found = owlv2Detections(logits, boxes, count, 0.1, height, width);
  const scores = answer('detections.scores');
  const labels = answer('detections.labels');
  const upstreamBoxes = answer('detections.boxes');
  let score = 0;
  let box = 0;
  let wrong = found.length === scores.length ? 0 : 1;
  found.forEach((detection, i) => {
    if (detection.label !== labels[i]) wrong += 1;
    score = Math.max(score, Math.abs(detection.score - (scores[i] as number)));
    detection.box.forEach((value, j) => {
      box = Math.max(box, Math.abs(value - (upstreamBoxes[i * 4 + j] as number)));
    });
  });
  if (wrong > 0)
    failures.push(
      `${label}: ${found.length} detections against ${scores.length}, ${wrong} differing`,
    );
  console.log(
    `${label} (${((performance.now() - started) / 1000).toFixed(1)} s)\n  ${lines.join('; ')}\n` +
      `  ${found.length} detections, scores ${check(`${label} scores`, score, limits.score)}, ` +
      `boxes ${check(`${label} boxes`, box, limits.box)} px`,
  );
}

console.log(
  `a ${width}×${height} frame at ${config.size}², ${count} queries, against the upstream in single precision`,
);
if (only !== 'device') {
  await compare(
    'cpu',
    async (graph, inputs) => {
      const out = createGraphEvaluator(graph).run(inputs);
      return graph.outputs.map((name) => Float32Array.from(out.get(name) as Float32Array));
    },
    TOLERANCE.single,
  );
}
if (only !== 'cpu') {
  const instance = gpu.create([]) as unknown as GPU;
  for (const half of [false, true]) {
    const inference = await openInferenceDevice(instance, { half });
    const runners = new Map<NetworkGraph, GraphRunner>();
    await compare(
      `device, ${half ? 'half' : 'single'}`,
      async (graph, inputs) => {
        let runner = runners.get(graph);
        if (runner === undefined) {
          runner = await createGraphRunner(inference, graphForDevice(graph));
          runners.set(graph, runner);
        }
        const out = await runner.run(inputs);
        return graph.outputs.map((name) => Float32Array.from(out.get(name) as Float32Array));
      },
      half ? TOLERANCE.half : TOLERANCE.single,
    );
    for (const runner of runners.values()) runner.dispose();
  }
}
if (failures.length > 0) console.log(`\noutside the tolerance:\n  ${failures.join('\n  ')}`);
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(failures.length === 0 ? 0 : 1);

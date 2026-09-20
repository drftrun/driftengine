/**
 * SAM 2.1 tiny in the engine, tracking two objects through two real frames, held to its upstream on
 * the CPU and on the device at both precisions.
 *
 * **The engine half of the real model's parity.** `sam21_parity.py` wrote the upstream's prepared
 * frames and its answers; this converts the same fetched checkpoint — verified by its hash — into
 * the four graphs, runs `Sam21Tracker` over those very frames with the same prompts, so preparation
 * is not what is compared, and reports how far each frame's masks sit from the upstream's, relative
 * to their largest value; how many pixels of the masks brought to the original frame land on the
 * other side of zero; and the object scores. First through the reference evaluator, then through
 * `createGraphRunner` on Dawn.
 *
 * **It fails beyond a stated tolerance**, in `TOLERANCE`, each above what an RX 9070 XT measured —
 * the plan's Task 6 record has every figure.
 *
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam21_parity.py
 *     npx tsx --conditions=drift-source tools/capture-weights/reference/sam21_parity.ts [--cpu] [--device]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import gpu from '@kmamal/gpu';

import {
  SAM_21_TINY,
  Sam21Tracker,
  sam21Decoder,
  sam21Encoder,
  sam21MasksToImage,
  sam21MemoryAttention,
  sam21MemoryEncoder,
  type GraphRun,
  type SamPrompt,
} from '../../../packages/capture/src/index.ts';
import { openInferenceDevice } from '../../../packages/core/src/render/inference/device.ts';
import {
  createGraphRunner,
  type GraphRunner,
} from '../../../packages/core/src/render/inference/runner.ts';
import {
  createGraphEvaluator,
  graphForDevice,
  graphFromWeights,
  type GraphTensor,
  type NetworkGraph,
  type WeightSource,
} from '../../../packages/texture/src/index.ts';
import { tensorFloats } from '../checkpoint.ts';
import { convert } from '../convert.ts';
import { readSafetensors } from '../safetensors.ts';

const ROOT = new URL('../../..', import.meta.url).pathname;
const only = process.argv.includes('--cpu')
  ? 'cpu'
  : process.argv.includes('--device')
    ? 'device'
    : 'all';
const folder = path.join(ROOT, '.reference', 'sam21-parity');
const answers = readSafetensors(
  new Uint8Array(readFileSync(path.join(folder, 'output.safetensors'))),
);
const answer = (name: string): Float32Array => tensorFloats(name, answers.get(name) as never);
const prompts = JSON.parse(readFileSync(path.join(folder, 'prompts.json'), 'utf8')) as Record<
  string,
  SamPrompt
>;
const [height, width] = Array.from(answer('original')) as [number, number];
const frames = [answer('frame0'), answer('frame1')];
const config = SAM_21_TINY;

const { models } = JSON.parse(
  readFileSync(path.join(ROOT, 'tools', 'capture-weights', 'manifest.json'), 'utf8'),
) as {
  models: { name: string; sha256: string; file: string }[];
};
const model = models.find((entry) => entry.name === 'sam-2.1-tiny');
if (model === undefined) throw new Error('the manifest has no sam-2.1-tiny');
const checkpoint = new Uint8Array(
  readFileSync(path.join(ROOT, 'models', 'capture', model.name, path.basename(model.file))),
);
const pinned = { sha256: model.sha256, format: 'safetensors' } as const;
const source = (tensors: ReadonlyMap<string, GraphTensor>): WeightSource => ({
  get: (name) => tensors.get(name),
  names: () => tensors.keys(),
});
/* Converted once each, as the file holds them; every other graph is rebuilt from these. */
const weights = {
  encoder: source(convert(checkpoint, sam21Encoder(config), pinned).tensors),
  decoder: source(convert(checkpoint, sam21Decoder(config, 2), pinned).tensors),
  memoryEncoder: source(convert(checkpoint, sam21MemoryEncoder(config, false), pinned).tensors),
  memoryAttention: source(convert(checkpoint, sam21MemoryAttention(config, 1, 4), pinned).tensors),
};
const toImage = graphFromWeights(source(new Map()), sam21MasksToImage(config, 2, height, width));

/**
 * Masks relative to their largest value, the share of the frame's pixels that flip, and scores
 * absolute — each about three times the worst an RX 9070 XT measured: 7.7e-5, none and 2.2e-5 in
 * single precision, where a tracked frame carries the first frame's rounding through its memory and
 * the CPU's own reference evaluator measures 3.3e-5; 1.6e-2, 9.0e-5 and 6.7e-3 with the weights in
 * half.
 */
const TOLERANCE = {
  single: { value: 2.5e-4, flipped: 5e-5, score: 1e-4 },
  half: { value: 5e-2, flipped: 3e-4, score: 2e-2 },
} as const;
type Limits = (typeof TOLERANCE)[keyof typeof TOLERANCE];
const failures: string[] = [];
const check = (label: string, value: number, limit: number): string => {
  if (!(value <= limit)) failures.push(`${label}: ${value.toExponential(2)} beyond ${limit}`);
  return value.toExponential(1);
};

async function compare(label: string, run: GraphRun, limits: Limits): Promise<void> {
  const started = performance.now();
  const tracker = new Sam21Tracker(config, weights, run, {
    frames: 2,
    height,
    width,
    frame: (i) => frames[i] as Float32Array,
  });
  tracker.prompt(0, new Map(Object.entries(prompts).map(([id, prompt]) => [Number(id), prompt])));
  const lines = [];
  for (let frame = 0; frame < 2; frame += 1) {
    const out = await tracker.step(frame);
    const expected = answer(`frame${frame}.masks`);
    let worst = 0;
    let scale = 0;
    for (let i = 0; i < expected.length; i += 1) {
      worst = Math.max(worst, Math.abs((out.masks[i] as number) - (expected[i] as number)));
      scale = Math.max(scale, Math.abs(expected[i] as number));
    }
    const image = (await run(toImage, new Map([['masks', out.masks]]))).get(
      'image',
    ) as Float32Array;
    const upstream = answer(`frame${frame}.image`);
    let flipped = 0;
    for (let i = 0; i < upstream.length; i += 1)
      if ((image[i] as number) > 0 !== (upstream[i] as number) > 0) flipped += 1;
    const scores = answer(`frame${frame}.scores`);
    let score = 0;
    for (let i = 0; i < scores.length; i += 1)
      score = Math.max(score, Math.abs((out.scores[i] as number) - (scores[i] as number)));
    lines.push(
      `  frame ${frame}: masks ${check(`${label} frame ${frame} masks`, worst / scale, limits.value)}; ` +
        `pixels flipped ${check(`${label} frame ${frame} flipped`, flipped / upstream.length, limits.flipped)}; ` +
        `scores ${check(`${label} frame ${frame} scores`, score, limits.score)}`,
    );
  }
  console.log(
    `${label} (${((performance.now() - started) / 1000).toFixed(1)} s)\n${lines.join('\n')}`,
  );
}

console.log(`two ${height}×${width} frames, two objects, against the upstream in single precision`);
if (only !== 'device') {
  await compare(
    'cpu',
    async (graph, inputs) => createGraphEvaluator(graph).run(inputs),
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
        return runner.run(inputs);
      },
      half ? TOLERANCE.half : TOLERANCE.single,
    );
    for (const runner of runners.values()) runner.dispose();
  }
}
if (failures.length > 0) console.log(`\noutside the tolerance:\n  ${failures.join('\n  ')}`);
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(failures.length === 0 ? 0 : 1);

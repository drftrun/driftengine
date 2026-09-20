/**
 * MobileSAM in the engine, held to its upstream on a real frame with three prompts: on the CPU, and
 * on the device at both precisions.
 *
 * **The engine half of the real model's parity.** `sam_parity.py` wrote the upstream's prepared
 * image and its answers; this converts the same fetched checkpoint — verified by its hash — into the
 * encoder and the decoder, runs them on that very image, so preparation is not what is compared,
 * and reports how far each answer sits from the upstream's: the embedding, each prompt's tokens, the
 * four masks' logits and predicted quality, the masks brought to the original frame, how many of
 * their pixels land on the other side of zero, and the stability scores. Then the point's best mask
 * refined. First through the reference evaluator, then through `createGraphRunner` on Dawn.
 *
 * **It fails beyond a stated tolerance, not only reports**; the tolerances are in `TOLERANCE`, each
 * above what an RX 9070 XT measured — the plan's Task 6 record has every figure.
 *
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam_parity.py
 *     npx tsx --conditions=drift-source tools/capture-weights/reference/sam_parity.ts [--cpu] [--device]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import gpu from '@kmamal/gpu';

import {
  MOBILE_SAM,
  mobileSamDecoder,
  mobileSamEncoder,
  samMasksToImage,
  samPromptTokens,
  samTokenCount,
  stabilityScore,
  type SamPrompt,
} from '../../../packages/capture/src/index.ts';
import { openInferenceDevice } from '../../../packages/core/src/render/inference/device.ts';
import { createGraphRunner } from '../../../packages/core/src/render/inference/runner.ts';
import {
  createGraphEvaluator,
  graphForDevice,
  graphFromWeights,
  type Architecture,
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

const folder = path.join(ROOT, '.reference', 'sam-parity');
const answers = readSafetensors(
  new Uint8Array(readFileSync(path.join(folder, 'output.safetensors'))),
);
const answer = (name: string): Float32Array => tensorFloats(name, answers.get(name) as never);
const prompts = JSON.parse(readFileSync(path.join(folder, 'prompts.json'), 'utf8')) as Record<
  string,
  SamPrompt
>;
const [height, width] = Array.from(answer('original')) as [number, number];
const image = answer('image');
const config = MOBILE_SAM;
const { dim, masks: count } = config.decoder;
const pixels = height * width;

const { models } = JSON.parse(
  readFileSync(path.join(ROOT, 'tools', 'capture-weights', 'manifest.json'), 'utf8'),
) as { models: { name: string; sha256: string; file: string }[] };
const model = models.find((entry) => entry.name === 'mobilesam');
if (model === undefined) throw new Error('the manifest has no mobilesam');
const checkpoint = new Uint8Array(
  readFileSync(path.join(ROOT, 'models', 'capture', model.name, path.basename(model.file))),
);
const pinned = { sha256: model.sha256, format: 'pytorch' } as const;
/* Converted once each; every decoder is rebuilt from the decoder's weights, as the runtime does. */
const encoder = convert(checkpoint, mobileSamEncoder(config), pinned);
const decoderWeights = convert(checkpoint, mobileSamDecoder(config, 2), pinned).tensors;
const source = (tensors: ReadonlyMap<string, GraphTensor>): WeightSource => ({
  get: (name) => tensors.get(name),
  names: () => tensors.keys(),
});
const decoderFor = (tokens: number, refine: boolean): NetworkGraph =>
  graphFromWeights(source(decoderWeights), mobileSamDecoder(config, tokens, refine));
const postprocess = graphFromWeights(
  source(new Map()),
  samMasksToImage(config, count, height, width) as Architecture,
);

/**
 * Values relative to the largest the upstream answered — logits reach 66 and the embedding 0.62, so
 * an absolute figure says nothing across them — then the share of a mask's pixels that land on the
 * other side of zero, and the stability score's absolute difference. Each is about three times the
 * worst an RX 9070 XT measured: 1.7e-5, 3.7e-6 and 2.3e-5 in single precision, 3.2e-3, 9.3e-4 and
 * 6.4e-4 with the weights in half.
 */
const TOLERANCE = {
  single: { value: 5e-5, flipped: 2e-5, stability: 1e-4 },
  half: { value: 1e-2, flipped: 3e-3, stability: 2e-3 },
} as const;
type Limits = (typeof TOLERANCE)[keyof typeof TOLERANCE];
const failures: string[] = [];

/** The largest difference, over the largest value the upstream answered. */
const worst = (actual: Float32Array, expected: Float32Array): number => {
  let most = 0;
  let scale = 0;
  for (let i = 0; i < expected.length; i += 1) {
    most = Math.max(most, Math.abs((actual[i] as number) - (expected[i] as number)));
    scale = Math.max(scale, Math.abs(expected[i] as number));
  }
  return most / scale;
};
const check = (label: string, value: number, limit: number): string => {
  if (!(value <= limit)) failures.push(`${label}: ${value.toExponential(2)} beyond ${limit}`);
  return value.toExponential(1);
};

interface Run {
  (
    graph: NetworkGraph,
    inputs: ReadonlyMap<string, Float32Array>,
  ): Promise<ReadonlyMap<string, Float32Array>>;
}

/** Every answer of one way of running, against the upstream's, held to `limits`. */
async function compare(label: string, run: Run, limits: Limits): Promise<void> {
  const started = performance.now();
  const embedding = Float32Array.from(
    (await run(encoder, new Map([['image', image]]))).get('embedding') as Float32Array,
  );
  const encoded = ((performance.now() - started) / 1000).toFixed(1);
  const lines = [
    `${label}: embedding ${check(`${label} embedding`, worst(embedding, answer('embedding')), limits.value)} (${encoded} s)`,
  ];
  let pointMasks = new Float32Array();
  for (const [name, prompt] of Object.entries(prompts)) {
    const tokens = new Float32Array(samTokenCount(prompt) * dim);
    samPromptTokens(source(decoderWeights), dim, config.size, prompt, height, width, tokens);
    const out = await run(
      decoderFor(tokens.length / dim, false),
      new Map([
        ['embedding', embedding],
        ['prompt', tokens],
      ]),
    );
    const masks = Float32Array.from(out.get('masks') as Float32Array);
    if (name === 'point') pointMasks = masks;
    const upscaled = (await run(postprocess, new Map([['masks', masks]]))).get(
      'image',
    ) as Float32Array;
    const expected = answer(`${name}.image`);
    const stabilities = answer(`${name}.stability`);
    let flipped = 0;
    let stability = 0;
    for (let m = 0; m < count; m += 1) {
      let changed = 0;
      for (let i = m * pixels; i < (m + 1) * pixels; i += 1) {
        if ((upscaled[i] as number) > 0 !== (expected[i] as number) > 0) changed += 1;
      }
      flipped = Math.max(flipped, changed / pixels);
      const score = stabilityScore(upscaled.subarray(m * pixels, (m + 1) * pixels), 0, 1);
      stability = Math.max(stability, Math.abs(score - (stabilities[m] as number)));
    }
    lines.push(
      `  ${name.padEnd(5)} tokens ${worst(tokens, answer(`${name}.tokens`)).toExponential(1)}; ` +
        `logits ${check(`${label} ${name} logits`, worst(masks, answer(`${name}.masks`)), limits.value)}; ` +
        `quality ${check(`${label} ${name} quality`, worst(out.get('quality') as Float32Array, answer(`${name}.quality`)), limits.value)}; ` +
        `pixels flipped ${check(`${label} ${name} flipped`, flipped, limits.flipped)}; ` +
        `stability ${check(`${label} ${name} stability`, stability, limits.stability)}`,
    );
  }
  const from = answer('refined.from')[0] as number;
  const tokens = new Float32Array(samTokenCount(prompts['point'] as SamPrompt) * dim);
  samPromptTokens(
    source(decoderWeights),
    dim,
    config.size,
    prompts['point'] as SamPrompt,
    height,
    width,
    tokens,
  );
  const refined = await run(
    decoderFor(tokens.length / dim, true),
    new Map([
      ['embedding', embedding],
      ['prompt', tokens],
      ['mask', pointMasks.slice(from * 256 * 256, (from + 1) * 256 * 256)],
    ]),
  );
  lines.push(
    `  refined logits ${check(`${label} refined logits`, worst(refined.get('masks') as Float32Array, answer('refined.masks')), limits.value)}; ` +
      `quality ${check(`${label} refined quality`, worst(refined.get('quality') as Float32Array, answer('refined.quality')), limits.value)}`,
  );
  console.log(lines.join('\n'));
}

console.log(
  `a ${height}×${width} frame, prepared in a ${config.size} square, against the upstream in single precision`,
);
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
    await compare(
      `device, ${half ? 'half' : 'single'}`,
      async (graph, inputs) => {
        const runner = await createGraphRunner(inference, graphForDevice(graph));
        const out = await runner.run(inputs);
        runner.dispose();
        return out;
      },
      half ? TOLERANCE.half : TOLERANCE.single,
    );
  }
}
if (failures.length > 0) console.log(`\noutside the tolerance:\n  ${failures.join('\n  ')}`);
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(failures.length === 0 ? 0 : 1);

/**
 * Depth Anything 3 Small in the engine, held to its upstream on two real frames: on the CPU, and on
 * the device at both precisions.
 *
 * **The engine half of the real model's parity.** `da3_parity.py` wrote the upstream's prepared
 * images and its answers; this builds the engine's graph from the same fetched checkpoint — verified
 * by its hash — runs it on those very images, so preparation is not what is compared, and reports
 * how far each answer sits from the upstream's: depth and confidence per pixel, the raw camera
 * encoding, and the cameras decoded from it. First on the CPU through the reference evaluator, then
 * through `createGraphRunner` on Dawn, the native host's binding, storing weights in single and in
 * half precision.
 *
 * **It fails beyond a stated tolerance, not only reports.** Per pixel, relative, depth and confidence
 * within 1e-4 with weights stored single and 2e-2 with them stored half; the camera's encoding and
 * the cameras decoded from it within 1e-5 and 1e-3. Each is above what was measured on an RX 9070 XT
 * — 5.6e-5 and 1.0e-2 at worst, the plan's Task 5 record has every figure — with room for another
 * device, and far below what a reconstruction could see.
 *
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/da3_parity.py
 *     npx tsx --conditions=drift-source tools/capture-weights/reference/parity.ts [--cpu] [--device]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import gpu from '@kmamal/gpu';

import {
  DEPTH_ANYTHING_3,
  decodeCamera,
  decodeDepth,
  depthAnything3,
} from '../../../packages/capture/src/index.ts';
import { openInferenceDevice } from '../../../packages/core/src/render/inference/device.ts';
import { createGraphRunner } from '../../../packages/core/src/render/inference/runner.ts';
import {
  createGraphEvaluator,
  graphForDevice,
  graphFromWeights,
  type NetworkGraph,
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

const answers = readSafetensors(
  new Uint8Array(readFileSync(path.join(ROOT, '.reference', 'da3-parity', 'output.safetensors'))),
);
const answer = (name: string): Float32Array => tensorFloats(name, answers.get(name) as never);
const imagesShape = answers.get('images')?.shape as readonly number[];
const [, , height, width] = imagesShape as [number, number, number, number];
const images = answer('images');
const plane = 3 * height * width;
const pixels = height * width;

const { models } = JSON.parse(
  readFileSync(path.join(ROOT, 'tools', 'capture-weights', 'manifest.json'), 'utf8'),
) as { models: { name: string; sha256: string; file: string }[] };
const model = models.find((entry) => entry.name === 'depth-anything-3-small');
if (model === undefined) throw new Error('the manifest has no depth-anything-3-small');
const checkpoint = new Uint8Array(
  readFileSync(path.join(ROOT, 'models', 'capture', model.name, path.basename(model.file))),
);
const pinned = { sha256: model.sha256, format: 'safetensors' } as const;
/* Converted once; each case's graph is rebuilt from its weights, as the runtime rebuilds one. */
const weights = convert(
  checkpoint,
  depthAnything3(DEPTH_ANYTHING_3.small, 1, height, width),
  pinned,
).tensors;
const graphFor = (views: number): NetworkGraph =>
  graphFromWeights(
    { get: (name) => weights.get(name), names: () => weights.keys() },
    depthAnything3(DEPTH_ANYTHING_3.small, views, height, width),
  );

const quantile = (values: Float64Array, q: number): number => {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};

/** Relative per pixel for depth and confidence, absolute for the camera; single, then half. */
const TOLERANCE = {
  single: { pixel: 1e-4, camera: 1e-5 },
  half: { pixel: 2e-2, camera: 1e-3 },
} as const;
const failures: string[] = [];

/** How one run's answers sit against the upstream's, as one line, held to `limits`. */
function report(
  label: string,
  views: number,
  outputs: ReadonlyMap<string, Float32Array>,
  limits: { readonly pixel: number; readonly camera: number },
): void {
  const upstreamDepth = answer(`${views === 1 ? 'single' : 'pair'}.depth`);
  const upstreamConfidence = answer(`${views === 1 ? 'single' : 'pair'}.confidence`);
  const relative = new Float64Array(views * pixels);
  let confidence = 0;
  const depth = new Float32Array(pixels);
  const conf = new Float32Array(pixels);
  for (let v = 0; v < views; v += 1) {
    decodeDepth(outputs.get(`logits${v}`) as Float32Array, depth, conf);
    for (let i = 0; i < pixels; i += 1) {
      const reference = upstreamDepth[v * pixels + i] as number;
      relative[v * pixels + i] = Math.abs((depth[i] as number) - reference) / reference;
      const c = upstreamConfidence[v * pixels + i] as number;
      confidence = Math.max(confidence, Math.abs((conf[i] as number) - c) / c);
    }
  }
  const pose = outputs.get('pose') as Float32Array;
  const upstreamPose = answer(`${views === 1 ? 'single' : 'pair'}.pose`);
  let poseError = 0;
  for (let i = 0; i < pose.length; i += 1) {
    poseError = Math.max(poseError, Math.abs((pose[i] as number) - (upstreamPose[i] as number)));
  }
  /* The cameras, decoded here from the engine's encoding, against the upstream's own decoding. */
  const upstreamExtrinsics = answer(`${views === 1 ? 'single' : 'pair'}.extrinsics`);
  const upstreamIntrinsics = answer(`${views === 1 ? 'single' : 'pair'}.intrinsics`);
  const w2c = new Float32Array(12);
  const k = new Float32Array(9);
  let extrinsic = 0;
  let focal = 0;
  for (let v = 0; v < views; v += 1) {
    decodeCamera(pose, v, height, width, w2c, k);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        const up = upstreamExtrinsics[v * 12 + r * 4 + c] as number;
        extrinsic = Math.max(extrinsic, Math.abs((w2c[r * 4 + c] as number) - up));
      }
    }
    for (const at of [0, 4]) {
      const up = upstreamIntrinsics[v * 9 + at] as number;
      focal = Math.max(focal, Math.abs((k[at] as number) - up) / up);
    }
  }
  const worst = quantile(relative, 1);
  if (!(worst <= limits.pixel && confidence <= limits.pixel)) {
    failures.push(`${label}: a pixel beyond ${limits.pixel}`);
  }
  if (!(poseError <= limits.camera && extrinsic <= limits.camera && focal <= limits.camera)) {
    failures.push(`${label}: the camera beyond ${limits.camera}`);
  }
  console.log(
    `${label.padEnd(26)} depth relative: median ${quantile(relative, 0.5).toExponential(1)}, ` +
      `99% ${quantile(relative, 0.99).toExponential(1)}, worst ${quantile(relative, 1).toExponential(1)}; ` +
      `confidence worst ${confidence.toExponential(1)}; pose encoding ${poseError.toExponential(1)}; ` +
      `world-to-camera ${extrinsic.toExponential(1)}; focal ${focal.toExponential(1)}`,
  );
}

const cases = [1, 2].map((views) => ({
  views,
  graph: graphFor(views),
  inputs: new Map(
    Array.from({ length: views }, (_, v) => [
      `image${v}`,
      images.subarray(v * plane, (v + 1) * plane),
    ]),
  ),
}));
console.log(`two frames at ${height}×${width}, against the upstream in single precision`);

if (only !== 'device') {
  for (const { views, graph, inputs } of cases) {
    const started = performance.now();
    const outputs = createGraphEvaluator(graph).run(inputs);
    const copied = new Map([...outputs].map(([name, values]) => [name, Float32Array.from(values)]));
    report(
      `cpu, ${views} view${views === 1 ? '' : 's'} (${((performance.now() - started) / 1000).toFixed(0)} s)`,
      views,
      copied,
      TOLERANCE.single,
    );
  }
}

if (only !== 'cpu') {
  const instance = gpu.create([]) as unknown as GPU;
  for (const half of [false, true]) {
    const inference = await openInferenceDevice(instance, { half });
    for (const { views, graph, inputs } of cases) {
      const runner = await createGraphRunner(inference, graphForDevice(graph));
      const outputs = await runner.run(inputs);
      runner.dispose();
      report(
        `device, ${half ? 'half' : 'single'}, ${views} view${views === 1 ? '' : 's'}`,
        views,
        outputs,
        half ? TOLERANCE.half : TOLERANCE.single,
      );
    }
  }
}
if (failures.length > 0) console.log(`\noutside the tolerance:\n  ${failures.join('\n  ')}`);
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(failures.length === 0 ? 0 : 1);

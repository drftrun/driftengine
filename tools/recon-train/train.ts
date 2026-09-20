/**
 * Train candidate refinement networks on captured pairs, measure each on scenes it never saw, and
 * export the one asked for.
 *
 * **Held out by scene, not by frame.** Two frames of one scene a second apart share nearly every
 * pixel, so a network scored on frames of a scene it trained on is scored on its training set. The
 * held-out scenes answer the question Task 9 asks of a player's own game: does it help on a picture
 * it has never been shown.
 *
 * **Scored against doing nothing.** Every line reports the reconstruction's own error against the
 * native frame beside the network's, in PSNR over display values. A network that does not beat the
 * frame it was given is the stop condition the plan names, and the number says so before any blind
 * comparison is spent on it.
 *
 *     npx tsx --conditions=drift-source tools/recon-train/train.ts \
 *       [--shapes=luma:11-8-3,luma:11-16-16-3] [--holdout=night-court,storm-sea] \
 *       [--steps=20000] [--batch=128] [--export=luma:11-16-3]
 *
 * Reads `tools/recon-train/.data/pairs`, written by `pairs.mjs`, and writes the exported chunk to
 * `tools/recon-train/.data/weights/`. Neither is in git.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng, readPng, rgbaOf, type RgbaImage } from '../../packages/core/scripts/png.mjs';
import { buildNnet } from '../../packages/drft/src/nnet.ts';
import { halfWeights } from '../../packages/texture/src/half.ts';
import { evalNetworkHalf } from '../../packages/texture/src/inference.ts';

import { FEATURE_COUNT, features, residual, type FeatureSet } from './features.ts';
import { Mlp } from './mlp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The role reconstruction's learned tier finds its network by. */
export const REFINEMENT_ROLE = 'RCN1';

function argOf(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

interface Pair {
  readonly scene: string;
  readonly frame: number;
  readonly reconstructed: RgbaImage;
  readonly native: RgbaImage;
}

interface Candidate {
  readonly label: string;
  readonly set: FeatureSet;
  readonly hidden: readonly number[];
}

function parseCandidate(label: string): Candidate {
  const [set, shape] = label.split(':') as [FeatureSet, string];
  const widths = shape.split('-').map(Number);
  if (!(set in FEATURE_COUNT) || widths[0] !== FEATURE_COUNT[set] || widths.at(-1) !== 3) {
    throw new Error(`${label}: a candidate is <luma|rgb>:<inputs>-<hidden...>-3`);
  }
  return { label, set, hidden: widths.slice(1, -1) };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function psnr(mse: number): string {
  return (10 * Math.log10(1 / mse)).toFixed(2);
}

const dir = argOf('pairs', join(HERE, '.data', 'pairs'));
const holdout = new Set(argOf('holdout', 'night-court,storm-sea').split(','));
const steps = Number(argOf('steps', '20000'));
const batch = Number(argOf('batch', '128'));
const stride = Number(argOf('stride', '2'));
const candidates = argOf(
  'shapes',
  'luma:11-8-3,luma:11-16-3,luma:11-8-8-3,luma:11-16-16-3,rgb:27-16-3,rgb:27-16-16-3',
)
  .split(',')
  .map(parseCandidate);
const exported = argOf('export', '');
/** A held-out pair to write refined by the exported network, for a comparison by eye. */
const applied = argOf('apply', '');

const pairs: Pair[] = [];
for (const name of readdirSync(dir).sort()) {
  const match = /^(.+)-(\d+)-recon\.png$/.exec(name);
  if (match === null) continue;
  const [, scene, frame] = match as unknown as [string, string, string];
  pairs.push({
    scene,
    frame: Number(frame),
    reconstructed: rgbaOf(readPng(join(dir, name))),
    native: rgbaOf(readPng(join(dir, `${scene}-${frame}-native.png`))),
  });
}
const training = pairs.filter((pair) => !holdout.has(pair.scene));
const held = pairs.filter((pair) => holdout.has(pair.scene));
if (training.length === 0 || held.length === 0) {
  throw new Error(`${pairs.length} pairs in ${dir}, and the split left one side empty`);
}
console.log(
  `${training.length} training pairs, ${held.length} held out (${[...holdout].join(', ')}), ` +
    `${steps} steps of ${batch}`,
);

const input = new Float64Array(27);
const target = new Float64Array(3);
const out = new Float32Array(3);

/** Mean squared error over display values, of the frame as given and as refined, per pixel channel. */
function score(
  set: FeatureSet,
  of: readonly Pair[],
  predict: (input: Float64Array, out: Float32Array) => void,
): { given: number; refined: number } {
  let given = 0;
  let refined = 0;
  let count = 0;
  for (const pair of of) {
    const { width, height } = pair.reconstructed;
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        features(pair.reconstructed, x, y, set, input);
        residual(pair.reconstructed, pair.native, x, y, target);
        predict(input, out);
        for (let c = 0; c < 3; c += 1) {
          const base = input[c] as number;
          const truth = base + (target[c] as number);
          const value = Math.min(1, Math.max(0, base + (out[c] as number)));
          given += (truth - base) ** 2;
          refined += (truth - value) ** 2;
        }
        count += 3;
      }
    }
  }
  return { given: given / count, refined: refined / count };
}

for (const candidate of candidates) {
  const inputs = FEATURE_COUNT[candidate.set];
  const shape = { inputs, hidden: candidate.hidden, outputs: 3 };
  const random = seeded(1);
  const mlp = new Mlp(shape, random);
  const started = performance.now();
  for (let step = 0; step < steps; step += 1) {
    for (let b = 0; b < batch; b += 1) {
      const pair = training[Math.floor(random() * training.length)] as Pair;
      const x = Math.floor(random() * pair.reconstructed.width);
      const y = Math.floor(random() * pair.reconstructed.height);
      features(pair.reconstructed, x, y, candidate.set, input);
      residual(pair.reconstructed, pair.native, x, y, target);
      mlp.accumulate(input, target);
    }
    /* Cosine from 2e-3 to nothing: large steps while the error is large, none by the end. */
    mlp.step(1e-3 * (1 + Math.cos((Math.PI * step) / steps)));
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  const train = score(candidate.set, training, (i, o) => mlp.forward(i, o));
  const test = score(candidate.set, held, (i, o) => mlp.forward(i, o));
  console.log(
    `${candidate.label.padEnd(18)} trained in ${seconds.padStart(3)} s   ` +
      `training ${psnr(train.given)} → ${psnr(train.refined)} dB   ` +
      `held out ${psnr(test.given)} → ${psnr(test.refined)} dB`,
  );
  /* Each held-out scene on its own, because an average can hide one the network makes worse. */
  for (const scene of holdout) {
    const own = score(
      candidate.set,
      held.filter((pair) => pair.scene === scene),
      (i, o) => mlp.forward(i, o),
    );
    console.log(`  ${scene.padEnd(16)} ${psnr(own.given)} → ${psnr(own.refined)} dB`);
  }

  if (candidate.label === exported) {
    const bits = halfWeights(mlp.weights);
    const scratch = new Float64Array(64);
    const staged = new Float32Array(27);
    const half = score(candidate.set, held, (i, o) => {
      for (let k = 0; k < inputs; k += 1) staged[k] = i[k] as number;
      evalNetworkHalf(shape, bits, staged, o, scratch);
    });
    const chunk = buildNnet({
      networks: [{ role: REFINEMENT_ROLE, ...shape, weights: bits }],
    });
    const weights = join(HERE, '.data', 'weights');
    mkdirSync(weights, { recursive: true });
    const file = join(weights, `${candidate.label.replace(':', '-')}.nnet`);
    writeFileSync(file, chunk);
    console.log(
      `  exported at half precision, held out ${psnr(half.refined)} dB: ${chunk.byteLength} bytes to ${file}`,
    );
    const pair = held.find((one) => `${one.scene}-${one.frame}` === applied);
    if (pair !== undefined) {
      const { width, height } = pair.reconstructed;
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          features(pair.reconstructed, x, y, candidate.set, input);
          for (let k = 0; k < inputs; k += 1) staged[k] = input[k] as number;
          evalNetworkHalf(shape, bits, staged, out, scratch);
          const at = (y * width + x) * 4;
          for (let c = 0; c < 3; c += 1) {
            const value = (input[c] as number) + (out[c] as number);
            rgba[at + c] = Math.round(Math.min(1, Math.max(0, value)) * 255);
          }
          rgba[at + 3] = 255;
        }
      }
      writeFileSync(join(weights, `${applied}-refined.png`), encodePng(width, height, rgba));
      console.log(`  ${applied} refined by it, to ${join(weights, `${applied}-refined.png`)}`);
    }
  }
}

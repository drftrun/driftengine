/**
 * What each node of a converted model costs on the native host: every node timed alone, at the
 * shapes it has in the model, then summed by operator — the instrument that says which kernel a
 * model's time is made of before one is rewritten.
 *
 * **Each node runs as a graph of one**, its inputs random where the model computes them and its
 * weights the model's own, through `createGraphRunner`, timed by the device's timestamps after as
 * long again to warm it (`modelCost.ts`'s `sustained`). **What it gives up**: a node alone pays its
 * own dispatch and reads its inputs cold, so the sum is above the model's own time — the ranking is
 * the finding, not the total. A node whose output is a copy (`reshape`) is timed like any other.
 *
 *     npx tsx --conditions=drift-source tools/capture-weights/nodebudget.ts <file> <role> [--refine] [--tokens=2]
 *       [--frames=1] [--pointers=4] [--half] [--top=20]
 *
 * `<file>` names a converted model under `models/capture/`; `<role>` its graph. The decoder of a
 * promptable model is rebuilt for `--tokens` and `--refine` from the file's weights.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import gpu from '@kmamal/gpu';

import {
  MOBILE_SAM,
  mobileSamDecoder,
  mobileSamEncoder,
  SAM_21_TINY,
  sam21Decoder,
  sam21Encoder,
  sam21MemoryAttention,
  sam21MemoryEncoder,
  OWLV2_BASE,
  owlv2Image,
  owlv2Text,
} from '../../packages/capture/src/index.ts';
import { createGraphRunner } from '../../packages/core/src/render/inference/runner.ts';
import {
  graphForDevice,
  graphFromWeights,
  graphShapes,
  type Architecture,
  type GraphTensor,
  type NetworkGraph,
} from '../../packages/texture/src/index.ts';
import { openDevice, sustained, weightsOf } from './modelCost.ts';

const [name = '', role = ''] = process.argv.slice(2);
const option = (key: string, fallback: string): string =>
  process.argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const tokens = Number(option('tokens', '2'));
const top = Number(option('top', '20'));
const half = process.argv.includes('--half');

const ARCHITECTURES: Readonly<Record<string, () => Architecture>> = {
  'mobilesam/EMBD': () => mobileSamEncoder(MOBILE_SAM),
  'mobilesam/MASK': () => mobileSamDecoder(MOBILE_SAM, tokens, process.argv.includes('--refine')),
  'sam-2.1-tiny/EMBD': () => sam21Encoder(SAM_21_TINY),
  'sam-2.1-tiny/MASK': () => sam21Decoder(SAM_21_TINY, tokens),
  'sam-2.1-tiny/MEME': () => sam21MemoryEncoder(SAM_21_TINY, false),
  'sam-2.1-tiny/MEMA': () =>
    sam21MemoryAttention(
      SAM_21_TINY,
      Number(option('frames', '1')),
      Number(option('pointers', '4')),
    ),
  'owlv2-base-patch16/IMAG': () => owlv2Image(OWLV2_BASE),
  'owlv2-base-patch16/TEXT': () => owlv2Text(OWLV2_BASE, Number(option('queries', '4'))),
};
const build = ARCHITECTURES[`${name}/${role}`];
if (build === undefined) {
  throw new Error(
    `no graph "${role}" of "${name}"; there are ${Object.keys(ARCHITECTURES).join(', ')}`,
  );
}
const file = readFileSync(
  path.join(new URL('../..', import.meta.url).pathname, 'models', 'capture', `${name}.drft`),
);
const weights = weightsOf(
  file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
  role,
);
const model = graphFromWeights(
  { get: (key) => weights.get(key), names: () => weights.keys() },
  build(),
);
const shapes = graphShapes(model);

const { device, stamped } = await openDevice(gpu.create([]) as unknown as GPU);
const next = (
  (seed) => () =>
    ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
)(7);
const costs: { op: string; output: string; shape: string; ms: number }[] = [];
for (const node of model.nodes) {
  const tensors = new Map<string, GraphTensor>();
  const inputs: { name: string; shape: readonly number[] }[] = [];
  for (const input of node.inputs) {
    const held = model.tensors.get(input);
    if (held !== undefined) tensors.set(input, held);
    else if (!inputs.some((entry) => entry.name === input))
      inputs.push({ name: input, shape: shapes.get(input) as readonly number[] });
  }
  const single: NetworkGraph = { inputs, outputs: [node.output], nodes: [node], tensors };
  const runner = await createGraphRunner({ device, half }, graphForDevice(single));
  const values = new Map(
    inputs.map(({ name: input, shape }) => [
      input,
      Float32Array.from({ length: shape.reduce((a, b) => a * b, 1) }, next),
    ]),
  );
  await runner.run(values);
  const ms = await sustained(device, stamped, (encoder, writes) => runner.encode(encoder, writes));
  runner.dispose();
  costs.push({
    op: node.op,
    output: node.output,
    shape: `[${(shapes.get(node.output) ?? []).join(', ')}]`,
    ms,
  });
}
device.destroy();

const total = costs.reduce((sum, { ms }) => sum + ms, 0);
console.log(
  `${name} ${role}, ${model.nodes.length} nodes, ${half ? 'half' : 'single'}: ${total.toFixed(2)} ms summed alone (${stamped ? 'timestamps' : 'wall'})`,
);
const byOp = new Map<string, { ms: number; count: number }>();
for (const { op, ms } of costs) {
  const entry = byOp.get(op) ?? { ms: 0, count: 0 };
  byOp.set(op, { ms: entry.ms + ms, count: entry.count + 1 });
}
for (const [op, { ms, count }] of [...byOp].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(
    `  ${op.padEnd(16)} ${String(count).padStart(4)} nodes ${ms.toFixed(2).padStart(9)} ms  ${((100 * ms) / total).toFixed(1).padStart(5)}%`,
  );
}
console.log(`the ${top} dearest nodes:`);
for (const { op, output, shape, ms } of costs.sort((a, b) => b.ms - a.ms).slice(0, top)) {
  console.log(`  ${ms.toFixed(3).padStart(8)} ms  ${op.padEnd(16)} ${output.padEnd(8)} ${shape}`);
}
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(0);

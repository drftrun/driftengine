/**
 * Builds the file a game ships from a fetched checkpoint: the model's graphs and weights in a
 * `.drft`, and its licence and attribution beside it.
 *
 * **The graph is written at one size and rebuilt at any other.** The `.drft` carries the model's
 * graph at a canonical size — so a file validates on load, and runs as it is when that size is the
 * one wanted — and every weight under its checkpoint's name, which is all `@driftengine/capture`
 * needs to rebuild the graph for a clip's own size through `graphFromWeights`. Weights are stored at
 * half precision unless asked otherwise: half the bytes, and the precision the device stores them
 * at anyway.
 *
 * **The attribution travels with the weights**: `<name>.NOTICE.txt` holds the manifest's licence,
 * attribution, upstream and pinned revision, which is what shipping an Apache-2.0 model asks.
 *
 *     node tools/capture-weights/fetch.mjs <name>
 *     npx tsx --conditions=drift-source tools/capture-weights/build.ts <name> [--size=504x504] [--single]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEPTH_ANYTHING_2_SMALL,
  DEPTH_ANYTHING_3,
  depthAnything2,
  depthAnything3,
  MOBILE_SAM,
  mobileSamDecoder,
  mobileSamEncoder,
  OWLV2_BASE,
  owlv2Image,
  owlv2Text,
  SAM_21_TINY,
  sam21Decoder,
  sam21Encoder,
  sam21MemoryAttention,
  sam21MemoryEncoder,
} from '../../packages/capture/src/index.ts';
import { writeDrft } from '../../packages/drft/src/index.ts';
import type { Architecture, GraphTensor } from '../../packages/texture/src/index.ts';
import { clipMerges } from './clipMerges.ts';
import { convert, storedGraph } from './convert.ts';

interface Definition {
  /** The size the file's graphs are written at: the upstream's own default processing size. */
  readonly size: readonly [number, number];
  /**
   * Each graph the file holds, by the four characters naming what it is for, as `NGRF` records
   * it. Every one reads the whole checkpoint or sets the rest aside by name, so a model split in two
   * — an encoder run once an image and a decoder once a prompt — stores each weight once.
   */
  readonly graphs: readonly {
    readonly role: string;
    readonly architecture: (height: number, width: number) => Architecture;
  }[];
  /**
   * Tensors made from the files the manifest pins beside the checkpoint, each read by name once its
   * hash is checked — a tokenizer's merges — which the definitions read as they read weights.
   */
  readonly beside?: (read: (file: string) => string) => ReadonlyMap<string, GraphTensor>;
}

/** The models with a definition in `@driftengine/capture`; the manifest names the rest. */
const DEFINITIONS: Readonly<Record<string, Definition>> = {
  'depth-anything-3-small': {
    size: [504, 504],
    graphs: [
      {
        role: 'DPTH',
        architecture: (height, width) => depthAnything3(DEPTH_ANYTHING_3.small, 1, height, width),
      },
    ],
  },
  'depth-anything-3-base': {
    size: [504, 504],
    graphs: [
      {
        role: 'DPTH',
        architecture: (height, width) => depthAnything3(DEPTH_ANYTHING_3.base, 1, height, width),
      },
    ],
  },
  'depth-anything-2-small': {
    size: [518, 518],
    graphs: [
      {
        role: 'DPTH',
        architecture: (height, width) => depthAnything2(DEPTH_ANYTHING_2_SMALL, height, width),
      },
    ],
  },
  /*
   * The encoder; the decoder for a point and its padding, reading remembered features; the memory
   * encoder for a tracked frame's mask; and the memory attention over one frame and one pointer —
   * each rebuilt from these weights for whatever a tracker holds.
   */
  'sam-2.1-tiny': {
    size: [SAM_21_TINY.size, SAM_21_TINY.size],
    graphs: [
      { role: 'EMBD', architecture: () => sam21Encoder(SAM_21_TINY) },
      { role: 'MASK', architecture: () => sam21Decoder(SAM_21_TINY, 2) },
      { role: 'MEME', architecture: () => sam21MemoryEncoder(SAM_21_TINY, false) },
      {
        role: 'MEMA',
        architecture: () =>
          sam21MemoryAttention(SAM_21_TINY, 1, SAM_21_TINY.decoder.dim / SAM_21_TINY.memory.dim),
      },
    ],
  },
  /*
   * The image graph at its one size, and the text graph for one query, carrying CLIP's merges —
   * checked against the vocabulary the upstream ships beside them.
   */
  'owlv2-base-patch16': {
    size: [OWLV2_BASE.size, OWLV2_BASE.size],
    graphs: [
      { role: 'IMAG', architecture: () => owlv2Image(OWLV2_BASE) },
      { role: 'TEXT', architecture: () => owlv2Text(OWLV2_BASE, 1) },
    ],
    beside: (read) => {
      const merges = clipMerges(read('merges.txt'), JSON.parse(read('vocab.json')));
      return new Map([['tokenizer.merges', { shape: [merges.length / 2, 2], data: merges }]]);
    },
  },
  /* The encoder at its one size, and the decoder for a point and its padding, or a box. */
  mobilesam: {
    size: [MOBILE_SAM.size, MOBILE_SAM.size],
    graphs: [
      { role: 'EMBD', architecture: () => mobileSamEncoder(MOBILE_SAM) },
      { role: 'MASK', architecture: () => mobileSamDecoder(MOBILE_SAM, 2) },
    ],
  },
};

interface Model {
  readonly name: string;
  readonly title: string;
  readonly upstream: string;
  readonly revision: string;
  readonly file: string;
  readonly format: 'safetensors' | 'pytorch';
  readonly sha256: string;
  readonly extra?: readonly { readonly file: string; readonly sha256: string }[];
  readonly licence: string;
  readonly attribution: string;
}

const ROOT = new URL('../..', import.meta.url).pathname;
const { models } = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8')) as {
  models: readonly Model[];
};

const name = process.argv[2] ?? '';
const model = models.find((entry) => entry.name === name);
const definition = DEFINITIONS[name];
if (model === undefined || definition === undefined) {
  throw new Error(
    `no model "${name}" with a definition; built so far: ${Object.keys(DEFINITIONS).join(', ')}`,
  );
}
const sizeArgument = process.argv.find((arg) => arg.startsWith('--size='));
const [height, width] =
  sizeArgument === undefined
    ? definition.size
    : (sizeArgument.slice(7).split('x').map(Number) as [number, number]);
const precision = process.argv.includes('--single') ? 'single' : 'half';

const folder = path.join(ROOT, 'models', 'capture');
const checkpoint = new Uint8Array(
  readFileSync(path.join(folder, model.name, path.basename(model.file))),
);
const besideFile = (file: string): string => {
  const pinned = model.extra?.find((entry) => entry.file === file);
  if (pinned === undefined) throw new Error(`the manifest pins no "${file}" beside ${model.name}`);
  const bytes = readFileSync(path.join(folder, model.name, file));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== pinned.sha256) {
    throw new Error(`${file}'s SHA-256 is ${hash} and the manifest pins ${pinned.sha256}`);
  }
  return bytes.toString('utf8');
};
const beside = definition.beside?.(besideFile) ?? new Map<string, GraphTensor>();
const graphs = definition.graphs.map(({ role, architecture }) => ({
  role,
  graph: convert(checkpoint, architecture(height, width), model, beside),
}));
const bytes = writeDrft({
  meshes: [],
  graphs: graphs.map(({ role, graph }) => storedGraph(graph, role, precision)),
});
writeFileSync(path.join(folder, `${model.name}.drft`), new Uint8Array(bytes));
writeFileSync(
  path.join(folder, `${model.name}.NOTICE.txt`),
  `${model.title}\n${model.attribution}\nLicensed under ${model.licence}.\n` +
    `Converted from ${model.upstream} at revision ${model.revision} (SHA-256 ${model.sha256}).\n`,
);
for (const { role, graph } of graphs) {
  const weights = [...graph.tensors.keys()].filter((key) => !key.startsWith('@')).length;
  console.log(`${role}: ${graph.nodes.length} nodes and ${weights} weights`);
}
console.log(
  `${model.name} at ${height}×${width}, ${precision} precision, ` +
    `${(bytes.byteLength / 1048576).toFixed(1)} MB → models/capture/${model.name}.drft`,
);

/**
 * Writes the seeded miniatures of Depth Anything 3 and V2, MobileSAM, SAM 2.1 and OWLv2, and their
 * inputs, for the upstreams' code.
 *
 * **Half of the oracle the model's tests are held to.** This writes the checkpoint and images the
 * tests build in memory — the same functions, the same seed — as safetensors under
 * `.reference/da3-miniature/`; `da3_miniature.py` loads them into the upstream's own modules and
 * writes what those modules answer. The numbers a test asserts are copied from that answer, so they
 * come from an implementation that is not the one under test.
 *
 *     npx tsx --conditions=drift-source tools/capture-weights/reference/miniature.ts
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/da3_miniature.py
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/da2_miniature.py
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam_miniature.py
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam21_miniature.py
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/owlv2_miniature.py
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  MINIATURE_CASES,
  MINIATURE_DEPTH_ANYTHING_2,
  MINIATURE_DEPTH_ANYTHING_3,
  MINIATURE_SEED,
  miniatureCheckpoint,
  miniatureCheckpoint2,
  miniatureImages,
} from '../../../packages/capture/src/models/miniature.ts';
import {
  MINIATURE_MOBILE_SAM,
  MINIATURE_SAM_IMAGE,
  MINIATURE_SAM_PROMPTS,
  miniatureSamCheckpoint,
} from '../../../packages/capture/src/models/samMiniature.ts';
import {
  MINIATURE_SAM_21,
  MINIATURE_SAM_21_IMAGE,
  MINIATURE_SAM_21_PROMPTS,
  miniatureSam21Checkpoint,
} from '../../../packages/capture/src/models/sam21Miniature.ts';
import {
  MINIATURE_OWLV2,
  MINIATURE_OWLV2_IMAGE,
  MINIATURE_OWLV2_QUERIES,
  miniatureOwlv2Checkpoint,
} from '../../../packages/capture/src/models/owlv2Miniature.ts';

/** A safetensors file of single-precision tensors. */
function safetensors(
  tensors: ReadonlyMap<string, { shape: readonly number[]; data: Float32Array }>,
): Uint8Array {
  const header: Record<string, unknown> = {};
  let offset = 0;
  for (const [name, tensor] of tensors) {
    header[name] = {
      dtype: 'F32',
      shape: tensor.shape,
      data_offsets: [offset, offset + tensor.data.byteLength],
    };
    offset += tensor.data.byteLength;
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const file = new Uint8Array(8 + json.length + offset);
  new DataView(file.buffer).setBigUint64(0, BigInt(json.length), true);
  file.set(json, 8);
  let at = 8 + json.length;
  for (const tensor of tensors.values()) {
    file.set(
      new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength),
      at,
    );
    at += tensor.data.byteLength;
  }
  return file;
}

const folder = path.join(
  new URL('../../..', import.meta.url).pathname,
  '.reference',
  'da3-miniature',
);
mkdirSync(folder, { recursive: true });
writeFileSync(
  path.join(folder, 'checkpoint.safetensors'),
  safetensors(miniatureCheckpoint(MINIATURE_DEPTH_ANYTHING_3, MINIATURE_SEED)),
);
const inputs = new Map<string, { shape: readonly number[]; data: Float32Array }>();
for (const [name, { views, height, width }] of Object.entries(MINIATURE_CASES)) {
  const images = miniatureImages(views, height, width, MINIATURE_SEED);
  const data = new Float32Array(views * 3 * height * width);
  images.forEach((image, v) => data.set(image, v * image.length));
  inputs.set(name, { shape: [1, views, 3, height, width], data });
}
writeFileSync(path.join(folder, 'input.safetensors'), safetensors(inputs));
/* Depth Anything V2's miniature, and the single case as its one view. */
writeFileSync(
  path.join(folder, 'checkpoint2.safetensors'),
  safetensors(miniatureCheckpoint2(MINIATURE_DEPTH_ANYTHING_2, MINIATURE_SEED)),
);
/* MobileSAM's miniature, its image, and its prompts as the upstream's predictor takes them. */
const sam = path.join(folder, '..', 'sam-miniature');
mkdirSync(sam, { recursive: true });
writeFileSync(
  path.join(sam, 'checkpoint.safetensors'),
  safetensors(miniatureSamCheckpoint(MINIATURE_MOBILE_SAM, MINIATURE_SEED)),
);
const [samImage] = miniatureImages(
  1,
  MINIATURE_MOBILE_SAM.size,
  MINIATURE_MOBILE_SAM.size,
  MINIATURE_SEED,
);
writeFileSync(
  path.join(sam, 'input.safetensors'),
  safetensors(
    new Map([
      [
        'image',
        {
          shape: [1, 3, MINIATURE_MOBILE_SAM.size, MINIATURE_MOBILE_SAM.size],
          data: samImage as Float32Array,
        },
      ],
    ]),
  ),
);
writeFileSync(
  path.join(sam, 'prompts.json'),
  JSON.stringify({ image: MINIATURE_SAM_IMAGE, prompts: MINIATURE_SAM_PROMPTS }, null, 2),
);
/* SAM 2.1's miniature and four frames, for its encoder, its decoder and its video half. */
const sam21 = path.join(folder, '..', 'sam21-miniature');
mkdirSync(sam21, { recursive: true });
writeFileSync(
  path.join(sam21, 'checkpoint.safetensors'),
  safetensors(miniatureSam21Checkpoint(MINIATURE_SAM_21, MINIATURE_SEED)),
);
const frames = miniatureImages(4, MINIATURE_SAM_21.size, MINIATURE_SAM_21.size, MINIATURE_SEED);
writeFileSync(
  path.join(sam21, 'input.safetensors'),
  safetensors(
    new Map(
      frames.map((frame, i) => [
        `frame${i}`,
        { shape: [1, 3, MINIATURE_SAM_21.size, MINIATURE_SAM_21.size], data: frame },
      ]),
    ),
  ),
);
writeFileSync(
  path.join(sam21, 'prompts.json'),
  JSON.stringify({ image: MINIATURE_SAM_21_IMAGE, prompts: MINIATURE_SAM_21_PROMPTS }, null, 2),
);
/* OWLv2's miniature, its image, and its queries as token ids. */
const owlv2 = path.join(folder, '..', 'owlv2-miniature');
mkdirSync(owlv2, { recursive: true });
writeFileSync(
  path.join(owlv2, 'checkpoint.safetensors'),
  safetensors(miniatureOwlv2Checkpoint(MINIATURE_OWLV2, MINIATURE_SEED)),
);
const [owlImage] = miniatureImages(1, MINIATURE_OWLV2.size, MINIATURE_OWLV2.size, MINIATURE_SEED);
writeFileSync(
  path.join(owlv2, 'input.safetensors'),
  safetensors(
    new Map([
      [
        'image',
        {
          shape: [1, 3, MINIATURE_OWLV2.size, MINIATURE_OWLV2.size],
          data: owlImage as Float32Array,
        },
      ],
    ]),
  ),
);
writeFileSync(
  path.join(owlv2, 'queries.json'),
  JSON.stringify({ image: MINIATURE_OWLV2_IMAGE, queries: MINIATURE_OWLV2_QUERIES }, null, 2),
);
console.log(
  `wrote the miniatures and their inputs to ${path.relative(process.cwd(), folder)}, ` +
    `${path.relative(process.cwd(), sam)}, ${path.relative(process.cwd(), sam21)} and ` +
    `${path.relative(process.cwd(), owlv2)}`,
);

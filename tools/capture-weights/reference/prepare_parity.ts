/**
 * The engine's frame preparation, held to the preparation each upstream does to its own inputs.
 *
 * **A model is only as right as what it is given.** Each `*_parity.py` saves the frames it prepared
 * and, beside them, the frames as a host hands them over — RGBA bytes — so this can prepare the
 * same pixels here and compare, without a PNG decoder on this side. A difference here is a
 * difference in every answer downstream, and it would otherwise hide inside a model's own
 * tolerance.
 *
 * **Three of the four are exact**, because each upstream's resize is repeated rather than
 * approximated: MobileSAM's is Pillow's bilinear at 22 fraction bits and SAM 2.1's is torchvision's
 * at 15, and neither has a value apart. Depth Anything 3's is OpenCV's area resize, which leaves
 * 24 values of 846,720 a single level of 255 apart, where a weighted sum lands on a half. OWLv2's
 * is a gaussian blur and a plain bilinear in floating point, so it agrees to a ten-thousandth
 * rather than exactly — a hundredth of one level of 255.
 *
 * **It fails beyond those**, which are measurements rather than choices.
 *
 *     env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/da3_parity.py
 *     ... and sam_parity.py, sam21_parity.py, owlv2_parity.py
 *     npx tsx --conditions=drift-source tools/capture-weights/reference/prepare_parity.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  OWLV2_PIXEL_MEAN,
  OWLV2_PIXEL_STD,
  SAM_PIXEL_MEAN,
  SAM_PIXEL_STD,
  prepareDepthFrame,
  prepareOwlv2Frame,
  prepareSam2Frame,
  prepareSamFrame,
  type PreparedFrame,
} from '../../../packages/capture/src/index.ts';
import { tensorFloats } from '../checkpoint.ts';
import { readSafetensors } from '../safetensors.ts';

const ROOT = new URL('../../..', import.meta.url).pathname;
const failures: string[] = [];

interface Case {
  readonly label: string;
  readonly folder: string;
  /** The tensor holding what the upstream prepared, and the frames beside it. */
  readonly prepared: string;
  readonly frames: readonly string[];
  /** How far a value may sit from the upstream's, and how many may sit there at all. */
  readonly apart: number;
  readonly share: number;
  prepare(rgba: Uint8Array, width: number, height: number): PreparedFrame;
}

/* A level of 255 in each model's own normalisation, which is what a rounded byte is worth. */
const DEPTH_LEVEL = 1 / 255 / 0.224;

const CASES: readonly Case[] = [
  {
    label: 'Depth Anything 3',
    folder: '.reference/da3-parity',
    prepared: 'images',
    frames: ['frame0.rgba', 'frame1.rgba'],
    apart: DEPTH_LEVEL * 1.01,
    share: 1e-4,
    prepare: (rgba, width, height) => prepareDepthFrame(rgba, width, height),
  },
  {
    label: 'MobileSAM',
    folder: '.reference/sam-parity',
    prepared: 'prepared',
    frames: ['frame.rgba'],
    apart: 1e-6,
    share: 0,
    prepare: (rgba, width, height) =>
      prepareSamFrame(rgba, width, height, SAM_PIXEL_MEAN, SAM_PIXEL_STD),
  },
  {
    label: 'SAM 2.1',
    folder: '.reference/sam21-parity',
    prepared: 'frame0',
    frames: ['frame0.rgba'],
    apart: 1e-6,
    share: 0,
    prepare: (rgba, width, height) => prepareSam2Frame(rgba, width, height),
  },
  {
    label: 'OWLv2',
    folder: '.reference/owlv2-parity',
    prepared: 'image',
    frames: ['frame.rgba'],
    apart: 3e-4,
    share: 1,
    prepare: (rgba, width, height) =>
      prepareOwlv2Frame(rgba, width, height, OWLV2_PIXEL_MEAN, OWLV2_PIXEL_STD),
  },
];

for (const one of CASES) {
  const file = path.join(ROOT, one.folder, 'output.safetensors');
  if (!existsSync(file)) {
    console.log(`${one.label}: ${one.folder} has no answers yet; run its parity first`);
    continue;
  }
  const tensors = readSafetensors(new Uint8Array(readFileSync(file)));
  const take = (name: string): { shape: readonly number[]; data: Float32Array } => {
    const tensor = tensors.get(name);
    if (tensor === undefined) throw new Error(`${one.folder} has no "${name}"`);
    return { shape: tensor.shape, data: tensorFloats(name, tensor) };
  };
  const prepared = take(one.prepared);
  const per = prepared.data.length / one.frames.length;
  one.frames.forEach((name, index) => {
    const frame = take(name);
    const [rows, columns] = frame.shape as [number, number, number];
    const ours = one.prepare(Uint8Array.from(frame.data), columns, rows);
    let worst = 0;
    let apart = 0;
    for (let at = 0; at < per; at += 1) {
      const off = Math.abs(
        (ours.pixels[at] as number) - (prepared.data[index * per + at] as number),
      );
      worst = Math.max(worst, off);
      if (off > 1e-6) apart += 1;
    }
    const share = apart / per;
    if (worst > one.apart || share > one.share) {
      failures.push(
        `${one.label} frame ${index}: ${apart} of ${per} apart (${(share * 100).toFixed(4)}%), ` +
          `worst ${worst.toExponential(2)} against ${one.apart.toExponential(2)}`,
      );
    }
    console.log(
      `${one.label} frame ${index}: ${columns}×${rows} → ${ours.width}×${ours.height}; ` +
        `${apart} of ${per} apart (${(share * 100).toFixed(4)}%), worst ${worst.toExponential(2)}`,
    );
  });
}

if (failures.length > 0) console.log(`\noutside the tolerance:\n  ${failures.join('\n  ')}`);
process.exit(failures.length === 0 ? 0 : 1);

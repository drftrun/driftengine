import { createGraphEvaluator, graphFromWeights, type WeightSource } from '@driftengine/texture';
import { expect, test } from 'vitest';

import { MINIATURE_SEED, miniatureImages } from './miniature.ts';
import { owlv2BoxBias, owlv2Image, owlv2Text } from './owlv2.ts';
import { owlv2Detections, owlv2Logits } from './owlv2Detect.ts';
import {
  MINIATURE_OWLV2,
  MINIATURE_OWLV2_IMAGE,
  MINIATURE_OWLV2_MERGES,
  MINIATURE_OWLV2_QUERIES,
  miniatureOwlv2Checkpoint,
} from './owlv2Miniature.ts';

/**
 * **OWLv2 here answers as Transformers' `Owlv2ForObjectDetection` does**, on a seeded miniature of
 * its layout loaded through `from_pretrained` with nothing missing, unexpected or mismatched: every
 * number below is what the upstream's own model and its own post-processing wrote, at the revision
 * the manifest pins (`tools/capture-weights/reference/owlv2_miniature.py`) — the graphs' values
 * taken where the upstream computes them, before the class head normalises them.
 *
 * **Absolute tolerances, about three times the worst measured over whole outputs**: 4.1e-6 on
 * values up to 3.8, and 7.6e-6 on boxes in pixels up to 54. The box prior is held bit for bit.
 */

const TOLERANCE = 1.5e-5;
const PIXELS = 2.5e-5;

const config = MINIATURE_OWLV2;
const checkpoint = miniatureOwlv2Checkpoint(config, MINIATURE_SEED);
checkpoint.set('tokenizer.merges', { shape: [3, 2], data: MINIATURE_OWLV2_MERGES });
const weights: WeightSource = {
  get: (name) => checkpoint.get(name),
  names: () => checkpoint.keys(),
};
const [image] = miniatureImages(1, config.size, config.size, MINIATURE_SEED);
const count = MINIATURE_OWLV2_QUERIES.length;

const near = (
  actual: Float32Array,
  expected: readonly (readonly [number, number])[],
  tolerance: number,
): void => {
  for (const [at, value] of expected) {
    expect(
      Math.abs((actual[at] as number) - value),
      `[${at}] ${actual[at]} against ${value}`,
    ).toBeLessThanOrEqual(tolerance);
  }
};

let patches: ReadonlyMap<string, Float32Array> | undefined;
const imageGraph = (): ReadonlyMap<string, Float32Array> => {
  if (patches === undefined) {
    const out = createGraphEvaluator(graphFromWeights(weights, owlv2Image(config))).run(
      new Map([['image', image as Float32Array]]),
    );
    patches = new Map([...out].map(([name, values]) => [name, Float32Array.from(values)]));
  }
  return patches;
};
const textGraph = (): Float32Array => {
  const tokens = new Float32Array(count * config.text.positions);
  const ends = new Float32Array(count);
  MINIATURE_OWLV2_QUERIES.forEach((query, q) => {
    tokens.set(query, q * config.text.positions);
    ends[q] = q * config.text.positions + query.length - 1;
  });
  const out = createGraphEvaluator(graphFromWeights(weights, owlv2Text(config, count))).run(
    new Map([
      ['tokens', tokens],
      ['ends', ends],
    ]),
  );
  return Float32Array.from(out.get('queries') as Float32Array);
};

test("THE BOX PRIOR IS THE UPSTREAM'S BIT FOR BIT: the logit of each cell's far corner and of the cell's size", () => {
  const bias = owlv2BoxBias(4);
  /* Cell 0's x, cell 3's x at the right edge, cell 5's y at the middle, cell 10's x, cell 15's x. */
  expect(bias[2]).toBe(-1.0983457565307617);
  expect(bias[12]).toBe(9.210274696350098);
  expect(bias[21]).toBe(5.960464477539063e-8);
  expect(bias[40]).toBe(1.0983457565307617);
  expect(bias[60]).toBe(9.210274696350098);
});

test('THE IMAGE GRAPH ANSWERS AS TRANSFORMERS’ DOES: class embeddings, the logit’s shift and scale, boxes and objectness', () => {
  const out = imageGraph();
  near(
    out.get('classes') as Float32Array,
    [
      [0, -1.3065756559371948],
      [7, -0.9619342088699341],
      [23, 1.0637396574020386],
      [220, -0.7805610299110413],
      [383, -0.4113583564758301],
    ],
    TOLERANCE,
  );
  near(
    out.get('shift') as Float32Array,
    [
      [0, 1.2593307495117188],
      [5, 1.3576501607894897],
      [15, -0.16204966604709625],
    ],
    TOLERANCE,
  );
  near(
    out.get('scale') as Float32Array,
    [
      [0, -0.49569258093833923],
      [5, 0.6549473404884338],
      [15, 0.31411194801330566],
    ],
    TOLERANCE,
  );
  near(
    out.get('boxes') as Float32Array,
    [
      [0, 0.26012080907821655],
      [1, 0.21971973776817322],
      [2, 0.31683170795440674],
      [3, 0.2605729103088379],
      [26, 0.2346031665802002],
      [63, 0.20036925375461578],
    ],
    TOLERANCE,
  );
  near(
    out.get('objectness') as Float32Array,
    [
      [0, -1.0086684226989746],
      [6, -0.8940458297729492],
      [15, -0.4166165590286255],
    ],
    TOLERANCE,
  );
});

test('THE TEXT GRAPH READS EACH QUERY CAUSALLY TO ITS END: one short, one holding the padding token, one filling every position', () => {
  near(
    textGraph(),
    [
      [0, 1.243196964263916],
      [13, 0.9903247952461243],
      [29, -0.42143529653549194],
      [67, -0.16458383202552795],
      [71, -1.0925750732421875],
    ],
    TOLERANCE,
  );
});

test("the host joins the two into the upstream's logits, and those into its detections", () => {
  const out = imageGraph();
  const logits = new Float32Array((out.get('shift') as Float32Array).length * count);
  owlv2Logits(
    {
      classes: out.get('classes') as Float32Array,
      shift: out.get('shift') as Float32Array,
      scale: out.get('scale') as Float32Array,
    },
    textGraph(),
    count,
    logits,
  );
  near(
    logits,
    [
      [0, 0.42777010798454285],
      [1, 0.529551088809967],
      [2, 0.5973968505859375],
      [22, -0.6080677509307861],
      [47, 0.15936864912509918],
    ],
    TOLERANCE,
  );
  const { height, width } = MINIATURE_OWLV2_IMAGE;
  const found = owlv2Detections(
    logits,
    out.get('boxes') as Float32Array,
    count,
    0.3,
    height,
    width,
  );
  expect(found.length).toBe(13);
  const expected: readonly (readonly [number, number, number, readonly number[]])[] = [
    [
      0,
      2,
      0.6450604796409607,
      [4.881837844848633, 4.292797565460205, 20.089759826660156, 16.800296783447266],
    ],
    [
      4,
      2,
      0.9082600474357605,
      [18.229116439819336, 16.53074073791504, 29.209365844726562, 27.345102310180664],
    ],
    [
      8,
      0,
      0.37240955233573914,
      [21.65304183959961, 29.973899841308594, 31.155723571777344, 41.820159912109375],
    ],
    [
      12,
      2,
      0.539758026599884,
      [43.15086364746094, 43.185752868652344, 52.837154388427734, 52.80348205566406],
    ],
  ];
  for (const [at, label, score, box] of expected) {
    const detection = found[at];
    expect(detection?.label).toBe(label);
    expect(Math.abs((detection?.score ?? 0) - score)).toBeLessThanOrEqual(TOLERANCE);
    near(
      Float32Array.from(detection?.box ?? []),
      box.map((value, i) => [i, value] as const),
      PIXELS,
    );
  }
});

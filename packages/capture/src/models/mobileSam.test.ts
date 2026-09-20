import { createGraphEvaluator, graphFromWeights, type WeightSource } from '@driftengine/texture';
import { expect, test } from 'vitest';

import { MINIATURE_SEED, miniatureImages } from './miniature.ts';
import { mobileSamDecoder, mobileSamEncoder, samMasksToImage } from './mobileSam.ts';
import { samGridPositions, samPromptTokens, samTokenCount, stabilityScore } from './samPrompt.ts';
import {
  MINIATURE_MOBILE_SAM,
  MINIATURE_SAM_IMAGE,
  MINIATURE_SAM_PROMPTS,
  miniatureSamCheckpoint,
} from './samMiniature.ts';

/**
 * **MobileSAM here answers as MobileSAM does**, on a seeded miniature: every number below is what
 * the upstream's own modules wrote for this checkpoint, image and prompts at the manifest's pinned
 * revision, loaded strictly (`tools/capture-weights/reference/sam_miniature.py`).
 *
 * **Absolute tolerances, three times the worst measured over whole outputs**: 3.1e-6 for anything
 * that passed the encoder or the decoder, on values up to 3.6 — the upstream sums in single
 * precision in another order — and 4.8e-7 for tokens and positions, which differ from the
 * upstream's by the last rounding of a sine. The stability scores are ratios of pixel counts, and
 * agree exactly.
 */

const TOLERANCE = 1e-5;
const TOKEN_TOLERANCE = 1.5e-6;

const config = MINIATURE_MOBILE_SAM;
const checkpoint = miniatureSamCheckpoint(config, MINIATURE_SEED);
const weights: WeightSource = {
  get: (name) => checkpoint.get(name),
  names: () => checkpoint.keys(),
};
const none: WeightSource = { get: () => undefined, names: () => [] };
const { height, width } = MINIATURE_SAM_IMAGE;

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

let embedded: Float32Array | undefined;
const embedding = (): Float32Array => {
  if (embedded === undefined) {
    const [image] = miniatureImages(1, config.size, config.size, MINIATURE_SEED);
    const graph = graphFromWeights(weights, mobileSamEncoder(config));
    embedded = Float32Array.from(
      createGraphEvaluator(graph)
        .run(new Map([['image', image as Float32Array]]))
        .get('embedding') as Float32Array,
    );
  }
  return embedded;
};

const tokensOf = (
  prompt: (typeof MINIATURE_SAM_PROMPTS)[keyof typeof MINIATURE_SAM_PROMPTS],
): Float32Array => {
  const tokens = new Float32Array(samTokenCount(prompt) * config.decoder.dim);
  samPromptTokens(weights, config.decoder.dim, config.size, prompt, height, width, tokens);
  return tokens;
};

const decode = (tokens: Float32Array, mask?: Float32Array): ReadonlyMap<string, Float32Array> => {
  const graph = graphFromWeights(
    weights,
    mobileSamDecoder(config, tokens.length / config.decoder.dim, mask !== undefined),
  );
  const inputs = new Map([
    ['embedding', embedding()],
    ['prompt', tokens],
  ]);
  if (mask !== undefined) inputs.set('mask', mask);
  const out = createGraphEvaluator(graph).run(inputs);
  return new Map([...out].map(([name, values]) => [name, Float32Array.from(values)]));
};

test("A POINT'S TOKENS ARE THE UPSTREAM'S, its padding point included, and a box is its two corners", () => {
  expect(samTokenCount(MINIATURE_SAM_PROMPTS.point)).toBe(2);
  expect(samTokenCount(MINIATURE_SAM_PROMPTS.box)).toBe(2);
  expect(samTokenCount(MINIATURE_SAM_PROMPTS.both)).toBe(4);
  near(
    tokensOf(MINIATURE_SAM_PROMPTS.point),
    [
      [0, 0.3554231822490692],
      [3, -0.3369995951652527],
      [127, -0.7911376357078552],
      [128, 1.0096476078033447],
      [255, 0.6193527579307556],
      [456, 0.06786982715129852],
      [511, 0.043362509459257126],
    ],
    TOKEN_TOLERANCE,
  );
  near(
    tokensOf(MINIATURE_SAM_PROMPTS.box),
    [
      [0, 0.9406909346580505],
      [3, 0.07166430354118347],
      [127, -0.9288550615310669],
      [128, -0.04372318834066391],
      [255, -0.056548792868852615],
      [456, 0.227971613407135],
      [511, 1.0763779878616333],
    ],
    TOKEN_TOLERANCE,
  );
  near(
    tokensOf(MINIATURE_SAM_PROMPTS.both),
    [
      [0, 0.3554231822490692],
      [456, 0.8020344972610474],
      [1023, 1.0763779878616333],
    ],
    TOKEN_TOLERANCE,
  );
});

test("the grid's positions are the upstream's, a cell's centre for each", () => {
  const positions = samGridPositions(
    checkpoint.get('prompt_encoder.pe_layer.positional_encoding_gaussian_matrix')
      ?.data as Float32Array,
    config.decoder.dim,
    4,
  );
  /* The upstream lays them out channel by cell, and the decoder reads them cell by channel. */
  const expected: readonly (readonly [number, number, number])[] = [
    [0, 0, 0.9947126507759094],
    [0, 5, 0.5293986797332764],
    [127, 3, -0.4707631766796112],
    [128, 9, 0.8641997575759888],
    [255, 15, 0.04044688493013382],
  ];
  near(
    positions,
    expected.map(([channel, cell, value]) => [cell * config.decoder.dim + channel, value] as const),
    TOKEN_TOLERANCE,
  );
});

test('THE ENCODER ANSWERS AS MOBILESAM’S DOES, windows padded, whole and divided', () => {
  near(
    embedding(),
    [
      [0, -0.11481364071369171],
      [1, 0.08786394447088242],
      [17, -0.47969236969947815],
      [255, 0.6146277189254761],
      [1000, -0.24516187608242035],
      [2049, -0.36326131224632263],
      [4095, -0.9189268350601196],
    ],
    TOLERANCE,
  );
});

test('THE TWO-WAY DECODER ANSWERS AS THE UPSTREAM’S, four masks and their quality, for a point, a box and both', () => {
  const cases = [
    [
      MINIATURE_SAM_PROMPTS.point,
      [-0.33915266394615173, -0.5319389700889587, 0.025008395314216614, 0.21527493000030518],
      [
        [0, 1.9085440635681152],
        [37, -0.5522131323814392],
        [255, 0.6261451244354248],
        [356, 0.2625310719013214],
        [529, 0.5174713134765625],
        [1023, -0.5255741477012634],
      ],
    ],
    [
      MINIATURE_SAM_PROMPTS.box,
      [-0.23263736069202423, -0.4227352738380432, 0.3074103593826294, 0.009301893413066864],
      [
        [0, 0.7123618125915527],
        [37, -0.30975109338760376],
        [356, -0.14055319130420685],
        [1023, -1.0377459526062012],
      ],
    ],
    [
      MINIATURE_SAM_PROMPTS.both,
      [-0.3296428620815277, -0.3370228409767151, 0.08424322307109833, 0.12934058904647827],
      [
        [0, 0.4156096875667572],
        [37, -0.4708763360977173],
        [529, 0.3047349452972412],
        [1023, -0.9763398170471191],
      ],
    ],
  ] as const;
  for (const [prompt, quality, masks] of cases) {
    const out = decode(tokensOf(prompt));
    near(
      out.get('quality') as Float32Array,
      quality.map((value, i) => [i, value] as const),
      TOLERANCE,
    );
    near(out.get('masks') as Float32Array, masks, TOLERANCE);
  }
});

test('a mask comes up to the original image as the upstream brings it, and scores the same stability', () => {
  const masks = decode(tokensOf(MINIATURE_SAM_PROMPTS.point)).get('masks') as Float32Array;
  const image = createGraphEvaluator(
    graphFromWeights(none, samMasksToImage(config, config.decoder.masks, height, width)),
  )
    .run(new Map([['masks', masks]]))
    .get('image') as Float32Array;
  const pixels = height * width;
  expect(image.length).toBe(4 * pixels);
  near(
    image,
    [
      [0, 1.9085440635681152],
      [500, 0.18056964874267578],
      [1727, 0.3432905077934265],
      [pixels + 900, 0.2929811179637909],
      [3 * pixels + 1200, -0.3613182604312897],
    ],
    TOLERANCE,
  );
  /* 362 pixels of 1,728 above +1, then 12 of 1,711, 7 of 1,712 and 34 of 1,720, as the upstream counts. */
  const scores = [0, 1, 2, 3].map((m) =>
    stabilityScore(image.subarray(m * pixels, (m + 1) * pixels), 0, 1),
  );
  expect(scores.map(Math.fround)).toEqual([
    0.20949074625968933, 0.00701344246044755, 0.004088785033673048, 0.01976744271814823,
  ]);
});

test('A MASK GIVEN BACK IS REFINED AS THE UPSTREAM REFINES IT, through the downscaling it takes', () => {
  const tokens = tokensOf(MINIATURE_SAM_PROMPTS.point);
  const first = (decode(tokens).get('masks') as Float32Array).slice(0, 16 * 16);
  const out = decode(tokens, first);
  near(
    out.get('quality') as Float32Array,
    [
      [0, 0.17502301931381226],
      [1, 0.2580487132072449],
      [2, 0.4778013825416565],
      [3, 0.1694299280643463],
    ],
    TOLERANCE,
  );
  near(
    out.get('masks') as Float32Array,
    [
      [0, 0.9809125661849976],
      [37, -0.23351474106311798],
      [356, 0.9951488971710205],
      [1023, -0.7648922801017761],
    ],
    TOLERANCE,
  );
});

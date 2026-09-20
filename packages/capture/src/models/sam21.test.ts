import { createGraphEvaluator, graphFromWeights, type WeightSource } from '@driftengine/texture';
import { expect, test } from 'vitest';

import { MINIATURE_SEED, miniatureImages } from './miniature.ts';
import { sam21Decoder, sam21Encoder } from './sam21.ts';
import {
  MINIATURE_SAM_21,
  MINIATURE_SAM_21_IMAGE,
  MINIATURE_SAM_21_PROMPTS,
  miniatureSam21Checkpoint,
} from './sam21Miniature.ts';
import { Sam21Tracker } from './sam2Tracker.ts';
import {
  SAM2_PROMPT,
  samGridPositions,
  samPromptTokens,
  samTokenCount,
  type SamPrompt,
} from './samPrompt.ts';

/**
 * **SAM 2.1 here answers as Transformers' `Sam2VideoModel` does**, on a seeded miniature of its
 * layout loaded through `from_pretrained` with nothing missing, unexpected or mismatched: every
 * number below is what the upstream's own modules and its own video loop wrote, at the revision the
 * manifest pins (`tools/capture-weights/reference/sam21_miniature.py`).
 *
 * **Absolute tolerances, about three times the worst measured over whole outputs**: 7.4e-6 for
 * anything through a network, on values up to 7.5 — the encoder, the decoder and three tracked
 * frames — and 4.5e-7 for tokens and tables.
 *
 * **The tracked object is made present by raising the object score's last bias to 2**, in the
 * oracle and here alike; as drawn the score is negative, and that is the second video test's case —
 * every absent-object path, which as drawn is all the miniature would ever show.
 */

const TOLERANCE = 2.5e-5;
const TABLE_TOLERANCE = 1.5e-6;

const config = MINIATURE_SAM_21;
const { height, width } = MINIATURE_SAM_21_IMAGE;
const frames = miniatureImages(4, config.size, config.size, MINIATURE_SEED);
const source = (present: boolean): WeightSource => {
  const checkpoint = miniatureSam21Checkpoint(config, MINIATURE_SEED);
  if (present) {
    checkpoint.set('mask_decoder.pred_obj_score_head.proj_out.bias', {
      shape: [1],
      data: Float32Array.of(2),
    });
  }
  return { get: (name) => checkpoint.get(name), names: () => checkpoint.keys() };
};
const weights = source(false);

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

let encoded: ReadonlyMap<string, Float32Array> | undefined;
const encoder = (): ReadonlyMap<string, Float32Array> => {
  if (encoded === undefined) {
    const out = createGraphEvaluator(graphFromWeights(weights, sam21Encoder(config))).run(
      new Map([['image', frames[0] as Float32Array]]),
    );
    encoded = new Map([...out].map(([name, values]) => [name, Float32Array.from(values)]));
  }
  return encoded;
};

test("SAM 2'S PROMPT TOKENS AND GRID POSITIONS ARE THE UPSTREAM'S, a box three tokens and the frame scaled to its square", () => {
  const tokensOf = (
    prompt: (typeof MINIATURE_SAM_21_PROMPTS)[keyof typeof MINIATURE_SAM_21_PROMPTS],
  ) => {
    const out = new Float32Array(samTokenCount(prompt, SAM2_PROMPT) * config.decoder.dim);
    samPromptTokens(
      weights,
      config.decoder.dim,
      config.size,
      prompt,
      height,
      width,
      out,
      SAM2_PROMPT,
    );
    return out;
  };
  expect(samTokenCount(MINIATURE_SAM_21_PROMPTS.box, SAM2_PROMPT)).toBe(3);
  near(
    tokensOf(MINIATURE_SAM_21_PROMPTS.point),
    [
      [0, 0.5245059132575989],
      [3, -0.6638674736022949],
      [63, -0.3906097114086151],
      [64, 0.8312754034996033],
      [127, 0.9522005319595337],
      [228, 0.04822026565670967],
      [255, -0.09122684597969055],
    ],
    TABLE_TOLERANCE,
  );
  near(
    tokensOf(MINIATURE_SAM_21_PROMPTS.box),
    [
      [0, 0.930574893951416],
      [3, 0.3466606140136719],
      [228, 1.0230904817581177],
      [383, -0.09122684597969055],
    ],
    TABLE_TOLERANCE,
  );
  near(tokensOf(MINIATURE_SAM_21_PROMPTS.both), [[228, 0.8837336897850037]], TABLE_TOLERANCE);
  /* The upstream lays positions out channel by cell, and the decoder reads them cell by channel. */
  const positions = samGridPositions(
    weights.get('shared_image_embedding.positional_embedding')?.data as Float32Array,
    config.decoder.dim,
    4,
  );
  const expected: readonly (readonly [number, number, number])[] = [
    [0, 0, -0.35289713740348816],
    [0, 5, 0.9197407960891724],
    [63, 3, 0.6868433952331543],
    [64, 9, 0.9997527599334717],
    [127, 15, 0.8115971684455872],
  ];
  near(
    positions,
    expected.map(([channel, cell, value]) => [cell * config.decoder.dim + channel, value] as const),
    TABLE_TOLERANCE,
  );
});

test('THE HIERA ENCODER ANSWERS AS TRANSFORMERS’ DOES, windows divided, padded and outgrown, queries pooled and one block global', () => {
  const out = encoder();
  near(
    out.get('high0') as Float32Array,
    [
      [0, 0.17929311096668243],
      [5, 0.06364894658327103],
      [37, 0.25554779171943665],
      [2048, -0.43283408880233765],
      [4095, 2.410231590270996],
    ],
    TOLERANCE,
  );
  near(
    out.get('high1') as Float32Array,
    [
      [0, 1.3962618112564087],
      [37, 2.7425150871276855],
      [2047, -0.9684500694274902],
    ],
    TOLERANCE,
  );
  near(
    out.get('features') as Float32Array,
    [
      [0, 0.3270169496536255],
      [5, -0.9755582809448242],
      [1024, 1.8043771982192993],
      [2047, 2.1704185009002686],
    ],
    TOLERANCE,
  );
});

test('THE DECODER ANSWERS AS TRANSFORMERS’ DOES: four masks, their quality, the object score and every pointer', () => {
  const tokens = new Float32Array(samTokenCount(MINIATURE_SAM_21_PROMPTS.point, SAM2_PROMPT) * 128);
  samPromptTokens(
    weights,
    128,
    config.size,
    MINIATURE_SAM_21_PROMPTS.point,
    height,
    width,
    tokens,
    SAM2_PROMPT,
  );
  const features = encoder();
  const out = createGraphEvaluator(
    graphFromWeights(weights, sam21Decoder(config, tokens.length / 128, { noMemory: true })),
  ).run(
    new Map([
      ['embedding', features.get('features') as Float32Array],
      ['high1', features.get('high1') as Float32Array],
      ['high0', features.get('high0') as Float32Array],
      ['prompt', tokens],
    ]),
  );
  near(
    out.get('quality') as Float32Array,
    [0.573183000087738, 0.5931081175804138, 0.5626317858695984, 0.5048372149467468].map(
      (value, i) => [i, value] as const,
    ),
    TOLERANCE,
  );
  near(out.get('object') as Float32Array, [[0, -0.33046966791152954]], TOLERANCE);
  near(
    out.get('masks') as Float32Array,
    [
      [0, 1.044569492340088],
      [37, -0.08115258067846298],
      [356, -0.4394983649253845],
      [529, 1.353313684463501],
      [1023, 0.7263329029083252],
    ],
    TOLERANCE,
  );
  near(
    out.get('pointers') as Float32Array,
    [
      [0, 0.5645907521247864],
      [77, 0.26019683480262756],
      [133, 0.45445355772972107],
      [511, -0.12116211652755737],
    ],
    TOLERANCE,
  );
});

const track = async (
  present: boolean,
): Promise<readonly { masks: Float32Array; scores: Float32Array }[]> => {
  const all = source(present);
  const tracker = new Sam21Tracker(
    config,
    { encoder: all, decoder: all, memoryEncoder: all, memoryAttention: all },
    async (graph, inputs) => createGraphEvaluator(graph).run(inputs),
    { frames: 4, height, width, frame: (i) => frames[i] as Float32Array },
  );
  tracker.prompt(
    0,
    new Map<number, SamPrompt>([
      [1, MINIATURE_SAM_21_PROMPTS.point],
      [2, { box: MINIATURE_SAM_21_PROMPTS.box.box }],
      [3, { points: MINIATURE_SAM_21_PROMPTS.both.points }],
    ]),
  );
  const out = [];
  for (let frame = 0; frame < 4; frame += 1) out.push(await tracker.step(frame));
  return out;
};

/*
 * A point decodes three masks and keeps the best; a box's two corners decode one, whose stability,
 * 0.9804, just clears 0.98; and two points decode one that does not, 0.9612, so falls back to the
 * best of three while its pointer stays the single mask's. The fourth frame reads two tracked
 * frames' memories, so their order matters.
 */
test('A MASK IS CARRIED FROM ONE FRAME TO THE NEXT AS THE UPSTREAM CARRIES IT: a point, a box and two points, four frames', async () => {
  const tracked = await track(true);
  const scores = [
    [1.629594326019287, 1.5783300399780273, 1.6545151472091675],
    [1.6053131818771362, 1.503671646118164, 1.5895004272460938],
    [1.5807701349258423, 1.541862964630127, 1.5851049423217773],
    [1.549865484237671, 1.5247182846069336, 1.5503549575805664],
  ];
  const masks = [
    [
      -1.0297017097473145, 2.768343448638916, 2.407837152481079, 0.37881454825401306,
      -0.25213101506233215, 0.1646631360054016, 2.1906068325042725,
    ],
    [
      -0.32441025972366333, 0.8843658566474915, 0.228318452835083, -2.7007200717926025,
      0.2524850070476532, -1.9450640678405762, 0.21119211614131927,
    ],
    [
      -1.2848424911499023, 1.5322648286819458, -0.46248435974121094, -0.8893461227416992,
      -0.4002859890460968, -2.429217576980591, -0.45597031712532043,
    ],
    [
      -0.12092071771621704, -0.5921492576599121, -2.212603807449341, 1.1350969076156616,
      -2.236567735671997, 0.468438059091568, -2.2140674591064453,
    ],
  ];
  const at = [0, 37, 255, 356, 511, 552, 767];
  tracked.forEach((frame, i) => {
    near(
      frame.scores,
      (scores[i] as number[]).map((value, j) => [j, value] as const),
      TOLERANCE,
    );
    near(
      frame.masks,
      (masks[i] as number[]).map((value, j) => [at[j] as number, value] as const),
      TOLERANCE,
    );
  });
});

test('an absent object is tracked as absent: every mask the placeholder, and the scores the upstream gives it', async () => {
  const tracked = await track(false);
  const scores = [
    [-0.33046966791152954, -0.3817339539527893, -0.3055488169193268],
    [-0.26655641198158264, -0.26655641198158264, -0.26655641198158264],
    [-0.2723420560359955, -0.2723420560359955, -0.2723420560359955],
    [-0.330340713262558, -0.330340713262558, -0.330340713262558],
  ];
  tracked.forEach((frame, i) => {
    near(
      frame.scores,
      (scores[i] as number[]).map((value, j) => [j, value] as const),
      TOLERANCE,
    );
    expect(frame.masks.every((value) => value === -1024)).toBe(true);
  });
});

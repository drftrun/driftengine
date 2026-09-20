import { describe, expect, test } from 'vitest';
import { packDecodeTables, programFromEncoded } from '@driftengine/core';
import {
  ADDRESS_MODE,
  createDecodeRegisters,
  decodeCpu,
  type ChannelSpec,
  type LatentImage,
} from '@driftengine/texture';

import {
  LATENT_MAX_COMPONENTS,
  decodeMaterialAt,
  encodeMaterial,
  latentImageOf,
  materialBytes,
  type ChannelInput,
} from './latent.ts';

const SIZE = 64;

/** A flat colour in every channel. */
function flat(values: readonly number[]): ChannelInput[] {
  return values.map((value, component) => ({
    spec: { semantic: 'albedo-linear', component } as ChannelSpec,
    data: new Float32Array(SIZE * SIZE).fill(value),
  }));
}

/**
 * Two channels that are the *same* pattern at different scales.
 *
 * Correlated by construction, which is the case the whole design rests on: if joint encoding does
 * not beat separate encoding here it does not beat it anywhere.
 */
function correlated(): ChannelInput[] {
  const a = new Float32Array(SIZE * SIZE);
  const b = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const at = y * SIZE + x;
      const value = 0.5 + 0.4 * Math.sin(x * 0.2) * Math.cos(y * 0.15);
      a[at] = value;
      b[at] = 0.2 + 0.6 * value;
    }
  }
  return [
    { spec: { semantic: 'albedo-linear', component: 0 } as ChannelSpec, data: a },
    { spec: { semantic: 'roughness-linear', component: 1 } as ChannelSpec, data: b },
  ];
}

/** Two channels with nothing in common, which is the case joint encoding cannot help. */
function independent(): ChannelInput[] {
  const a = new Float32Array(SIZE * SIZE);
  const b = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const at = y * SIZE + x;
      a[at] = 0.5 + 0.4 * Math.sin(x * 0.31);
      b[at] = 0.5 + 0.4 * Math.sin(y * 0.47 + 1.3);
    }
  }
  return [
    { spec: { semantic: 'albedo-linear', component: 0 } as ChannelSpec, data: a },
    { spec: { semantic: 'roughness-linear', component: 1 } as ChannelSpec, data: b },
  ];
}

/** Root-mean-square error of the decode against the source, over every texel. */
function errorOf(
  channels: readonly ChannelInput[],
  encoded: ReturnType<typeof encodeMaterial>,
): number {
  const out = new Float32Array(4);
  let sum = 0;
  let count = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      decodeMaterialAt(encoded, x / (SIZE - 1), y / (SIZE - 1), out);
      for (const channel of channels) {
        const want = channel.data[y * SIZE + x] as number;
        const got = out[channel.spec.component] as number;
        sum += (want - got) ** 2;
        count += 1;
      }
    }
  }
  return Math.sqrt(sum / count);
}

describe('a material encodes to a latent and a small network', () => {
  test('reproduces a flat colour within tolerance', () => {
    const channels = flat([0.25, 0.5, 0.75]);
    const encoded = encodeMaterial(channels, SIZE, SIZE, { quality: 0.5 });
    expect(errorOf(channels, encoded)).toBeLessThan(0.01);
  });

  test('decodes through the real interpreter, not a second path of its own', () => {
    /*
     * **The encoder's output is a `DecodeGraph`, and this runs it.** An encoder tested only against
     * its own decoder is an encoder that agrees with itself; what has to be true is that the
     * program it emits produces the picture when `decodeCpu` runs it, because `decodeCpu` is what
     * the shader has to agree with.
     */
    const channels = correlated();
    const encoded = encodeMaterial(channels, SIZE, SIZE, { quality: 0.6 });
    const latent: LatentImage = latentImageOf(encoded);
    const registers = createDecodeRegisters();
    const out = new Float32Array(4);
    const mine = new Float32Array(4);
    let worst = 0;
    for (let y = 0; y < SIZE; y += 7) {
      for (let x = 0; x < SIZE; x += 5) {
        const u = x / (SIZE - 1);
        const v = y / (SIZE - 1);
        decodeCpu(
          encoded.graph,
          {
            latents: [latent],
            blocks: [],
            networks: [{ shape: encoded.shape, weights: encoded.weights }],
          },
          u,
          v,
          0,
          out,
          registers,
        );
        decodeMaterialAt(encoded, u, v, mine);
        for (let c = 0; c < 2; c += 1) {
          worst = Math.max(worst, Math.abs((out[c] as number) - (mine[c] as number)));
        }
      }
    }
    expect(worst).toBeLessThan(1e-5);
  });

  test('is the same bytes every time it is encoded', () => {
    const a = encodeMaterial(correlated(), SIZE, SIZE, { quality: 0.6 });
    const b = encodeMaterial(correlated(), SIZE, SIZE, { quality: 0.6 });
    expect([...a.latent]).toEqual([...b.latent]);
    expect([...a.weights]).toEqual([...b.weights]);
  });
});

describe('the claim the whole design rests on', () => {
  test('two correlated channels cost less together than apart', () => {
    /*
     * **Asserted, not assumed.** Joint encoding shares one latent across every channel; separate
     * encoding gives each channel its own. For channels that carry the same structure the shared
     * one costs a fraction and reproduces them as well — and the numbers are printed into the
     * commit message rather than left as a claim.
     */
    const channels = correlated();
    const joint = encodeMaterial(channels, SIZE, SIZE, { quality: 0.6 });
    const apart = channels.map((channel) =>
      encodeMaterial([channel], SIZE, SIZE, { quality: 0.6 }),
    );

    const jointBytes = materialBytes(joint);
    const apartBytes = apart.reduce((sum, one) => sum + materialBytes(one), 0);
    /* **2,351 bytes against 4,694**: two channels carrying one structure share one latent
       component, so joint spends one where separate spends two. Half, near enough exactly. */
    expect(jointBytes).toBe(2351);
    expect(apartBytes).toBe(4694);
    expect(jointBytes).toBeLessThan(apartBytes / 1.9);

    /*
     * **And it is not cheaper by being worse — it is cheaper at the same error.** 0.02134 both
     * ways, to five decimal places, because the component the joint encode keeps is the one both
     * channels were made of. If this ever stops being equal, the saving has started coming out of
     * the picture and the number above stops meaning what it says.
     */
    let apartError = 0;
    let count = 0;
    const out = new Float32Array(4);
    for (let i = 0; i < channels.length; i += 1) {
      const one = apart[i] as ReturnType<typeof encodeMaterial>;
      const channel = channels[i] as ChannelInput;
      for (let at = 0; at < SIZE * SIZE; at += 1) {
        const x = at % SIZE;
        const y = Math.floor(at / SIZE);
        decodeMaterialAt(one, x / (SIZE - 1), y / (SIZE - 1), out);
        apartError += ((channel.data[at] as number) - (out[channel.spec.component] as number)) ** 2;
        count += 1;
      }
    }
    apartError = Math.sqrt(apartError / count);
    expect(errorOf(channels, joint)).toBeCloseTo(apartError, 5);
    expect(apartError).toBeCloseTo(0.02134, 5);
  });

  test('does not claim a saving where the channels share nothing', () => {
    /*
     * **The honest other half.** Two independent channels have no shared structure, so one latent
     * component cannot carry both and the encoder has to spend a second — which is exactly what it
     * does. A design that claimed a saving here would be claiming one that is not there.
     */
    const channels = independent();
    const joint = encodeMaterial(channels, SIZE, SIZE, { quality: 0.6 });
    expect(joint.components).toBe(2);
    const shared = encodeMaterial(correlated(), SIZE, SIZE, { quality: 0.6 });
    expect(shared.components).toBe(1);
  });
});

describe('quality', () => {
  test('buys a larger latent and a smaller error, both monotonically', () => {
    const channels = correlated();
    let lastBytes = 0;
    let lastError = Infinity;
    for (const quality of [0.1, 0.35, 0.6, 0.85]) {
      const encoded = encodeMaterial(channels, SIZE, SIZE, { quality });
      const bytes = materialBytes(encoded);
      const error = errorOf(channels, encoded);
      expect(bytes).toBeGreaterThan(lastBytes);
      expect(error).toBeLessThan(lastError);
      lastBytes = bytes;
      lastError = error;
    }
  });

  test('refuses more latent components than a sampled texel can carry', () => {
    /*
     * **Three, not four.** `SAMPLE_LATENT` fills a four-lane register and the fourth lane is the
     * format's alpha, which reads 1 for an image with fewer channels. A fourth latent component
     * would be read by the network as a constant — silently, and only in the places where the
     * encoder had wanted to use it.
     */
    expect(LATENT_MAX_COMPONENTS).toBe(3);
    const many = [0, 1, 2, 3].map((component) => ({
      spec: { semantic: 'albedo-linear', component } as ChannelSpec,
      data: Float32Array.from({ length: SIZE * SIZE }, (_, at) =>
        Math.sin(at * (component + 1) * 0.37),
      ),
    }));
    const encoded = encodeMaterial(many, SIZE, SIZE, { quality: 1 });
    expect(encoded.components).toBeLessThanOrEqual(LATENT_MAX_COMPONENTS);
    expect(encoded.shape.inputs).toBe(encoded.components);
  });
});

describe('the mip chain', () => {
  test('preserves variance for a normal channel and not for a colour one', () => {
    const normals: ChannelInput[] = [0, 1, 2].map((component) => ({
      spec: { semantic: 'normal-tangent-yup', component } as ChannelSpec,
      data: new Float32Array(SIZE * SIZE),
    }));
    /* A surface whose normals disagree inside every 2×2: averaging flattens it, and the roughness
       the reduction hands back is what carries the lost detail. */
    for (let at = 0; at < SIZE * SIZE; at += 1) {
      const flip = (at % 2 === 0 ? 1 : -1) * 0.6;
      (normals[0] as ChannelInput).data[at] = flip;
      (normals[1] as ChannelInput).data[at] = -flip;
      (normals[2] as ChannelInput).data[at] = Math.sqrt(Math.max(0, 1 - 2 * 0.36));
    }
    const rough = encodeMaterial(normals, SIZE, SIZE, { quality: 0.6 });
    expect(rough.mipRoughness).not.toBeNull();
    expect((rough.mipRoughness as Float32Array).some((value) => value > 0)).toBe(true);

    const colour = encodeMaterial(flat([0.3, 0.6, 0.9]), SIZE, SIZE, { quality: 0.6 });
    expect(colour.mipRoughness).toBeNull();
  });

  test('halves until one texel, which is what a sampler expects', () => {
    const encoded = encodeMaterial(correlated(), SIZE, SIZE, { quality: 0.6 });
    expect(encoded.mips.length).toBeGreaterThan(1);
    const last = encoded.mips[encoded.mips.length - 1] as { width: number; height: number };
    expect(last.width).toBe(1);
    expect(last.height).toBe(1);
    for (let i = 1; i < encoded.mips.length; i += 1) {
      const previous = encoded.mips[i - 1] as { width: number };
      const current = encoded.mips[i] as { width: number };
      expect(current.width).toBe(Math.max(1, previous.width >> 1));
    }
  });
});

test('the encoder carries the address mode it was asked for, and lattice clamp when it was not', () => {
  const channel = {
    spec: { semantic: 'mask-linear' as const, component: 0 },
    data: new Float32Array(16).map((_, i) => i / 15),
  };
  expect(encodeMaterial([channel], 4, 4, { quality: 1 }).graph.addressMode).toBe(0);
  expect(
    encodeMaterial([channel], 4, 4, { quality: 1, addressMode: ADDRESS_MODE.CENTRE_WRAP }).graph
      .addressMode,
  ).toBe(ADDRESS_MODE.CENTRE_WRAP);
});

test('THE LATENT IMAGE CARRIES ITS WHOLE CHAIN, so a decode at a level reads that level', () => {
  const channel = {
    spec: { semantic: 'mask-linear' as const, component: 0 },
    data: new Float32Array(64).map((_, i) => (i % 8) / 7),
  };
  const encoded = encodeMaterial([channel], 8, 8, { quality: 1 });
  const image = latentImageOf(encoded);
  expect(image.mips?.length).toBe(encoded.mips.length - 1);
  const last = encoded.mips[encoded.mips.length - 1] as { data: Uint8Array };
  const top = image.mips?.[image.mips.length - 1];
  expect(top?.width).toBe(1);
  expect(top?.data[0]).toBeCloseTo((last.data[0] as number) / 255, 6);
});

/**
 * **The GPU-driven pipeline takes a bake as it stands.** Core describes a program structurally and
 * does not import this package, so the promise that the two shapes meet is kept here, on the side
 * that knows both.
 */
test('A BAKED MATERIAL IS A PROGRAM AS IT STANDS, its chain and its network carried whole', () => {
  const channel = {
    spec: { semantic: 'albedo-linear' as const, component: 0 },
    data: new Float32Array(64).map((_, i) => (i % 3) / 2),
  };
  const encoded = encodeMaterial([channel], 8, 8, { quality: 1, addressMode: 3 });
  const converted = programFromEncoded(encoded);
  expect(converted.graph).toBe(encoded.graph);
  expect(converted.latents[0]?.levels.length).toBe(4);
  expect(converted.latents[0]?.levels[0]).toBe(encoded.latent);
  expect(() => packDecodeTables([converted])).not.toThrow();
});

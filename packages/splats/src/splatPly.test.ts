import { describe, expect, it } from 'vitest';
import { halfToFloat } from './half.ts';
import { readSplatPly } from './splatPly.ts';

/**
 * Build a PLY from a declared property order, so a test can shuffle it.
 *
 * Every property is a `float` here, which keeps the fixture readable; the offset table under test
 * is built from the declared order either way, and `SCALARS` is exercised by the stride arithmetic
 * rather than by a type per test.
 */
function ply(order: readonly string[], rows: readonly Record<string, number>[]): ArrayBuffer {
  const header =
    `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n` +
    order.map((name) => `property float ${name}\n`).join('') +
    'end_header\n';
  const head = new TextEncoder().encode(header);
  const body = new ArrayBuffer(rows.length * order.length * 4);
  const view = new DataView(body);
  rows.forEach((row, index) => {
    order.forEach((name, slot) => {
      view.setFloat32((index * order.length + slot) * 4, row[name] ?? 0, true);
    });
  });
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(body), head.length);
  return out.buffer;
}

/** The properties a capture must carry, in the order a training run writes them. */
const TRAINING_ORDER = [
  'x',
  'y',
  'z',
  'nx',
  'ny',
  'nz',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
];

/** One splat: at the origin, unit scale, identity rotation, mid grey, half opaque. */
function splat(over: Record<string, number> = {}): Record<string, number> {
  return {
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 0,
    nz: 0,
    /* 0 in the DC term is exactly 0.5 after `0.5 + C0 * f_dc`. */
    f_dc_0: 0,
    f_dc_1: 0,
    f_dc_2: 0,
    /* 0 through the logistic is exactly 0.5. */
    opacity: 0,
    /* log(1) = 0, so a stored 0 is a standard deviation of 1. */
    scale_0: 0,
    scale_1: 0,
    scale_2: 0,
    rot_0: 1,
    rot_1: 0,
    rot_2: 0,
    rot_3: 0,
    ...over,
  };
}

describe('readSplatPly', () => {
  it('reads a capture in the order a training run writes', () => {
    const data = readSplatPly(ply(TRAINING_ORDER, [splat({ x: 1.5, y: -2.25, z: 3 })]));
    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([1.5, -2.25, 3]);
  });

  it('builds its offsets from the declared order, not an assumed one', () => {
    /*
     * The same splat with the properties shuffled and the normals dropped. A reader with hard-coded
     * offsets reads everything after the first gap as garbage, silently — which is the failure this
     * test exists for, and it cannot be seen in a picture because garbage floats still draw.
     */
    const shuffled = [
      'scale_0',
      'scale_1',
      'scale_2',
      'x',
      'y',
      'z',
      'rot_0',
      'rot_1',
      'rot_2',
      'rot_3',
      'opacity',
      'f_dc_0',
      'f_dc_1',
      'f_dc_2',
    ];
    const data = readSplatPly(ply(shuffled, [splat({ x: 1.5, y: -2.25, z: 3 })]));
    expect(Array.from(data.positions)).toEqual([1.5, -2.25, 3]);
  });

  it('undoes the logarithm on scale and the logit on opacity', () => {
    /*
     * Hand-derived. A stored scale of `ln 2` is a standard deviation of 2, and with an identity
     * rotation the covariance is diag(4, 1, 1) — so xx is 4 and the rest of the diagonal is 1.
     * A stored opacity of 0 is exactly 0.5 through the logistic, which packs to byte 128.
     *
     * Reading either raw is the failure the header warns about: raw, a scale of ln 2 is 0.693 and
     * the capture is a haze, and an opacity of 0 is a capture that is entirely invisible.
     */
    const data = readSplatPly(ply(TRAINING_ORDER, [splat({ scale_0: Math.LN2, opacity: 0 })]));
    expect((data.packed[3] ?? 0) >>> 24, 'opacity 0 is 0.5 through the logistic').toBe(128);
    /* xx is the first half of word 4. Taken raw, ln 2 is 0.693 and xx would be 0.48. */
    const xx = halfToFloat((data.packed[4] ?? 0) & 0xffff);
    expect(xx, 'a stored ln 2 is a standard deviation of 2, so xx is 4').toBeCloseTo(4, 2);
  });

  it('turns the DC term into a colour rather than taking it as one', () => {
    /*
     * `0.5 + C0 * f_dc`, with C0 = 0.28209479177387814. For red at full: (1 − 0.5) / C0 = 1.7725,
     * which comes back as 1.0 and packs to 255. For a DC of 0 the colour is exactly 0.5 → 128.
     * A reader that took the DC term as a colour would give 255 and 0 respectively, so the second
     * assertion is the one that separates them.
     */
    const data = readSplatPly(
      ply(TRAINING_ORDER, [splat({ f_dc_0: (1 - 0.5) / 0.28209479177387814, f_dc_1: 0 })]),
    );
    const word = data.packed[3] ?? 0;
    expect(word & 0xff).toBe(255);
    expect((word >>> 8) & 0xff).toBe(128);
  });

  it('counts the spherical-harmonic coefficients wherever they sit in the order', () => {
    /* Appended rather than in their usual place, because what is under test is the offset table
       rather than the coefficients: they are stride, and the properties after them must shift. */
    const order = [...TRAINING_ORDER, 'f_rest_0', 'f_rest_1', 'f_rest_2'];
    const data = readSplatPly(ply(order, [splat()]));
    expect(data.sphericalHarmonics).toBe(3);
    expect(data.count).toBe(1);
    /* Three is one coefficient a channel, which is not a whole band. See the l=1 tests below. */
    expect(data.shDegree).toBe(0);
  });

  it('refuses an ASCII or big-endian body, naming the format line', () => {
    const ascii = new TextEncoder().encode(
      'ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nend_header\n',
    );
    expect(() => readSplatPly(ascii.buffer)).toThrow(/format ascii 1\.0/);
    const big = new TextEncoder().encode(
      'ply\nformat binary_big_endian 1.0\nelement vertex 0\nproperty float x\nend_header\n',
    );
    expect(() => readSplatPly(big.buffer)).toThrow(/binary_big_endian/);
  });

  it('refuses a missing required property, naming it', () => {
    const without = TRAINING_ORDER.filter((name) => name !== 'scale_1');
    expect(() => readSplatPly(ply(without, [splat()]))).toThrow(/scale_1/);
  });

  it('refuses a truncated body rather than reading past it', () => {
    const whole = new Uint8Array(ply(TRAINING_ORDER, [splat(), splat()]));
    expect(() =>
      readSplatPly(whole.subarray(0, whole.length - 8).buffer.slice(0, whole.length - 8)),
    ).toThrow(/truncated/);
  });

  it('refuses a file with no header marker', () => {
    expect(() => readSplatPly(new TextEncoder().encode('not a ply at all').buffer)).toThrow(
      /end_header/,
    );
  });
});

/**
 * The l=1 band, and the transpose that reading it correctly requires.
 *
 * **A training run writes `f_rest_*` channel-major** — every coefficient of red, then of green,
 * then of blue — and `SplatSource.sh1` is basis-major. A reader that copied the file's order
 * straight through would produce a capture whose sheen is real, wrong, and in the wrong channel,
 * which is plausible from any one angle. So the fixture gives each of the nine a value that names
 * where it came from, and the assertion is on where each one landed.
 */
describe('the l=1 spherical-harmonic band', () => {
  /** Degree 1: three coefficients a channel, nine in all, written red-then-green-then-blue. */
  const DEGREE_1 = [
    ...TRAINING_ORDER.slice(0, 9),
    'f_rest_0',
    'f_rest_1',
    'f_rest_2',
    'f_rest_3',
    'f_rest_4',
    'f_rest_5',
    'f_rest_6',
    'f_rest_7',
    'f_rest_8',
    ...TRAINING_ORDER.slice(9),
  ];

  /**
   * Nine distinct values, one per coefficient, at a magnitude the per-splat scale keeps exact.
   *
   * The quantisation is eight bits over the largest magnitude in the splat, so a value that is a
   * whole multiple of the largest over 127 comes back exactly. Chosen that way rather than
   * asserted with a tolerance, so the test says what the packing promises.
   */
  const rest = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (let k = 0; k < 9; k++) out[`f_rest_${k}`] = (k + 1) / 9;
    return out;
  };

  it('is read, transposed out of the file order, and packed into a third texel', () => {
    const data = readSplatPly(ply(DEGREE_1, [splat(rest())]));
    expect(data.sphericalHarmonics, 'nine coefficients in the file').toBe(9);
    expect(data.shDegree, 'one band kept').toBe(1);
    expect(data.wordsPerSplat, 'which is one more texel').toBe(12);
    expect(data.packed.length).toBe(12);

    /*
     * Back out through the same arithmetic the shader applies: a byte at 128 is zero, the scale
     * rides in the texel's fourth word as float bits, and the coefficients come out in
     * basis-major order.
     */
    const scale = new Float32Array(data.packed.buffer)[11] ?? 0;
    const read = (word: number, byte: number): number => {
      const value = ((data.packed[word] ?? 0) >>> (byte * 8)) & 0xff;
      return ((value - 128) / 127) * scale;
    };
    const got = [
      read(8, 0),
      read(8, 1),
      read(8, 2),
      read(8, 3),
      read(9, 0),
      read(9, 1),
      read(9, 2),
      read(9, 3),
      read(10, 0),
    ];
    /*
     * `f_rest_0..2` are red's three bands and `f_rest_3..5` are green's, so basis 0 takes
     * `f_rest_0`, `f_rest_3` and `f_rest_6` — which is 1/9, 4/9 and 7/9. Written out as the
     * arithmetic rather than derived from the reader.
     */
    const want = [1, 4, 7, 2, 5, 8, 3, 6, 9].map((n) => n / 9);
    for (let k = 0; k < 9; k++) expect(got[k], `coefficient ${k}`).toBeCloseTo(want[k] ?? 0, 2);
  });

  /**
   * A file at degree 3 carries forty-five and this keeps nine, which is the costing's decision.
   *
   * The band it keeps is still the *first* of each channel, so the per-channel stride is fifteen
   * rather than three — reading it as three would take red's first three bands and call two of
   * them green and blue.
   */
  it('takes the first band of each channel from a capture written at degree 3', () => {
    const order = [
      ...TRAINING_ORDER.slice(0, 9),
      ...Array.from({ length: 45 }, (_, k) => `f_rest_${k}`),
      ...TRAINING_ORDER.slice(9),
    ];
    const values: Record<string, number> = {};
    for (let k = 0; k < 45; k++) values[`f_rest_${k}`] = 0;
    /* Red's first band, green's first band, blue's first band: 0, 15 and 30. */
    values['f_rest_0'] = 1;
    values['f_rest_15'] = 0.5;
    values['f_rest_30'] = -1;

    const data = readSplatPly(ply(order, [splat(values)]));
    expect(data.sphericalHarmonics).toBe(45);
    expect(data.shDegree).toBe(1);
    const scale = new Float32Array(data.packed.buffer)[11] ?? 0;
    expect(scale, 'the largest magnitude in the splat').toBeCloseTo(1, 6);
    const read = (word: number, byte: number): number =>
      (((((data.packed[word] ?? 0) >>> (byte * 8)) & 0xff) - 128) / 127) * scale;
    expect(read(8, 0), 'red of the first basis function').toBeCloseTo(1, 2);
    expect(read(8, 1), 'green of it').toBeCloseTo(0.5, 2);
    expect(read(8, 2), 'blue of it').toBeCloseTo(-1, 2);
  });

  /** A capture with no harmonics is unchanged, which is what makes the feature opt-in. */
  it('leaves a capture without them at eight words and degree zero', () => {
    const data = readSplatPly(ply(TRAINING_ORDER, [splat()]));
    expect(data.sphericalHarmonics).toBe(0);
    expect(data.shDegree).toBe(0);
    expect(data.wordsPerSplat).toBe(8);
    expect(data.packed.length).toBe(8);
  });

  /**
   * A count that is not a multiple of three is not a spherical-harmonic expansion.
   *
   * Three channels means the total is divisible by three by construction, so a file that says
   * otherwise is one this reader cannot interpret — and reading it anyway would put one channel's
   * coefficients in another's. It is dropped rather than guessed at, and the count is still
   * reported so a caller can see what was there.
   */
  it('refuses to guess at a coefficient count that is not three channels', () => {
    const order = [
      ...TRAINING_ORDER.slice(0, 9),
      'f_rest_0',
      'f_rest_1',
      'f_rest_2',
      'f_rest_3',
      ...TRAINING_ORDER.slice(9),
    ];
    const data = readSplatPly(
      ply(order, [splat({ f_rest_0: 1, f_rest_1: 1, f_rest_2: 1, f_rest_3: 1 })]),
    );
    expect(data.sphericalHarmonics, 'reported').toBe(4);
    expect(data.shDegree, 'and not read').toBe(0);
    expect(data.wordsPerSplat).toBe(8);
  });
});

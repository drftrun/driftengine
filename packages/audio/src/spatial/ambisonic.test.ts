import { expect, test } from 'vitest';
import { type StubNode, stubContext } from '../audioHarness.ts';
import { MixConsole } from '../mix/console.ts';
import {
  ACN_W,
  ACN_X,
  ACN_Y,
  ACN_Z,
  FOA_CHANNELS,
  FOA_SPEAKERS,
  ambisonicFromWorld,
  createAmbisonicSoundfield,
  encodeFoa,
  foaDecodeGain,
  foaDecodeMatrix,
} from './ambisonic.ts';
import { createListener } from './listener.ts';

function build() {
  const context = stubContext();
  const mix = new MixConsole(context as unknown as BaseAudioContext, { scheduleAt: () => 0 });
  const listener = createListener(mix);
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  return { context, mix, listener };
}

/**
 * **The engine is y-up and −z forward; ambisonics is x-forward, y-left, z-up.**
 *
 * Both conventions are standard and they are not the same one, so the conversion is a real decision
 * with a real wrong answer — a field decoded through the wrong handedness plays every direction
 * mirrored, which sounds like a working renderer.
 */
test('the engine frame converts to the ambisonic frame', () => {
  const out = new Float32Array(3);

  ambisonicFromWorld(0, 0, -1, out);
  expect([out[0], out[1], out[2]], 'world forward is ambisonic +x').toEqual([1, -0, 0]);

  ambisonicFromWorld(-1, 0, 0, out);
  expect([out[0], out[1], out[2]], 'world left is ambisonic +y').toEqual([-0, 1, 0]);

  ambisonicFromWorld(0, 1, 0, out);
  expect([out[0], out[1], out[2]], 'world up is ambisonic +z').toEqual([-0, -0, 1]);
});

/*
 * A mono source at a direction encodes to `W = gain` and the three directional components scaled by
 * that direction's ambisonic axes. Hand-derived: straight ahead is ambisonic +x, so `X` carries the
 * whole of it and `Y` and `Z` are zero.
 */
test('a mono signal encodes into W and the axis it arrives along', () => {
  const field = new Float32Array(FOA_CHANNELS);
  encodeFoa(1, 0, 0, -1, field);
  expect(field[ACN_W]).toBeCloseTo(1, 6);
  expect(field[ACN_X]).toBeCloseTo(1, 6);
  expect(field[ACN_Y]).toBeCloseTo(0, 6);
  expect(field[ACN_Z]).toBeCloseTo(0, 6);

  /* World right is ambisonic −y, because ambisonic +y is left. */
  encodeFoa(1, 4, 0, 0, field);
  expect(field[ACN_Y], 'a direction is normalised rather than trusted').toBeCloseTo(-1, 6);
  expect(field[ACN_X]).toBeCloseTo(0, 6);
});

/* No direction at all is a sound with no bearing, which is all `W`. Never a NaN. */
test('a zero direction encodes as omnidirectional', () => {
  const field = new Float32Array(FOA_CHANNELS);
  encodeFoa(0.5, 0, 0, 0, field);
  expect(Array.from(field)).toEqual([0.5, 0, 0, 0]);
});

/**
 * **The decode is a cardioid, and the three values that pin it are hand-derived.**
 *
 * `(W + d · (X, Y, Z)) / speakers`, for a field holding one source straight ahead and six speakers:
 * the speaker facing the source gets `(1 + 1) / 6 = 1/3`, the one behind gets `(1 − 1) / 6 = 0`,
 * and each of the four perpendicular ones gets `(1 + 0) / 6 = 1/6`.
 */
test('a speaker facing the source gets a third, the antipode nothing, the rest a sixth', () => {
  const field = new Float32Array(FOA_CHANNELS);
  encodeFoa(1, 0, 0, -1, field);

  expect(foaDecodeGain(field, 0, 0, 0, -1, 6), 'facing it').toBeCloseTo(1 / 3, 6);
  expect(foaDecodeGain(field, 0, 0, 0, 1, 6), 'behind it').toBeCloseTo(0, 6);
  expect(foaDecodeGain(field, 0, 1, 0, 0, 6), 'to the side').toBeCloseTo(1 / 6, 6);
  expect(foaDecodeGain(field, 0, 0, 1, 0, 6), 'above it').toBeCloseTo(1 / 6, 6);
});

/**
 * **The gains sum to exactly one**, so a field is neither louder nor quieter for having been
 * decoded. That is what the `/ speakers` in the projection decode buys, and it is the number a
 * hand-rolled decoder gets wrong first.
 */
test('the decode gains over the octahedron sum to unity, whatever direction the source is', () => {
  const field = new Float32Array(FOA_CHANNELS);
  for (const direction of [
    [0, 0, -1],
    [1, 0, 0],
    [0.3, -0.9, 0.4],
    [0, 1, 0],
  ] as const) {
    encodeFoa(1, direction[0], direction[1], direction[2], field);
    let total = 0;
    for (const speaker of FOA_SPEAKERS) {
      total += foaDecodeGain(field, 0, speaker[0], speaker[1], speaker[2], FOA_SPEAKERS.length);
    }
    expect(total, `summed for ${direction.join(',')}`).toBeCloseTo(1, 6);
  }
});

/* No speaker may be given a negative gain, which would invert the signal it carries. */
test('no speaker is ever driven negative', () => {
  const field = new Float32Array(FOA_CHANNELS);
  encodeFoa(1, 0, 0, -1, field);
  for (const speaker of FOA_SPEAKERS) {
    expect(
      foaDecodeGain(field, 0, speaker[0], speaker[1], speaker[2], FOA_SPEAKERS.length),
    ).toBeGreaterThanOrEqual(0);
  }
});

/*
 * The matrix is the decode written as coefficients per channel, which is what the graph uploads.
 * It must agree with the function it stands for, or the two drift and only one of them is tested.
 */
test('the matrix agrees with the decode it stands for', () => {
  const matrix = foaDecodeMatrix();
  const field = new Float32Array(FOA_CHANNELS);
  encodeFoa(0.8, 0.2, -0.5, -0.9, field);

  for (let s = 0; s < FOA_SPEAKERS.length; s++) {
    const speaker = FOA_SPEAKERS[s] as readonly [number, number, number];
    let through = 0;
    for (let c = 0; c < FOA_CHANNELS; c++) {
      through += (field[c] as number) * (matrix[s * FOA_CHANNELS + c] as number);
    }
    expect(through).toBeCloseTo(
      foaDecodeGain(field, 0, speaker[0], speaker[1], speaker[2], FOA_SPEAKERS.length),
      6,
    );
  }
});

/*
 * The W coefficient is the same for every speaker and is exactly `1 / speakers`: the omnidirectional
 * part of a field goes to all of them equally, which is what makes an ambience with no direction in
 * it sound like an ambience rather than like a point.
 */
test('the omnidirectional channel is spread evenly', () => {
  const matrix = foaDecodeMatrix();
  for (let s = 0; s < FOA_SPEAKERS.length; s++) {
    expect(matrix[s * FOA_CHANNELS + ACN_W]).toBeCloseTo(1 / FOA_SPEAKERS.length, 6);
  }
});

/**
 * **A file that is not B-format is refused at construction rather than decoded wrongly.**
 *
 * Taking the first four channels of a stereo file produces a plausible result that is silent in two
 * thirds of the field, and nothing anywhere reports it. Init is where the house rule allows a throw.
 */
test('a buffer that is not four channels is refused out loud', () => {
  const { context, listener } = build();
  const stereo = context.createBuffer(2, 128) as unknown as AudioBuffer;
  expect(() => createAmbisonicSoundfield(listener, stereo)).toThrow(/four channels|4 channels/i);
});

/**
 * **The cost is fixed and it is six**, whatever is in the field. That is the whole argument for
 * decoding a soundfield rather than placing its contents as sources.
 */
test('a whole field costs six panners, however much is in it', () => {
  const { context, listener } = build();
  const buffer = context.createBuffer(FOA_CHANNELS, 128) as unknown as AudioBuffer;
  const before = context.panners.length;
  createAmbisonicSoundfield(listener, buffer);
  expect(context.panners.length - before).toBe(FOA_SPEAKERS.length);
});

/**
 * **The channels are discrete, not speakers.**
 *
 * The default interpretation up-mixes or down-mixes four channels into what it thinks they mean,
 * and W, Y, Z, X are not left, right, centre and low frequency. Mixed that way a field comes out as
 * an unrecognisable blur that still plays, which is the failure this one property prevents.
 */
test('the field is read as four discrete channels rather than as a speaker layout', () => {
  const { context, listener } = build();
  const buffer = context.createBuffer(FOA_CHANNELS, 128) as unknown as AudioBuffer;
  createAmbisonicSoundfield(listener, buffer);
  const source = context.sources.at(-1) as unknown as {
    channelInterpretation?: string;
    channelCount?: number;
  };
  expect(source.channelInterpretation).toBe('discrete');
  expect(source.channelCount).toBe(FOA_CHANNELS);
});

/* The rig follows the head, or a listener who walks away leaves the whole field behind them. */
test('the speaker rig moves with the listener', () => {
  const { context, listener } = build();
  const buffer = context.createBuffer(FOA_CHANNELS, 128) as unknown as AudioBuffer;
  const field = createAmbisonicSoundfield(listener, buffer);

  const front = context.panners.at(-FOA_SPEAKERS.length) as unknown as StubNode & {
    positionZ?: { value: number };
  };
  expect(front.positionZ?.value).toBeCloseTo(-1, 6);

  listener.set(0, 0, 10, 0, 0, 1 / 60);
  field.follow();
  expect(front.positionZ?.value).toBeCloseTo(9, 6);
});

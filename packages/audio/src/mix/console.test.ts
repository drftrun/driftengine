import { expect, test } from 'vitest';
import { stubContext, type StubNode } from '../audioHarness.ts';
import { MixConsole } from './console.ts';

const asStub = (node: AudioNode) => node as unknown as StubNode;
/**
 * What a bus's fader is actually at.
 *
 * The last scheduled move, or the value it was born at when nothing has moved it. A bus already at
 * unity that a solo leaves alone records no move at all — `setSoloGate` refuses a redundant write,
 * because sixty of those a second is a ramp storm on the audio thread — so reading only the ramps
 * would report "audible" as `undefined`.
 */
const gainOf = (bus: { input: GainNode }) =>
  asStub(bus.input).gain.ramps.at(-1)?.value ?? asStub(bus.input).gain.value;
const build = () =>
  new MixConsole(stubContext() as unknown as BaseAudioContext, { scheduleAt: () => 0 });

test('solo silences siblings and leaves ancestors and descendants alone', () => {
  /*
   * The rule a person reaching for solo is asking for, and the one model that cannot work: anything
   * that silences a soloed bus's ancestors silences the soloed bus itself, through its own parent.
   */
  const mix = build();
  const music = mix.bus('music');
  const drums = mix.bus('drums', { parent: music });
  const bass = mix.bus('bass', { parent: music });
  const effects = mix.bus('effects');

  drums.setSolo(true);
  expect(gainOf(drums), 'the soloed bus itself').toBeCloseTo(1, 6);
  expect(gainOf(music), 'its ancestor must stay open or it silences itself').toBeCloseTo(1, 6);
  expect(gainOf(bass), 'its sibling').toBe(0);
  expect(gainOf(effects), 'a sibling of its ancestor').toBe(0);

  drums.setSolo(false);
  expect(gainOf(bass), 'released').toBeCloseTo(1, 6);
  expect(gainOf(effects), 'released').toBeCloseTo(1, 6);
});

test('soloing a parent keeps its children audible', () => {
  const mix = build();
  const music = mix.bus('music');
  const drums = mix.bus('drums', { parent: music });
  const effects = mix.bus('effects');
  music.setSolo(true);
  expect(gainOf(drums), 'a descendant of the soloed bus').toBeCloseTo(1, 6);
  expect(gainOf(effects)).toBe(0);
});

test('a bus muted by its own fader stays muted through a solo it is part of', () => {
  /*
   * Mute and solo answer different questions — "I do not want to hear this" and "I want to hear
   * only that" — and a solo that clears somebody's mute has overruled a decision it was never
   * asked about.
   */
  const mix = build();
  const music = mix.bus('music');
  music.setMute(true);
  music.setSolo(true);
  expect(gainOf(music)).toBe(0);
});

test('bus() returns the existing bus rather than building a second with the same name', () => {
  const mix = build();
  expect(mix.bus('music')).toBe(mix.bus('music'));
});

test('a bus created after a solo is already active is silenced by it', () => {
  /*
   * A zone or a one-shot group built while somebody is soloing must not arrive at full level. The
   * gate is a property of the tree, not an event that happened once.
   */
  const mix = build();
  mix.bus('music').setSolo(true);
  const late = mix.bus('late');
  expect(gainOf(late)).toBe(0);
});

import { expect, test } from 'vitest';
import { stubContext } from '../audioHarness.ts';
import { MixConsole } from './console.ts';

const build = () =>
  new MixConsole(stubContext() as unknown as BaseAudioContext, { scheduleAt: () => 0 });

test('a recall restores levels, mutes and sends', () => {
  const mix = build();
  const music = mix.bus('music');
  const reverb = mix.bus('reverb');
  music.setLevel(0.9);
  music.send(reverb, 0.1);
  mix.snapshot('dry');

  music.setLevel(0.2);
  music.setMute(true);
  music.send(reverb, 0.8);

  mix.recall('dry');
  expect(music.level).toBeCloseTo(0.9, 6);
  expect(music.muted).toBe(false);
  expect(music.sendAmount(reverb)).toBeCloseTo(0.1, 6);
});

test('a bus created after the capture is left exactly as it was', () => {
  /*
   * A snapshot is a record of what was, not an assertion about what must be. A reverb zone
   * registered after a mix was captured would otherwise go silent the first time anybody recalled
   * that mix, and nothing in the recall would name the zone as what it had just switched off.
   */
  const mix = build();
  mix.bus('music').setLevel(0.9);
  mix.snapshot('dry');

  const late = mix.bus('late');
  late.setLevel(0.35);
  mix.recall('dry');

  expect(late.level).toBeCloseTo(0.35, 6);
});

test('recalling a name nothing was captured under does nothing at all', () => {
  const mix = build();
  const music = mix.bus('music');
  music.setLevel(0.42);
  mix.recall('never-taken');
  expect(music.level).toBeCloseTo(0.42, 6);
});

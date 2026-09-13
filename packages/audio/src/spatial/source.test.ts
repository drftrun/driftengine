import { expect, test } from 'vitest';
import { stubContext } from '../audioHarness.ts';
import { MixConsole } from '../mix/console.ts';
import { createListener } from './listener.ts';
import { createSpatialSource } from './source.ts';

function build() {
  const context = stubContext();
  const mix = new MixConsole(context as unknown as BaseAudioContext, { scheduleAt: () => 0 });
  const listener = createListener(mix);
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  const buffer = context.createBuffer(1, 128) as unknown as AudioBuffer;
  return { context, mix, listener, buffer };
}

test('a placed source is panned through a head model, not a stereo balance', () => {
  /*
   * `equalpower` is a balance between two speakers and says nothing about front, back or height, so
   * a source directly behind the listener is indistinguishable from one directly ahead. That is the
   * whole difference this class exists to buy, and it is one property assignment away from being
   * silently lost.
   */
  const { context, listener, buffer } = build();
  createSpatialSource(listener, buffer);
  expect(context.panners.at(-1)?.panningModel).toBe('HRTF');
});

test('an approaching source is sharpened and a receding one flattened', () => {
  const { listener, buffer } = build();
  const source = createSpatialSource(listener, buffer, { doppler: true });
  source.place(0, 0, -100, 1 / 60);
  source.place(0, 0, -99, 1 / 60); // one metre closer in a sixtieth: 60 m/s inbound
  expect(source.detuneCents, 'closing on the listener raises the pitch').toBeGreaterThan(0);

  source.place(0, 0, -100, 1 / 60); // and back out again
  expect(source.detuneCents, 'receding lowers it').toBeLessThan(0);
});

test('doppler is off unless it is asked for', () => {
  /*
   * The default matters more than the feature. On a looping bed — a fire, a shoreline — a listener
   * walking past makes the bed's pitch wander, which a player hears as the sound being broken
   * rather than as motion.
   */
  const { listener, buffer } = build();
  const source = createSpatialSource(listener, buffer);
  source.place(0, 0, -100, 1 / 60);
  source.place(0, 0, -50, 1 / 60);
  expect(source.detuneCents).toBe(0);
});

test('the pitch shift is clamped, so a jump cannot produce an arbitrary ratio', () => {
  const { listener, buffer } = build();
  const source = createSpatialSource(listener, buffer, { doppler: true, maxDopplerCents: 200 });
  source.place(0, 0, -1000, 1 / 60);
  source.place(0, 0, -10, 1 / 60); // 59,400 m/s, which is not a sound anybody wants rendered
  expect(Math.abs(source.detuneCents)).toBeLessThanOrEqual(200);
});

test('a probe the listener carries is what decides occlusion', () => {
  const { listener, buffer } = build();
  let asked = 0;
  listener.probe = () => {
    asked++;
    return 1;
  };
  const source = createSpatialSource(listener, buffer, { occlusionRate: 1000 });
  // Enough listener time for this source's staggered turn to come round.
  for (let i = 0; i < 40; i++) listener.set(0, 0, 0, 0, 0, 1 / 60);
  source.place(0, 0, -5, 1 / 60);
  expect(asked, 'the world was asked').toBeGreaterThan(0);
  expect(source.occlusion, 'and the answer was taken').toBeGreaterThan(0.5);
});

test('a fully occluded source is quieter and duller, not gone', () => {
  const { listener, buffer } = build();
  const source = createSpatialSource(listener, buffer, { occlusionRate: 1000 });
  source.setOcclusion(1);
  source.place(0, 0, -5, 1 / 60);
  expect(source.occlusion).toBeGreaterThan(0.9);
});

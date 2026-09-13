import { expect, test } from 'vitest';
import { stubContext, type StubContext } from '../audioHarness.ts';
import { MixConsole } from '../mix/console.ts';
import { createListener } from './listener.ts';

function build(options?: { listenerParams?: boolean }) {
  const context = stubContext(options);
  const mix = new MixConsole(context as unknown as BaseAudioContext, { scheduleAt: () => 0 });
  return { context, listener: createListener(mix) };
}

test('velocity is derived from successive positions', () => {
  const { listener } = build();
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  listener.set(0.5, 0, 0, 0, 0, 1 / 60);
  expect(listener.velocityX, 'half a metre in a sixtieth of a second').toBeCloseTo(30, 4);
});

test('a warp moves the listener and generates no velocity, this frame or the next', () => {
  /*
   * The failure this catches is a doppler shriek on every teleport, respawn and camera cut. Two
   * hundred metres in one frame is twelve kilometres a second derived, and what comes out of the
   * ratio at that speed is whatever the clamp happens to be rather than anything anybody wanted.
   *
   * The frame *after* is the half that is easy to miss: a warp that only zeroed the velocity would
   * have the next `set` measure from the old position and produce the same spike one frame later.
   */
  const { listener } = build();
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  listener.set(1, 0, 0, 0, 0, 1 / 60);
  listener.warp(500, 0, 0);
  expect(listener.x).toBe(500);
  expect(listener.velocityX).toBe(0);
  listener.set(500, 0, 0, 0, 0, 1 / 60);
  expect(listener.velocityX, 'the frame after a warp is still').toBe(0);
});

test('yaw zero faces negative Z, which is what every camera in the engine means by it', () => {
  /*
   * Agreeing with `stereoPan` by construction rather than by coincidence. That function's own
   * comment fixes the convention — yaw 0 faces −Z, so the listener's right is (cos yaw, 0, sin yaw)
   * — and a listener graph that disagreed would put every HRTF source on the wrong side of the head
   * while the cheap stereo path had it right, which is the hardest kind of difference to notice.
   */
  const { context, listener } = build();
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  expect(context.listener.forwardX.value).toBeCloseTo(0, 6);
  expect(context.listener.forwardZ.value).toBeCloseTo(-1, 6);

  listener.set(0, 0, 0, Math.PI / 2, 0, 1 / 60);
  expect(context.listener.forwardX.value, 'a quarter turn puts forward on +X').toBeCloseTo(1, 6);
  expect(context.listener.forwardZ.value).toBeCloseTo(0, 6);
});

test('a browser with only the deprecated setters still gets a listener', () => {
  /*
   * WebKit is the reason this branch exists and this machine cannot verify it, so what is asserted
   * is that the branch is taken at all. The same shape, and the same reason, as `createLoop`
   * falling back when a browser has no stereo panner: direction is a nicety, hearing the sound is
   * not.
   */
  const { context, listener } = build({ listenerParams: false });
  listener.set(3, 0, 0, 0, 0, 1 / 60);
  expect(context.listener.positions.at(-1)).toEqual([3, 0, 0]);
  expect(context.listener.orientations.length, 'and the facing went with it').toBeGreaterThan(0);
});

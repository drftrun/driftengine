import { expect, test } from 'vitest';
import { stubContext } from '../audioHarness.ts';
import { MixConsole } from '../mix/console.ts';
import { createListener } from './listener.ts';
import { addReverbZone } from './zones.ts';

function build() {
  const mix = new MixConsole(stubContext() as unknown as BaseAudioContext, { scheduleAt: () => 0 });
  return { mix, listener: createListener(mix) };
}

const shape = (x: number) => ({ x, y: 0, z: 0, radius: 10, blend: 2 });

test('a zone is full inside its radius, fades across its blend, and is silent beyond', () => {
  /*
   * The hard edge is the failure worth naming: a zone that switched on at its boundary is heard as
   * the room appearing, which is the one thing a reverb must never do. The blend is what a player
   * walks through.
   */
  const { listener } = build();
  const hall = addReverbZone(listener, 'hall', shape(0), { seconds: 4, decay: 2, wet: 0.5 });

  listener.set(0, 0, 0, 0, 0, 1 / 60);
  expect(listener.zoneSend(hall), 'at the centre').toBeCloseTo(0.5, 6);
  listener.set(11, 0, 0, 0, 0, 1 / 60);
  expect(listener.zoneSend(hall), 'half way through the blend').toBeCloseTo(0.25, 6);
  listener.set(20, 0, 0, 0, 0, 1 / 60);
  expect(listener.zoneSend(hall), 'well outside').toBe(0);
});

test('at most two zones sound at once, and they are the two the listener is most inside', () => {
  /*
   * A convolver is the most expensive node in this graph. Two is what a transition needs — the
   * space being left and the space being entered — and a third is inaudible under that crossfade
   * while costing everything a second one costs.
   */
  const { listener } = build();
  const a = addReverbZone(listener, 'a', shape(0), { seconds: 4, decay: 2, wet: 0.9 });
  const b = addReverbZone(listener, 'b', shape(6), { seconds: 1, decay: 3, wet: 0.6 });
  const c = addReverbZone(listener, 'c', shape(12), { seconds: 8, decay: 1.2, wet: 0.3 });

  // Standing inside all three, which overlap.
  listener.set(6, 0, 0, 0, 0, 1 / 60);
  expect(listener.zoneSend(a)).toBeCloseTo(0.9, 6);
  expect(listener.zoneSend(b)).toBeCloseTo(0.6, 6);
  expect(listener.zoneSend(c), 'the third is closed, not merely quiet').toBe(0);
});

test('leaving every zone closes every send rather than leaving the last one open', () => {
  /*
   * The failure this catches is a room that follows you outdoors. Nothing reports it: the send is
   * simply never written again, and the tail stays exactly as loud as it was when you left.
   */
  const { listener } = build();
  const hall = addReverbZone(listener, 'hall', shape(0), { seconds: 4, decay: 2, wet: 0.5 });
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  expect(listener.zoneSend(hall)).toBeGreaterThan(0);
  listener.set(100, 0, 0, 0, 0, 1 / 60);
  expect(listener.zoneSend(hall)).toBe(0);
});

test('a zone is a bus, so it can be soloed and muted like anything else in the mix', () => {
  /*
   * Not a special case in the mixer. This is the payoff for having built a tree rather than a fixed
   * set of sends: a room is a bus, and everything true of a bus is true of a room.
   */
  const { mix, listener } = build();
  const hall = addReverbZone(listener, 'hall', shape(0), { seconds: 4, decay: 2, wet: 0.5 });
  expect(mix.find('hall')).toBe(hall.bus);
  hall.bus.setMute(true);
  expect(hall.bus.muted).toBe(true);
});

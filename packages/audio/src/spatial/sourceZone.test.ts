import { expect, test, vi } from 'vitest';
import { type StubNode, stubContext } from '../audioHarness.ts';
import { MixConsole } from '../mix/console.ts';
import { createListener } from './listener.ts';
import { createSpatialSource } from './source.ts';
import { MAX_OPEN_ZONES, addReverbZone } from './zones.ts';

function build() {
  const context = stubContext();
  const mix = new MixConsole(context as unknown as BaseAudioContext, { scheduleAt: () => 0 });
  const listener = createListener(mix);
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  const buffer = context.createBuffer(1, 128) as unknown as AudioBuffer;
  /* A bus outside the one the zones are fed from, which is what stops a source's own routing and
     the listener's routing both sending the same signal into the same return. */
  const dry = mix.bus('placed');
  return { context, mix, listener, buffer, dry };
}

const shape = (x: number) => ({ x, y: 0, z: 0, radius: 10, blend: 2 });

/**
 * **The capability, stated as the thing the listener model cannot do.**
 *
 * `zones.ts` says it in its own words: a sound inside a cave heard from outside does not carry the
 * cave's tail, because whichever space the *listener* occupies decides the reverb for every source
 * at once. Here the listener never leaves the origin and the source's own position is what decides.
 */
test('a source carries the tail of the space it is in, not the one the listener is in', () => {
  const { listener, buffer, dry } = build();
  const cave = addReverbZone(listener, 'cave', shape(40), { seconds: 4, decay: 2, wet: 0.7 });
  const source = createSpatialSource(listener, buffer, { bus: dry });
  source.attachZone(cave);

  /* Standing at the origin, which is nowhere near the cave: the listener sends nothing. */
  expect(listener.zoneSend(cave)).toBe(0);

  source.place(40, 0, 0, 1 / 60);
  expect(source.zoneSend(cave), 'the source is at the centre of the cave').toBeCloseTo(0.7, 6);

  source.place(0, 0, 0, 1 / 60);
  expect(source.zoneSend(cave), 'and out of it again').toBe(0);
});

/* The same blend the listener model uses, because a hard edge is the room switching on either way. */
test('a source fades into a zone across its blend rather than switching into it', () => {
  const { listener, buffer, dry } = build();
  const hall = addReverbZone(listener, 'hall', shape(0), { seconds: 4, decay: 2, wet: 0.5 });
  const source = createSpatialSource(listener, buffer, { bus: dry });
  source.attachZone(hall);

  source.place(0, 0, 0, 1 / 60);
  expect(source.zoneSend(hall)).toBeCloseTo(0.5, 6);
  source.place(11, 0, 0, 1 / 60);
  expect(source.zoneSend(hall), 'half way through the blend').toBeCloseTo(0.25, 6);
  source.place(20, 0, 0, 1 / 60);
  expect(source.zoneSend(hall)).toBe(0);
});

/**
 * **`MAX_OPEN_ZONES` still binds, and it binds per source.**
 *
 * The budget is not about the sends: it is about how many convolvers are audible at once, and a
 * source that drove four returns would make four of them audible however cheap its own gains are.
 * Two is the space being left and the space being entered, here as there.
 */
test('a source sounds at most two zones, the two it is most inside', () => {
  const { listener, buffer, dry } = build();
  const a = addReverbZone(listener, 'a', shape(0), { seconds: 4, decay: 2, wet: 0.9 });
  const b = addReverbZone(listener, 'b', shape(6), { seconds: 1, decay: 3, wet: 0.6 });
  const c = addReverbZone(listener, 'c', shape(12), { seconds: 8, decay: 1.2, wet: 0.3 });
  const source = createSpatialSource(listener, buffer, { bus: dry });
  source.attachZone(a);
  source.attachZone(b);
  source.attachZone(c);

  source.place(6, 0, 0, 1 / 60);
  expect(source.zoneSend(a)).toBeCloseTo(0.9, 6);
  expect(source.zoneSend(b)).toBeCloseTo(0.6, 6);
  expect(source.zoneSend(c), 'the third is closed however far inside it the source is').toBe(0);
});

/**
 * **A second routing, not a second convolver.** The zone's return already carries one, built at
 * registration; a source-attached zone is a gain from the source into that same return.
 */
test('attaching a zone builds no convolver of its own', () => {
  const { context, listener, buffer, dry } = build();
  const cave = addReverbZone(listener, 'cave', shape(0), { seconds: 4, decay: 2, wet: 0.7 });
  const before = context.convolvers.length;
  const source = createSpatialSource(listener, buffer, { bus: dry });
  source.attachZone(cave);
  source.place(0, 0, 0, 1 / 60);
  expect(context.convolvers.length).toBe(before);
  expect(source.zoneSend(cave)).toBeCloseTo(0.7, 6);
});

/**
 * **The send is taken before the panner and after the occlusion.**
 *
 * A reverb send is taken from the channel on any console, and the return is itself a stereo space:
 * a tail that arrived point-panned would come from the source's direction rather than from the room.
 * Occlusion is *before* it on purpose — a sound behind a wall has a muffled tail too.
 */
test('the send is taken from the occluded signal rather than the panned one', () => {
  const { context, listener, buffer, dry } = build();
  const cave = addReverbZone(listener, 'cave', shape(0), { seconds: 4, decay: 2, wet: 0.7 });
  const source = createSpatialSource(listener, buffer, { bus: dry });
  source.attachZone(cave);

  const panner = context.panners.at(-1) as unknown as StubNode;
  /*
   * The return's input carries two feeds: the listener's send from `effects`, registered first, and
   * this source's, added last. Reading the last one's *own* input is what separates the two shapes
   * — both connect a gain into the return, and only the node one hop upstream of that gain says
   * which signal it carries.
   */
  const feedingTheReturn = (cave.bus.input as unknown as StubNode).inputs;
  expect(feedingTheReturn.length).toBe(2);
  const ours = feedingTheReturn.at(-1);
  expect(ours?.inputs.includes(panner)).toBe(false);
  expect(ours?.inputs.length).toBe(1);
});

/*
 * The scan in `updateZones` is written out at two slots. If the budget ever moves, this is what
 * sends whoever moved it to read that scan rather than leaving it silently capped at the old
 * number.
 */
test('the per-source budget is the same two the listener has', () => {
  expect(MAX_OPEN_ZONES).toBe(2);
});

/**
 * **Both routings into one return double the tail, and it is silent.**
 *
 * The listener's zones send from a whole bus — `effects` by default — so a source sitting on that
 * bus is already reaching the return whenever the listener is in the same space. Its own send is
 * then a second copy. Said at `attachZone`, which is setup rather than a frame.
 */
test('warns when a source would reach its zone twice', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { listener, buffer, mix } = build();
    const cave = addReverbZone(listener, 'cave', shape(0), { seconds: 4, decay: 2, wet: 0.7 });
    /* The default bus, which is exactly the one the zone is fed from. */
    const source = createSpatialSource(listener, buffer);
    source.attachZone(cave);
    expect(warn).toHaveBeenCalledTimes(1);

    /* And a *different* bus that is a descendant of it, which feeds the same tap one level down.
       Two wrong buses is two things to fix; two hundred sources on one wrong bus is still one. */
    const child = mix.bus('inner', { parent: mix.bus('effects') });
    const nested = createSpatialSource(listener, buffer, { bus: child });
    nested.attachZone(cave);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});

/* Disposing a source has to take its sends with it, or a stopped sound keeps driving a return. */
test('disposing a source disconnects its zone sends', () => {
  const { listener, buffer, dry, context } = build();
  const cave = addReverbZone(listener, 'cave', shape(0), { seconds: 4, decay: 2, wet: 0.7 });
  const source = createSpatialSource(listener, buffer, { bus: dry });
  source.attachZone(cave);
  source.place(0, 0, 0, 1 / 60);
  expect(source.zoneSend(cave)).toBeCloseTo(0.7, 6);

  source.dispose();
  expect(source.zoneSend(cave)).toBe(0);
  expect(context.convolvers.length).toBeGreaterThan(0);
});

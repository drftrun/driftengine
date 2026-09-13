import { expect, test } from 'vitest';
import { AmbientLoop } from './ambientLoop.ts';

/**
 * A bed's level changes land on the instant its owner names, not on "now".
 *
 * The whole reason a rendered clip can have continuous sound at all. An
 * `OfflineAudioContext` holds `currentTime` at zero for as long as the caller is
 * describing the timeline — the timeline is not being *played*, it is being
 * written — so a loop that read the context directly would stack every level
 * change in a clip onto instant zero. The audible result is not silence, which is
 * why it would survive a casual listen: the bed plays for the whole file at
 * whatever the *last* frame computed, so a brazier the character sprints past sits
 * at its parting distance from the opening frame, and a tornado is at its closest
 * before it has been approached.
 *
 * `AudioGraph` already had exactly one answer to "when does scheduled work land",
 * with a comment saying it exists so a render can move it. Ambient loops were the
 * one part of the mix not asking it.
 */

interface Move {
  value: number;
  at: number;
}

function param(moves: Move[]): AudioParam {
  return {
    value: 0,
    cancelScheduledValues: () => undefined,
    setTargetAtTime: (value: number, at: number) => {
      moves.push({ value, at });
    },
  } as unknown as AudioParam;
}

test('an ambient bed schedules where its owner says, not at the context clock', () => {
  const gainMoves: Move[] = [];
  const panMoves: Move[] = [];
  const gain = { gain: param(gainMoves) } as unknown as GainNode;
  const panner = { pan: param(panMoves) } as unknown as StereoPannerNode;
  const source = { playbackRate: param([]) } as unknown as AudioBufferSourceNode;

  // The clock a render drives: the frame's own instant, moving forward while the
  // context's own `currentTime` would sit at zero throughout.
  let instant = 0;
  const loop = new AmbientLoop(() => instant, source, gain, panner);

  // Three frames of a fire being approached, each at its own moment in the file.
  const schedule: Move[] = [
    { at: 0, value: 0.1 },
    { at: 0.5, value: 0.5 },
    { at: 1, value: 0.9 },
  ];
  for (const frame of schedule) {
    instant = frame.at;
    loop.setGain(frame.value);
    loop.setPan(frame.value - 0.5);
  }

  expect(
    gainMoves.map((m) => m.at),
    'each level lands on its own frame',
  ).toEqual([0, 0.5, 1]);
  expect(gainMoves.map((m) => m.value)).toEqual([0.1, 0.5, 0.9]);
  expect(
    panMoves.map((m) => m.at),
    'and so does each pan',
  ).toEqual([0, 0.5, 1]);
});

test('a bed that has not moved schedules nothing', () => {
  /*
   * The change gate, which is load-bearing in both directions: live it keeps sixty
   * ramps a second off the audio thread for a value that is standing still, and in
   * a render it keeps a clip's worth of identical events out of the timeline.
   */
  const moves: Move[] = [];
  const gain = { gain: param(moves) } as unknown as GainNode;
  const source = { playbackRate: param([]) } as unknown as AudioBufferSourceNode;
  let instant = 0;
  const loop = new AmbientLoop(() => instant, source, gain, null);

  loop.setGain(0.4);
  for (let frame = 1; frame < 60; frame++) {
    instant = frame / 60;
    loop.setGain(0.4);
  }
  expect(moves.length, 'one move for one level').toBe(1);
});

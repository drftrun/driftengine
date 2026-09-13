import { expect, test } from 'vitest';
import type { ShotParams } from '../render/cinematicCamera.ts';
import { CinematicPlayer } from './player.ts';
import { defineCinematic } from './script.ts';
import type { CinematicScript } from './script.ts';

const STILL: ShotParams = {
  kind: 'lookAt',
  distance: 10,
  height: 4,
  fovDeg: 70,
  anchor: [0, 10, 0],
};

/**
 * Three shots and three lines, with a keyframed move in the middle. Times are
 * round numbers so every expectation below can be derived by hand.
 */
const SCRIPT = defineCinematic('fixture', {
  durationSec: 20,
  shots: [
    { atSec: 0, camera: STILL },
    {
      atSec: 8,
      camera: [
        { atSec: 0, camera: { kind: 'chase', distance: 20, height: 4, fovDeg: 80 } },
        { atSec: 6, camera: { kind: 'chase', distance: 8, height: 10, fovDeg: 50 } },
      ],
    },
    { atSec: 15, camera: { kind: 'orbit', distance: 12, height: 5, fovDeg: 60, orbitRate: 0.4 } },
  ],
  lines: [
    { atSec: 1, holdSec: 3, text: 'first', look: 'story' },
    { atSec: 6, holdSec: 4, text: 'second', look: 'story' },
    { atSec: 12, holdSec: 5, text: 'third', look: 'story' },
  ],
});

/** The script's state at an instant, reached in one step. */
function at(timeSec: number): CinematicPlayer {
  const player = new CinematicPlayer(SCRIPT);
  player.update(timeSec);
  return player;
}

test('a line is shown for exactly its window, and one line at a time', () => {
  /*
   * Two lines overlapping is unreadable, and it is what happens the first time
   * somebody writes a script with a hold longer than the gap to the next line.
   * The player answers with one line or none, and the window is closed at its
   * end so the instant one hands over to the next belongs to exactly one.
   */
  expect(at(0.99).line).toBe(null);
  expect(at(1).line?.text).toBe('first');
  expect(at(3.99).line?.text).toBe('first');
  expect(at(4).line, 'the hold is over at four seconds, not after it').toBe(null);
  expect(at(5.5).line).toBe(null);
  expect(at(6).line?.text).toBe('second');
  expect(at(10).line).toBe(null);
  expect(at(12).line?.text).toBe('third');
  expect(at(17).line).toBe(null);
});

test('skipping jumps to the end without leaving state behind', () => {
  /*
   * Every returning player takes this path. A skip that leaves the camera
   * holding a cinematic shot hands them a run they cannot see.
   */
  const player = new CinematicPlayer(SCRIPT);
  player.update(6.5);
  expect(player.line?.text).toBe('second');
  expect(player.shot).not.toBe(null);

  player.skip();
  expect(player.finished).toBe(true);
  expect(player.line).toBe(null);
  expect(player.shot, 'the camera is handed back, not left in a shot').toBe(null);
  expect(player.shotChanged).toBe(false);

  // And it stays skipped: a finished player is inert, however long it is driven.
  player.update(1 / 60);
  expect(player.timeSec).toBe(SCRIPT.durationSec);
  expect(player.line).toBe(null);
  expect(player.shot).toBe(null);
  expect(player.shotChanged).toBe(false);
});

test('the same script always plays the same, at any frame rate', () => {
  /*
   * The failure this prevents is a playback that advances per frame rather than
   * per second: it then tells a shorter story on a phone than on a desktop, and
   * only one of the two versions was ever written down.
   */
  const played = (dt: number): string[] => {
    const player = new CinematicPlayer(SCRIPT);
    const seen: string[] = [];
    while (!player.finished) {
      player.update(dt);
      const text = player.line?.text ?? '-';
      if (seen[seen.length - 1] !== text) seen.push(text);
    }
    return seen;
  };

  // Hand-derived from the fixture: silence, then each line once, in order.
  expect(played(1 / 60)).toEqual(['-', 'first', '-', 'second', '-', 'third', '-']);
  expect(played(1 / 17), 'a phone dropping frames').toEqual(played(1 / 60));
  expect(played(0.05), 'and an unsteady one').toEqual(played(1 / 60));
});

test('a keyframed shot moves while it holds, without cutting again', () => {
  /*
   * A move inside a shot is not a cut — cutting every frame would snap the rig
   * and defeat its damping. So the placement handed out is a live view that
   * keeps moving after the cut, which is the contract `CinematicCamera` relies
   * on when it holds the object it was cut to.
   */
  const player = new CinematicPlayer(SCRIPT);
  player.update(8);
  expect(player.shotChanged, 'the cut into the move').toBe(true);
  const held = player.shot;
  expect(held?.distance).toBe(20);

  player.update(3);
  expect(player.shotChanged, 'a move is not a second cut').toBe(false);
  // Halfway along a six-second move: lerp(20, 8, 0.5).
  expect(player.shot?.distance).toBeCloseTo(14);
  expect(held?.distance, 'the rig holds a live view').toBeCloseTo(14);

  player.update(3);
  expect(player.shot?.distance, 'past the last key it holds its placement').toBeCloseTo(8);
  expect(player.shot?.fovDeg).toBeCloseTo(50);
});

test('a script with overlapping or out-of-order entries is rejected at load', () => {
  /*
   * A season change is a data change, and data is where the mistakes will be.
   * Failing loudly at load beats a cinematic that silently skips its own fourth
   * line — which nobody notices until a player asks what it said.
   */
  const line = (atSec: number, holdSec: number, text: string) => ({
    atSec,
    holdSec,
    text,
    look: 'story',
  });
  const script = (over: Partial<CinematicScript>): CinematicScript => ({
    durationSec: 10,
    shots: [{ atSec: 0, camera: STILL }],
    lines: [],
    ...over,
  });

  expect(() =>
    defineCinematic('overlap', script({ lines: [line(1, 4, 'a'), line(3, 2, 'b')] })),
  ).toThrow(/still up/);
  expect(() =>
    defineCinematic('backwards', script({ lines: [line(5, 1, 'a'), line(2, 1, 'b')] })),
  ).toThrow(/in the order they play/);
  expect(() => defineCinematic('overrun', script({ lines: [line(9, 4, 'a')] }))).toThrow(
    /after the script ends/,
  );
  expect(
    () =>
      defineCinematic(
        'twoCuts',
        script({
          shots: [
            { atSec: 0, camera: STILL },
            { atSec: 4, camera: STILL },
            { atSec: 4, camera: STILL },
          ],
        }),
      ),
    'a duplicate cut',
  ).toThrow(/in the order they play/);
  expect(
    () =>
      defineCinematic(
        'strayKey',
        script({
          shots: [
            {
              atSec: 0,
              camera: [
                { atSec: 0, camera: STILL },
                { atSec: 30, camera: STILL },
              ],
            },
          ],
        }),
      ),
    'a keyframe past the end of its own shot',
  ).toThrow(/would never play/);

  // The player refuses the same script rather than playing it half-right.
  expect(() => new CinematicPlayer(script({ lines: [line(1, 4, 'a'), line(3, 2, 'b')] }))).toThrow(
    /cinematic/,
  );
});

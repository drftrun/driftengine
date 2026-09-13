import { afterEach, expect, test, vi } from 'vitest';
import { holdFrames } from './bootGate.ts';
import { startLoop } from './loop.ts';

/**
 * Drives requestAnimationFrame by hand, so the loop is fully deterministic and
 * a "sixty second pause" costs the test nothing.
 */
function harness(): { frame(nowMs: number): void } {
  const pending: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.push(cb);
    return pending.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('performance', { now: () => 0 });
  return {
    frame(nowMs: number) {
      const next = pending.shift();
      if (next === undefined) throw new Error('no frame was scheduled');
      next(nowMs);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a pause banks no simulation time, so the run clock cannot jump', () => {
  const h = harness();
  let ticks = 0;
  let paused = false;

  const stop = startLoop({
    simulate: () => {
      ticks++;
    },
    render: () => {},
    shouldSimulate: () => !paused,
  });

  h.frame(1000);
  const beforePause = ticks;
  expect(beforePause).toBeGreaterThan(0);

  // A menu left open, or a backgrounded tab.
  paused = true;
  h.frame(61_000);
  expect(ticks, 'nothing simulates while paused').toBe(beforePause);

  /*
   * Resuming must not replay the pause. Banked time would arrive as a burst of
   * ticks in one frame, and every one of them lands in a run timer that M4
   * turns into a leaderboard entry — a player could pause on the start pad and
   * hand themselves a minute.
   */
  paused = false;
  h.frame(61_020);
  expect(ticks - beforePause).toBeLessThan(5);

  stop();
});

test('a drawn frame is told the real gap as well as the clamped one', () => {
  /*
   * `maxFrameTime` exists to stop a simulation spiral and it must keep doing that.
   * What it must not do is decide what everybody downstream is allowed to *know*.
   *
   * Report `HBZ479` is what that cost: three automatic bug reports whose headline
   * frame time was exactly 250.00 ms, which is this constant rather than a
   * measurement of anything. The real gap was closer to a second — a browser
   * calling an untouched window once a second — and no field in the bundle could
   * say so, because the clamp had already been applied by the time the game saw it.
   */
  const h = harness();
  const clamped: number[] = [];
  const wall: number[] = [];

  const stop = startLoop(
    {
      simulate: () => {},
      render: (_alpha, frameDt, wallDt) => {
        clamped.push(frameDt);
        wall.push(wallDt);
      },
      shouldSimulate: () => false,
    },
    { maxFrameTime: 0.25 },
  );

  // One callback, a full second after the last one.
  h.frame(1000);

  expect(clamped[0] ?? 0, 'the simulation still sees the clamp').toBeCloseTo(0.25, 6);
  expect(wall[0] ?? 0, 'and a diagnostic can still see the truth').toBeCloseTo(1, 6);

  stop();
});

test('a skipped frame banks its real time as well as its clamped time', () => {
  /*
   * The same rule as the test below, on the other number. If the bank were kept
   * only for the clamped value, the wall delta would be the gap since the last
   * *offered* frame rather than the last one drawn, and the two would disagree by
   * exactly the frames the clip export refused.
   */
  const h = harness();
  const wall: number[] = [];
  let draw = true;

  const stop = startLoop(
    {
      simulate: () => {},
      render: (_alpha, _frameDt, wallDt) => {
        wall.push(wallDt);
      },
      shouldSimulate: () => false,
      shouldRender: () => draw,
    },
    { maxFrameTime: 0.25 },
  );

  h.frame(1000);
  draw = false;
  h.frame(2000);
  h.frame(3000);
  draw = true;
  h.frame(4000);

  expect(wall.length).toBe(2);
  expect(wall[1] ?? 0, 'three seconds passed before this frame was drawn').toBeCloseTo(3, 6);

  stop();
});

test('a skipped frame hands its time to the next one that is drawn', () => {
  /*
   * The clip export draws only the frames the recorder will actually take: a
   * 144 Hz display offers 2.4 animation frames per 60 fps clip frame, and
   * rendering the other 1.4 at 1080x1920 only competes with the one that is kept.
   *
   * The banked time is the part worth guarding. Everything downstream damps
   * against `frameDt` — cameras, the plume, the sky — so handing a drawn frame
   * 6.9 ms when 20.8 ms of the world has passed makes every one of those
   * quantities run at a third of its rate, which looks exactly like the judder
   * the skipping is meant to remove.
   */
  const h = harness();
  const drawn: number[] = [];
  let draw = true;

  const stop = startLoop({
    simulate: () => {},
    render: (_alpha, frameDt) => {
      drawn.push(frameDt);
    },
    shouldSimulate: () => false,
    shouldRender: () => draw,
  });

  h.frame(10);
  expect(drawn.length).toBe(1);

  // Two frames offered and refused, then one drawn.
  draw = false;
  h.frame(20);
  h.frame(30);
  expect(drawn.length, 'a refused frame drew anyway').toBe(1);

  draw = true;
  h.frame(40);
  expect(drawn.length).toBe(2);
  expect(drawn[1] ?? 0, 'the drawn frame was told only its own 10 ms').toBeCloseTo(0.03, 6);

  // And the bank is emptied, not carried.
  h.frame(50);
  expect(drawn[2] ?? 0).toBeCloseTo(0.01, 6);

  stop();
});

test('render keeps running while paused, so the world stays on screen', () => {
  const h = harness();
  let renders = 0;

  const stop = startLoop({
    simulate: () => {},
    render: () => {
      renders++;
    },
    shouldSimulate: () => false,
  });

  h.frame(16);
  h.frame(32);
  expect(renders).toBe(2);

  stop();
});

test('a held boot draws and simulates nothing, and does not bank the wait', () => {
  const h = harness();
  let renders = 0;
  let ticks = 0;
  let held = true;
  const open = holdFrames(() => held);

  const stop = startLoop({
    simulate: () => {
      ticks++;
    },
    render: () => {
      renders++;
    },
  });

  /*
   * Three seconds of badge. Nothing advances and nothing draws: the screen keeps the frame the
   * game had already presented, which is the point — a game left running behind an opaque plate
   * plays its opening to nobody.
   */
  h.frame(1000);
  h.frame(2000);
  h.frame(3000);
  expect(renders, 'a held frame draws nothing').toBe(0);
  expect(ticks, 'a held frame simulates nothing').toBe(0);

  /*
   * And the hold is not banked. Without `last` moving with the clock the resume frame would carry
   * three seconds into the accumulator and replay the whole wait in one step — 180 ticks of a
   * game the player has not started, which is the failure the pause path drops its accumulator
   * for, arrived at from the other side.
   */
  held = false;
  open();
  h.frame(3020);
  expect(renders).toBe(1);
  /* One 16.67 ms step out of the 20 ms since the last held frame, and not the 180 that three
     banked seconds would have produced. */
  expect(ticks, 'the resume frame advances one step, not three seconds of them').toBe(1);

  stop();
});

test('a boot with nothing holding it runs from the first frame', () => {
  const h = harness();
  let renders = 0;

  const stop = startLoop({
    simulate: () => {},
    render: () => {
      renders++;
    },
  });

  h.frame(16);
  expect(renders, 'the gate is open when no badge registered one').toBe(1);

  stop();
});

/**
 * The tick counts fixed steps, and it is handed to the thing that takes them.
 *
 * Before this the loop knew the count and kept it, so a caller who needed one — a recording, a
 * replay, anything networked — kept a second counter beside `simulate` and trusted the two to stay
 * in step. Two counters for one quantity is a bug waiting for a frame where only one of them is
 * incremented.
 */
test('simulate is told which tick it is advancing', () => {
  const h = harness();
  const seen: number[] = [];

  const stop = startLoop({
    simulate: (_dt, tick) => {
      seen.push(tick);
    },
    render: () => {},
  });

  h.frame(0);
  h.frame(100);

  stop();
  expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
});

test('startTick is where the count begins, for a participant joining one in progress', () => {
  const h = harness();
  const seen: number[] = [];

  const stop = startLoop(
    {
      simulate: (_dt, tick) => {
        seen.push(tick);
      },
      render: () => {},
    },
    { startTick: 9431 },
  );

  h.frame(0);
  h.frame(50);

  stop();
  expect(seen).toEqual([9431, 9432, 9433]);
});

/**
 * A pause holds the tick, because a tick is a unit of simulation and not of time passing.
 *
 * The pause already drops its banked time so a resume cannot replay the whole hold in one step;
 * this is the same property read from the other side. A tick that advanced while paused would make
 * the number useless as an index into a recording — two runs pausing for different lengths would
 * disagree about which tick a given input belonged to.
 */
test('a pause advances no tick', () => {
  const h = harness();
  const seen: number[] = [];
  let paused = false;

  const stop = startLoop({
    simulate: (_dt, tick) => {
      seen.push(tick);
    },
    render: () => {},
    shouldSimulate: () => !paused,
  });

  h.frame(0);
  h.frame(50);
  paused = true;
  h.frame(5_000);
  h.frame(10_000);
  paused = false;
  h.frame(10_050);

  stop();

  /* Contiguous from zero is the assertion, not a total: ten seconds of pause at 60 Hz would have
     banked about six hundred ticks, and the tick after the hold is the tick before it plus one. */
  expect(seen).toEqual(seen.map((_, i) => i));
  expect(seen.length).toBeLessThan(10);
});

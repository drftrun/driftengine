import { expect, test } from 'vitest';
import { FramePacer } from './framePacer.ts';

/** A deterministic jitter source. Test *input* only — never an expectation. */
function jitter(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test('a 60 Hz render loop captures every other frame, exactly', () => {
  /*
   * The case the whole exporter runs in, and the one an exact schedule gets wrong.
   * A display asked for half its rate wants a stride of exactly 2, and the ratio it
   * is derived from is exactly 2 only in arithmetic: a real interval measures
   * 16.6668 ms, the ratio comes out at 1.99998, and a bare `floor` answers 1 — a
   * clip at 60 fps where 30 was asked for, every time.
   *
   * So the frame time here is deliberately *not* 1000/60. It is a hair long, which
   * is what a measurement of a 60 Hz panel looks like.
   */
  const pacer = new FramePacer(30);
  let captured = 0;
  for (let frame = 0; frame < 600; frame++) {
    if (pacer.offer(frame * 16.6668)) captured++;
  }

  // Every other one of 600 frames, and the first frame is always captured: 300.
  expect(captured).toBe(300);
  expect(pacer.report.stride).toBe(2);
  expect(pacer.report.meanGapMs).toBeCloseTo(2 * 16.6668, 6);
  expect(pacer.report.slipped).toBe(0);
});

test('the schedule is settled before the frames start counting', () => {
  /*
   * A stride cannot be chosen before an interval has been measured, and an interval
   * is only known once frames have gone by — so the first few are exposed. What must
   * not happen is a *burst*: capturing everything until the schedule arrives puts
   * sixteen frames at one rate and the rest at another, right at the head of the clip
   * where a viewer is most likely to notice.
   *
   * So the estimate before the window fills is the shortest frame seen, which reads
   * the loop as fast and therefore captures conservatively. With 24% frame-time
   * jitter and a stride of 2 wanted, the alternative — the newest frame — reads long
   * on nearly half of them and captures twice as often while it does.
   */
  const random = jitter(4242);
  const pacer = new FramePacer(30);
  let now = 0;
  let captured = 0;
  for (let frame = 0; frame < 600; frame++) {
    now += 16.667 + (random() - 0.5) * 8;
    if (pacer.offer(now)) captured++;
  }

  // Every other frame of 600 is 300. Two spare for the frames before the first
  // median, and not one more: a head burst would show up here as a dozen.
  expect(captured).toBeLessThanOrEqual(302);
  expect(captured).toBeGreaterThanOrEqual(298);
});

test('each display rate gets the rate it divides to, and holds it', () => {
  /*
   * The contract, across every panel anybody has. A capture happens every n-th
   * animation frame, so the rate is the display's own divided by a whole number, and
   * the whole number is the largest that keeps the rate at or above what was asked
   * for. Hand-derived from `16.667 / vsync`, floored:
   *
   * | display | ratio | stride | clip |
   * |---------|-------|--------|------|
   * |  60 Hz  | 1.00  |   1    |  60  |
   * |  75 Hz  | 1.25  |   1    |  75  |
   * | 100 Hz  | 1.67  |   1    | 100  |
   * | 120 Hz  | 2.00  |   2    |  60  |
   * | 144 Hz  | 2.40  |   2    |  72  |
   * | 165 Hz  | 2.75  |   2    | 82.5 |
   * | 240 Hz  | 4.00  |   4    |  60  |
   *
   * Some come out above 60, which is the right direction: more frames than asked for,
   * evenly spaced. None comes out below.
   *
   * Run across sixty seeds and with 5% frame-time jitter, which is what a real loop
   * measures — a 120 Hz panel sampled in Chrome gave a shortest frame of 7.8 ms
   * against a median of 8.3. The seeds are the point: a schedule that is right on
   * average and wrong one run in ten is a clip that is wrong one run in ten.
   */
  const DISPLAYS = [
    { hz: 60, target: 30, clip: 30 },
    { hz: 60, target: 60, clip: 60 },
    { hz: 75, target: 60, clip: 75 },
    { hz: 100, target: 60, clip: 100 },
    { hz: 120, target: 60, clip: 60 },
    { hz: 144, target: 60, clip: 72 },
    { hz: 165, target: 60, clip: 82.5 },
    { hz: 240, target: 60, clip: 60 },
  ] as const;

  for (const { hz, target, clip } of DISPLAYS) {
    for (let seed = 1; seed <= 60; seed++) {
      const random = jitter(seed * 7919);
      const pacer = new FramePacer(target);
      let now = 0;
      for (let frame = 0; frame < 600; frame++) {
        now += (1000 / hz) * (1 + (random() - 0.5) * 0.05);
        pacer.offer(now);
      }
      const measured = pacer.report.capturedFps;
      expect(measured, `${hz} Hz asked for ${target}, seed ${seed}`).toBeGreaterThan(clip * 0.98);
      expect(measured, `${hz} Hz asked for ${target}, seed ${seed}`).toBeLessThan(clip * 1.03);
    }
  }
});

test('the schedule is chosen once and not renegotiated every quarter second', () => {
  /*
   * A stride is a discrete choice made from a measurement, so a ratio sitting near a
   * boundary flips it on noise — and a flip between 2 and 3 changes the clip's frame
   * rate mid-clip. 165 Hz is the case that shows it: 16.667 / 6.06 is 2.75, which is
   * not near a boundary at all until a jittery window reads the period 10% short and
   * makes it 3.03.
   *
   * So the schedule is kept unless the measurement moves clearly past its boundary.
   * Measured across 480 runs at ±10% frame-time jitter — twice what a real loop shows,
   * to put the property under load: **60 runs contained a mid-clip stride change and
   * the worst held 37 of them, against 1 run with 1 change** once the schedule
   * defended itself.
   */
  const DISPLAYS = [
    [60, 30],
    [75, 60],
    [100, 60],
    [120, 60],
    [144, 60],
    [165, 60],
    [240, 60],
  ] as const;

  let runsThatChanged = 0;
  for (const [hz, target] of DISPLAYS) {
    for (let seed = 1; seed <= 60; seed++) {
      const random = jitter(seed * 7919);
      const pacer = new FramePacer(target);
      let now = 0;
      let previous = 0;
      let changes = 0;
      for (let frame = 0; frame < 900; frame++) {
        now += (1000 / hz) * (1 + (random() - 0.5) * 0.2);
        pacer.offer(now);
        const stride = pacer.report.stride;
        // Past the first twenty frames the schedule has had its window and settled.
        if (frame > 20 && stride !== previous) changes++;
        previous = stride;
      }
      if (changes > 0) runsThatChanged++;
    }
  }
  // A handful out of 480 is the estimator genuinely changing its mind; a tenth of
  // them is a schedule with no opinion.
  expect(runsThatChanged, 'runs whose frame rate changed mid-clip, of 480').toBeLessThan(5);
});

test('two offers at the same instant capture once', () => {
  // The duplicate-frame rule, stated as bluntly as it can be. A frame that is
  // recorded twice freezes an instant and then steps twice as far, which reads
  // as a hitch even though nothing was dropped.
  const pacer = new FramePacer(30);
  expect(pacer.offer(0)).toBe(true);
  expect(pacer.offer(0)).toBe(false);
  expect(pacer.offer(1000 / 30)).toBe(true);
  expect(pacer.offer(1000 / 30)).toBe(false);
});

test('jittery frames still come out evenly spaced, and never twice for one frame', () => {
  /*
   * A real render loop does not tick at 16.667 ms. This feeds ±4 ms of jitter
   * plus a 120 ms hitch every second — a spike well past two capture intervals,
   * which is what a shadow rebuild or a GC pause looks like.
   *
   * The two properties that matter are opposite failures. Two captures for one
   * animation frame is a duplicated frame — a frozen instant and then a double
   * step; gaps that grow without bound mean the pacer gave up and the clip dropped
   * to half rate.
   *
   * **There used to be a minimum-gap rule** — no capture sooner than 0.6 of an
   * interval after the last — on the reasoning that a burst after a hitch converts a
   * dropped frame into a lurch. Counting animation frames makes it unnecessary: two
   * captures are never closer than one animation frame, by construction. It also cost
   * real rate on any display whose refresh is not a multiple of the capture rate — a
   * 100 Hz panel recorded 50 frames a second into a 60 fps file — which is a worse
   * artefact than the one the rule was guarding.
   */
  const random = jitter(20260802);
  const pacer = new FramePacer(30);
  const interval = 1000 / 30;
  // The shortest an animation frame can be here: 16.667 ms less the jitter.
  const shortestFrame = 16.667 - 4;

  let now = 0;
  const gaps: number[] = [];
  let lastCapture: number | null = null;
  for (let frame = 0; frame < 600; frame++) {
    now += 16.667 + (random() - 0.5) * 8;
    if (frame % 60 === 30) now += 120;
    if (!pacer.offer(now)) continue;
    if (lastCapture !== null) gaps.push(now - lastCapture);
    lastCapture = now;
  }

  const duplicates = gaps.filter((gap) => gap < shortestFrame);
  expect(
    duplicates,
    `a capture may be one animation frame after the last, never less: ${duplicates.join()}`,
  ).toEqual([]);

  /*
   * Ten hitches of 120 ms each is 1.2 s of an 11.2 s run during which no frame
   * is produced at all, so there is nothing to capture in it: ~10 s of usable
   * time at 30 fps over 11.2 s of clip is a little under 27. Asserting 30 here
   * would be asserting that the pacer invented frames.
   */
  const report = pacer.report;
  expect(report.capturedFps).toBeGreaterThan(26);
  expect(report.capturedFps).toBeLessThanOrEqual(30.01);
  // Every hitch has to show up as a slipped frame rather than be smoothed away:
  // the number is the evidence that a clip juddered, and hiding it would leave
  // the export claiming a clean 30.
  expect(report.slipped).toBeGreaterThanOrEqual(10);
  expect(report.worstGapMs).toBeGreaterThan(120);
});

test('one impossibly short frame does not set the schedule for the whole clip', () => {
  /*
   * The schedule counts animation frames, so it needs to know what one costs, and
   * the honest estimator for a display's period is the shortest frame observed —
   * a frame that overruns pushes the next to the following vsync and drags any
   * average up with it.
   *
   * A running minimum can only fall, though, so a single anomaly owns it forever:
   * two callbacks in one frame, a clock that jumped, a tab waking up. At 1 ms
   * against a 60 fps target that is a stride of 16 and a clip holding four frames
   * a second. Asserted from the other side — the rate — because that is the thing
   * that would be wrong.
   */
  const pacer = new FramePacer(60);
  let captured = 0;
  let now = 0;
  for (let frame = 0; frame < 300; frame++) {
    // 120 Hz, with one pathological 0.4 ms gap a quarter of the way in.
    now += frame === 75 ? 0.4 : 1000 / 120;
    if (pacer.due(now) && pacer.offer(now)) captured++;
  }

  // 300 frames at 120 Hz is 2.5 s; every second frame captured is 60 fps.
  expect(pacer.report.stride).toBe(2);
  expect(captured).toBeGreaterThan(140);
  expect(pacer.report.capturedFps).toBeGreaterThan(59);
  expect(pacer.report.capturedFps).toBeLessThan(61);
});

test('a render loop that cannot hold the capture rate reports what it managed', () => {
  /*
   * 20 fps of render against a 30 fps target. There is no schedule that fixes
   * this — the frames do not exist — and the only wrong answer is a report that
   * claims 30. The export tells the player the clip will judder on the strength
   * of this number, so it has to be the measured one.
   */
  const pacer = new FramePacer(30);
  for (let frame = 0; frame < 100; frame++) pacer.offer(frame * 50);

  const report = pacer.report;
  expect(report.captured).toBe(100);
  expect(report.capturedFps).toBeCloseTo(20, 1);
  expect(report.rendered).toBe(100);
});

import { describe, expect, it } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';

import {
  FLICKER_BLEND,
  JITTER_PERIOD,
  TEMPORAL_HISTORY_BLEND,
  TemporalHistory,
  clipToNeighbourhood,
  flickerBlend,
  flickerRule,
  flickerWidening,
  freshFlicker,
  jitterOffset,
  jitterProjection,
  missedBy,
  nextDepthSwing,
  nextFlicker,
  sameSurface,
  stillness,
} from './temporalAa.ts';
import type { Flicker, FlickerRule } from './temporalAa.ts';

/**
 * A perspective projection to jitter, at a shape a camera actually takes.
 *
 * The assertions below are about *screen* movement, so they are read through this matrix rather
 * than off the matrix's own entries — a jitter that edited the right entry to the wrong sign would
 * pass an entry check and put the sample on the other side of the pixel.
 */
function projection(): mat4 {
  return mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 1000);
}

/** Where a view-space point lands, in pixels, after the perspective divide. */
function screenOf(m: mat4, point: vec4, width: number, height: number): [number, number] {
  const clip = vec4.transformMat4(vec4.create(), point, m);
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  return [((ndcX + 1) / 2) * width, ((ndcY + 1) / 2) * height];
}

describe('the jitter sequence', () => {
  it('never leaves the pixel it is sampling', () => {
    for (let i = 0; i < JITTER_PERIOD * 3; i++) {
      const [x, y] = jitterOffset(i);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
    }
  });

  /*
   * **The image must not drift.** Accumulating over offsets whose mean is not the pixel centre
   * resolves to a picture displaced from the one every other pass drew, and it would show up as
   * the whole frame sitting a fraction of a pixel off from the depth it is tested against.
   */
  it('averages to the centre of the pixel over its period', () => {
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < JITTER_PERIOD; i++) {
      const [x, y] = jitterOffset(i);
      sumX += x;
      sumY += y;
    }
    expect(Math.abs(sumX / JITTER_PERIOD)).toBeLessThan(0.02);
    expect(Math.abs(sumY / JITTER_PERIOD)).toBeLessThan(0.02);
  });

  /*
   * **Distinct samples are the whole mechanism.** A sequence that revisits the same two positions
   * accumulates two samples however long it runs, and the edge keeps its stair.
   */
  it('visits a distinct position every frame of its period', () => {
    const seen = new Set<string>();
    for (let i = 0; i < JITTER_PERIOD; i++) {
      const [x, y] = jitterOffset(i);
      seen.add(`${x.toFixed(6)},${y.toFixed(6)}`);
    }
    expect(seen.size).toBe(JITTER_PERIOD);
  });

  it('repeats once its period is up, so the accumulation is bounded', () => {
    expect(jitterOffset(JITTER_PERIOD)).toEqual(jitterOffset(0));
    expect(jitterOffset(JITTER_PERIOD + 5)).toEqual(jitterOffset(5));
  });
});

describe('jittering the projection', () => {
  /*
   * **Off has to cost exactly nothing.** Every published scene is captured with this off, and a
   * jitter of zero that still rewrites the matrix would move pixels by whatever the arithmetic
   * rounded to.
   */
  it('leaves the matrix bit-identical at a zero offset', () => {
    const source = projection();
    const out = jitterProjection(mat4.create(), source, 0, 0, 1280, 720);
    expect(Array.from(out)).toEqual(Array.from(source));
  });

  it('moves the picture by the pixels it was asked for', () => {
    const source = projection();
    const point = vec4.fromValues(1.3, -0.7, -12, 1);
    const before = screenOf(source, point, 1280, 720);

    const out = jitterProjection(mat4.create(), source, 0.25, -0.375, 1280, 720);
    const after = screenOf(out, point, 1280, 720);

    expect(after[0] - before[0]).toBeCloseTo(0.25, 5);
    expect(after[1] - before[1]).toBeCloseTo(-0.375, 5);
  });

  /*
   * **The shift is a screen offset and not a skew**, which is what separates editing the third
   * column from editing the fourth: the fourth translates before the perspective divide, so a near
   * point and a far one would move by different amounts and the scene would shear with depth.
   */
  it('moves a near point and a far one by the same pixels', () => {
    const source = projection();
    const near = vec4.fromValues(0.2, 0.1, -0.5, 1);
    const far = vec4.fromValues(0.2, 0.1, -800, 1);
    const out = jitterProjection(mat4.create(), source, 0.4, 0.3, 1280, 720);

    const nearMoved = screenOf(out, near, 1280, 720)[0] - screenOf(source, near, 1280, 720)[0];
    const farMoved = screenOf(out, far, 1280, 720)[0] - screenOf(source, far, 1280, 720)[0];

    /*
     * **The two moving together is the assertion**, and it is made on their difference rather than
     * on each against 0.4: `mat4` is a `Float32Array`, so a point half a metre from a near plane of
     * 0.1 reads back about 1e-5 of a pixel from the exact answer. That is the format's floor and
     * not the jitter's error — a shear would put these two hundredths of a pixel apart, four
     * orders of magnitude above it.
     */
    expect(Math.abs(nearMoved - farMoved)).toBeLessThan(1e-4);
    expect(nearMoved).toBeCloseTo(0.4, 4);
    expect(farMoved).toBeCloseTo(0.4, 4);
  });

  /*
   * **A combined view-projection is what this is actually handed.** `viewProjFor` is the one funnel
   * every geometry upload goes through in the WebGL2 backend, and it carries projection times view.
   * The usual jitter — adding the offset to the projection's third column — multiplies *world* z
   * there instead of view z, so the shift would swim with the scene's own depth and a wall at the
   * origin would jitter differently from one fifty metres out. This is the case that decided the
   * implementation.
   */
  it('shifts a combined view-projection by the same pixels wherever the point is', () => {
    const view = mat4.lookAt(mat4.create(), [3, 2, 9], [0, 0, 0], [0, 1, 0]);
    const viewProj = mat4.multiply(mat4.create(), projection(), view);
    const out = jitterProjection(mat4.create(), viewProj, -0.3, 0.2, 1280, 720);

    /* Two world points at very different depths, both comfortably inside the frustum. */
    for (const point of [vec4.fromValues(0, 0, 0, 1), vec4.fromValues(-4, 1, -50, 1)] as const) {
      const before = screenOf(viewProj, point, 1280, 720);
      const after = screenOf(out, point, 1280, 720);
      expect(after[0] - before[0]).toBeCloseTo(-0.3, 3);
      expect(after[1] - before[1]).toBeCloseTo(0.2, 3);
    }
  });

  /*
   * **Orthographic has a w of one**, so the third-column trick has nothing to cancel against and
   * becomes a shear with depth. Nothing jitters an ortho camera today; this is here because the
   * helper is general and the failure would be silent.
   */
  it('shifts an orthographic projection by the same pixels at any depth', () => {
    const ortho = mat4.ortho(mat4.create(), -8, 8, -4.5, 4.5, 0.1, 100);
    const out = jitterProjection(mat4.create(), ortho, 0.5, -0.25, 1280, 720);

    for (const point of [vec4.fromValues(1, 1, -1, 1), vec4.fromValues(1, 1, -80, 1)] as const) {
      const before = screenOf(ortho, point, 1280, 720);
      const after = screenOf(out, point, 1280, 720);
      expect(after[0] - before[0]).toBeCloseTo(0.5, 4);
      expect(after[1] - before[1]).toBeCloseTo(-0.25, 4);
    }
  });
});

/**
 * Two calls a frame, and the split is the point: `openFrame` answers whether this resolve may
 * sample what the last one left, and `accumulated` says a picture now exists to sample next time.
 * One call cannot do both — the answer is needed *before* the write and describes the state
 * before it.
 */
describe('the history', () => {
  /*
   * **There is nothing to blend towards on the first frame**, and a resolve that blended anyway
   * would mix the frame with whatever the texture happened to hold.
   */
  it('has nothing to sample on its first frame', () => {
    const history = new TemporalHistory();
    history.nextFrame();
    expect(history.openFrame(1280, 720)).toBe(false);
  });

  it('has something to sample once a frame has been accumulated', () => {
    const history = new TemporalHistory();
    history.nextFrame();
    history.openFrame(1280, 720);
    history.accumulated();
    history.nextFrame();
    expect(history.openFrame(1280, 720)).toBe(true);
  });

  /*
   * **A resized target is a rebuilt texture**, so what it held is gone whatever the resolve would
   * like to believe.
   */
  it('has nothing to sample when the target is resized', () => {
    const history = new TemporalHistory();
    history.nextFrame();
    history.openFrame(1280, 720);
    history.accumulated();
    history.nextFrame();
    expect(history.openFrame(1920, 1080)).toBe(false);
  });

  it('recovers on the frame after a resize', () => {
    const history = new TemporalHistory();
    history.nextFrame();
    history.openFrame(1280, 720);
    history.accumulated();
    history.nextFrame();
    history.openFrame(1920, 1080);
    history.accumulated();
    history.nextFrame();
    expect(history.openFrame(1920, 1080)).toBe(true);
  });

  /*
   * **A cut is a new scene.** Reprojecting across one finds the old picture everywhere the new
   * camera happens to point, and it smears for as many frames as the blend takes to forget.
   */
  it('has nothing to sample after the camera cuts', () => {
    const history = new TemporalHistory();
    history.nextFrame();
    history.openFrame(1280, 720);
    history.accumulated();
    history.invalidate();
    history.nextFrame();
    expect(history.openFrame(1280, 720)).toBe(false);
  });

  /*
   * **The jitter advances every frame, accumulated or not.** Tying it to the accumulation would
   * hold the sequence still on the frames a resize or a cut discarded, and the same offset twice
   * in a row is one sample rather than two.
   */
  /*
   * **A frame is opened once, however many times it asks.** A renderer opens one where the scene's
   * camera arrives, and a frame binds that camera again after a scene capture, after an inset, after
   * anything that bound another: each opened a frame of its own, so the sequence stepped twice a
   * frame and the world saw every other position. `nextFrame` is the renderer saying a frame began.
   */
  it('OPENS ONE FRAME OF THE SEQUENCE A FRAME, HOWEVER MANY TIMES IT ASKS', () => {
    const history = new TemporalHistory();
    history.nextFrame();
    history.openFrame(1280, 720);
    history.accumulated();
    history.nextFrame();
    const first = history.frameIndex;
    expect(history.openFrame(1280, 720)).toBe(true);
    expect(history.openFrame(1280, 720), 'the same answer the second time').toBe(true);
    expect(history.frameIndex, 'and the same step').toBe(first + 1);
  });

  it('advances the jitter on every frame it opens', () => {
    const history = new TemporalHistory();
    const first = history.frameIndex;
    history.nextFrame();
    history.openFrame(1280, 720);
    expect(history.frameIndex).toBe(first + 1);
    history.nextFrame();
    history.openFrame(1280, 720);
    expect(history.frameIndex).toBe(first + 2);
  });
});

/**
 * The clip is what separates temporal antialiasing from a long exposure.
 *
 * Reprojection finds where a pixel *was*; it cannot know whether what was there is what is there
 * now. A character walking in front of a wall reprojects onto wall, and blending nine parts of it
 * is a smear that follows them around. Bounding the history by the colours actually present around
 * the pixel this frame is what rejects that, and doing it by *clipping toward the centre* rather
 * than clamping each channel keeps the hue of a sample that is merely brighter than its
 * surroundings instead of grinding it onto a corner of the box.
 */
describe('clipping the history into the neighbourhood', () => {
  it('leaves a history that already sits inside the box exactly alone', () => {
    const out = clipToNeighbourhood([0, 0, 0], [0.4, 0.5, 0.6], [0.2, 0.3, 0.4], [0.6, 0.7, 0.8]);
    expect(out[0]).toBeCloseTo(0.4, 12);
    expect(out[1]).toBeCloseTo(0.5, 12);
    expect(out[2]).toBeCloseTo(0.6, 12);
  });

  it('pulls a history outside the box onto its surface', () => {
    const out = clipToNeighbourhood([0, 0, 0], [3, 0.5, 0.5], [0, 0, 0], [1, 1, 1]);
    /* Centre 0.5, extent 0.5, so the surface on that axis is exactly 1. */
    expect(out[0]).toBeCloseTo(1, 10);
  });

  /*
   * **Along the line to the centre, which is the difference from a clamp.** A clamp moves each
   * channel on its own, so a saturated history lands on a corner of the box and changes hue; this
   * keeps the direction and only shortens it.
   */
  it('moves the history along the line towards the centre of the box', () => {
    const history: readonly [number, number, number] = [2, 1.5, 1.25];
    const out = clipToNeighbourhood([0, 0, 0], history, [0, 0, 0], [1, 1, 1]);

    const centre = 0.5;
    const before = [history[0] - centre, history[1] - centre, history[2] - centre];
    const after = [out[0] - centre, out[1] - centre, out[2] - centre];
    const ratio = after[0] / before[0];
    expect(after[1] / before[1]).toBeCloseTo(ratio, 10);
    expect(after[2] / before[2]).toBeCloseTo(ratio, 10);
    expect(ratio).toBeLessThan(1);
  });

  /*
   * **A flat neighbourhood has no box to clip into**, and the ratio it would divide by is zero.
   * The honest answer there is the colour the neighbourhood actually is.
   */
  it('answers the neighbourhood itself where the box has no extent', () => {
    const out = clipToNeighbourhood([0, 0, 0], [9, 9, 9], [0.25, 0.25, 0.25], [0.25, 0.25, 0.25]);
    expect(out[0]).toBeCloseTo(0.25, 12);
    expect(out[1]).toBeCloseTo(0.25, 12);
    expect(out[2]).toBeCloseTo(0.25, 12);
  });
});

/**
 * One grey pixel through the resolve, frame after frame: the box widened by its record, the history
 * clipped to it, the record carried on, the two blended. Grey, so luma is the value itself — the
 * weights sum to one — and what goes in is a box of this frame's neighbourhood and its sample. The
 * frame count carries on across calls, so the jitter's period does.
 */
interface Pixel {
  history: number;
  record: Flicker;
  frame: number;
}

/** A calm wall, with a whole period of it already gathered: nothing to widen by, and nothing owed. */
const FRESH: Pixel = {
  history: 0.1,
  record: { spread: 0, sum: 0.1, mean: 0.1, repeated: 0 },
  frame: 0,
};

function resolveGrey(
  frames: readonly { sample: number; low: number; high: number; motion?: number; same?: boolean }[],
  antiFlicker = true,
  start: Pixel = FRESH,
): Pixel & { shown: number[] } {
  let history = start.history;
  let frame = start.frame;
  const record: Flicker = { ...start.record };
  const bounded: [number, number, number] = [0, 0, 0];
  const shown: number[] = [];
  for (const each of frames) {
    const still = stillness(each.motion ?? 0);
    if (each.same === false) freshFlicker(record, each.sample);
    const widen = antiFlicker ? flickerWidening(record, each.sample, still) : 0;
    clipToNeighbourhood(
      bounded,
      [history, history, history],
      [each.low - widen, each.low - widen, each.low - widen],
      [each.high + widen, each.high + widen, each.high + widen],
    );
    const blend = antiFlicker
      ? flickerBlend(TEMPORAL_HISTORY_BLEND, record, each.sample, still)
      : TEMPORAL_HISTORY_BLEND;
    nextFlicker(record, record, each.sample, still, frame % JITTER_PERIOD === 0);
    history = each.sample + (bounded[0] - each.sample) * blend;
    shown.push(history);
    frame += 1;
  }
  return { shown, history, record, frame };
}

/**
 * A bright thread on a dark wall, finer than a pixel: the jitter catches it in the phases given, and
 * in the others every tap round the pixel misses it, so the box is the wall alone.
 */
const THREAD = 10;
const WALL = 0.1;
function aliased(
  frames: number,
  caught = [0, 3, 5],
): { sample: number; low: number; high: number }[] {
  const out = [];
  for (let i = 0; i < frames; i++) {
    out.push(
      caught.includes(i % JITTER_PERIOD)
        ? { sample: THREAD, low: WALL, high: THREAD }
        : { sample: WALL, low: WALL, high: WALL },
    );
  }
  return out;
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

describe('the anti-flicker', () => {
  it('A STILL THREAD FINER THAN A PIXEL SETTLES ON ITS SHARE OF IT instead of flashing', () => {
    /*
     * Settled, nothing is clipped, so the history moves a tenth of the way to each sample and over a
     * period those moves cancel: the mean shown is the mean sampled, (3 × 10 + 5 × 0.1) / 8. And
     * the brightest frame is within half as much again of the darkest.
     */
    const last = resolveGrey(aliased(100 * JITTER_PERIOD)).shown.slice(-JITTER_PERIOD);
    expect(mean(last)).toBeCloseTo((3 * THREAD + 5 * WALL) / 8, 6);
    expect(Math.max(...last) / Math.min(...last)).toBeLessThan(1.5);
  });

  it('A THREAD CAUGHT IN ONE PHASE OF EIGHT IS HELD THROUGH THE SEVEN THAT MISS IT', () => {
    /*
     * It settles on (10 + 7 × 0.1) / 8 and is never cut back to the wall between catches — only
     * faded, as the blend fades anything, and a proven pixel keeps `FLICKER_BLEND` of its history.
     * Its excess over the wall just before a catch is the x with x = b⁷ (b x + (1 − b) 9.9): a catch
     * adds its share of the 9.9 it lacks, seven misses fade it. At the base blend that minimum would
     * be 0.93; kept longer it is 1.21, and the thread breathes a third as much.
     */
    const last = resolveGrey(aliased(100 * JITTER_PERIOD, [0])).shown.slice(-JITTER_PERIOD);
    expect(mean(last)).toBeCloseTo((THREAD + 7 * WALL) / 8, 6);
    const b = FLICKER_BLEND;
    const excess = (b ** 7 * (1 - b) * 9.9) / (1 - b ** 8);
    expect(Math.min(...last)).toBeCloseTo(WALL + excess, 6);
  });

  it('A THREAD MISSED IN ONE PHASE OF EIGHT IS HELD THROUGH THAT ONE', () => {
    /*
     * The hardest share, and the one `FLICKER_WIDTH` is derived from: settled, it shows exactly the
     * mean it samples, (7 × 10 + 0.1) / 8 — the single miss is never allowed to cut it back.
     */
    const last = resolveGrey(aliased(100 * JITTER_PERIOD, [0, 1, 2, 3, 4, 5, 6])).shown.slice(
      -JITTER_PERIOD,
    );
    expect(mean(last)).toBeCloseTo((7 * THREAD + WALL) / 8, 6);
  });

  it('WITHOUT IT, THE SAME THREAD IS CUT BACK TO THE WALL AND FLASHES', () => {
    /*
     * Each missed phase clips the history to the wall, so that frame shows the wall exactly; each
     * caught phase shows at least a tenth of the thread over it — 1.09 against 0.1.
     */
    const last = resolveGrey(aliased(100 * JITTER_PERIOD), false).shown.slice(-JITTER_PERIOD);
    expect(Math.min(...last)).toBeCloseTo(WALL, 9);
    expect(Math.max(...last) / Math.min(...last)).toBeGreaterThan(10);
  });

  it('A SURFACE SLIDING ACROSS A STILL PIXEL IS RESOLVED EXACTLY AS IT WAS WITHOUT IT', () => {
    /*
     * The case a record of change alone gets wrong: stripes five pixels wide sliding a pixel a frame
     * change a pixel's sample as often as a thread does, and inside a stripe the nine taps all see it,
     * so the box is that stripe alone and anything widened keeps the last one. Two rules stop it.
     * Arriving at a calm pixel, the first stripe lands farther from the wall's mean than a box with
     * no spread reaches, so the count of repeats starts again on that frame. And the stripes repeat
     * every ten frames against a period of eight, so the periods hold 5, 5, 4 and 3 bright frames:
     * the first two repeat by coincidence, once, and a single repeat widens nothing. The stripes
     * leave just after it, and from the first stripe to the wall after them the pixel is resolved
     * exactly as it is without the anti-flicker.
     */
    const crossing = Array.from({ length: 20 }, (_, i) => {
      const bright = i % 10 < 5;
      const edge = i % 5 === 0 || i % 5 === 4;
      const sample = bright ? THREAD : WALL;
      return { sample, low: edge ? WALL : sample, high: edge ? THREAD : sample };
    });
    const after = Array.from({ length: 4 }, () => ({ sample: WALL, low: WALL, high: WALL }));
    const calm = resolveGrey(aliased(4 * JITTER_PERIOD, []));
    const withIt = resolveGrey([...crossing, ...after], true, calm);
    const without = resolveGrey([...crossing, ...after], false, calm);
    expect(withIt.shown).toEqual(without.shown);
    expect(withIt.shown[20]).toBe(WALL);
  });

  it('A SURFACE LANDING BEYOND A FLICKERING PIXEL’S REACH IS THERE ON ITS FIRST FRAME, moving or still', () => {
    /*
     * The thread swings a spread of 4.66 about a mean of 3.81, so its box reaches six spreads, 28,
     * either side. A surface at 60 lands beyond that: nothing the pixel has shown explains it, so
     * the record does not vouch for this frame and the box is the surface's alone at once.
     */
    for (const motion of [0, 1]) {
      const flickering = resolveGrey(
        aliased(40 * JITTER_PERIOD).map((frame) => ({ ...frame, motion })),
      );
      const arrived = resolveGrey([{ sample: 60, low: 60, high: 60, motion }], true, flickering);
      expect(arrived.shown[0], `motion ${String(motion)}`).toBe(60);
    }
  });

  it('A SURFACE ARRIVING AT A CALM PIXEL IS THERE ON ITS FIRST FRAME, as it was without it', () => {
    /* The wall has sat still for a hundred frames: no change, nothing to widen by. */
    const calm = resolveGrey(aliased(100, []));
    const arrived = resolveGrey([{ sample: 5, low: 5, high: 5 }], true, calm);
    expect(arrived.shown[0]).toBe(5);
  });

  it('a surface arriving over a flickering pixel is held back only until the next period starts', () => {
    /*
     * The cost, bounded, and at its worst: the surface arrives on the frame after a period started,
     * so the pixel's record says it repeats for seven more. The next start compares the surface with
     * the thread, finds no repeat, and from the frame after that the box is the surface's alone.
     */
    const flickering = resolveGrey(aliased(40 * JITTER_PERIOD + 1));
    const arrived = resolveGrey(
      Array.from({ length: 16 }, () => ({ sample: 2, low: 2, high: 2 })),
      true,
      flickering,
    );
    expect(arrived.shown[0]).toBeGreaterThan(2.5);
    expect(arrived.shown[JITTER_PERIOD]).toBeCloseTo(2, 9);
  });

  it('A THREAD UNDER A MOVING CAMERA IS RESOLVED EXACTLY AS IT WAS WITHOUT IT', () => {
    /*
     * Under a moving camera nothing repeats: the thread is caught on an irregular five frames in
     * thirteen as the pixel grid slides across it, so no period proves anything and the box is this
     * frame's neighbourhood alone. A proof for motion existed — the record vouching while its samples
     * swung both ways — and was taken out: it broke a shadow line on a moving floor into dashes. See
     * the anti-flicker's header in temporalAa.ts.
     */
    const moving = Array.from({ length: 52 * 13 }, (_, i) => {
      const caught = (i * 5) % 13 < 5;
      return caught
        ? { sample: THREAD, low: WALL, high: THREAD, motion: 1 }
        : { sample: WALL, low: WALL, high: WALL, motion: 1 };
    });
    expect(resolveGrey(moving).shown).toEqual(resolveGrey(moving, false).shown);
  });

  it('A RECORD FOLLOWS ITS SURFACE WHILE LAST FRAME HELD IT WITHIN TWO PERCENT, beside or at', () => {
    /*
     * Ten metres expected and no swing: 10.1 is the same surface, a metre off is another one — and
     * the nearest of five texels counts, which is what lets a sample that straddles an edge keep its
     * record.
     */
    expect(sameSurface(10, [10.1], 0)).toBe(true);
    expect(sameSurface(10, [11], 0)).toBe(false);
    expect(sameSurface(10, [12, 8, 13, 10.15, 7], 0)).toBe(true);
    expect(sameSurface(10, [12, 8, 13, 10.3, 7], 0)).toBe(false);
    /* A swing of five metres lets 30 m pass for 10 — six swings and two percent — and not 60. */
    expect(sameSurface(10, [30], 5)).toBe(true);
    expect(sameSurface(10, [60], 5)).toBe(false);
  });

  it('A CRACK OF LIGHT KEEPS ITS RECORD ONCE ITS DEPTH HAS BEEN SEEN TO SWING, and a reveal does not', () => {
    /*
     * A pixel whose sample lands on a door five metres away in five phases of eight and on the yard
     * fifty metres behind it in three: its first jumps are refused, its swing grows on every one of
     * them whatever the test said, and once it has grown the jumps are that pixel's own and nothing
     * is refused. A flat wall at ten metres that the camera suddenly sees past, to fifty, is refused.
     */
    let last = 5;
    let swing = 0;
    const refused: number[] = [];
    for (let i = 0; i < 40 * JITTER_PERIOD; i++) {
      const expected = [0, 3, 5].includes(i % JITTER_PERIOD) ? 50 : 5;
      if (!sameSurface(expected, [last], swing)) refused.push(i);
      swing = nextDepthSwing(swing, missedBy(expected, [last]));
      last = expected;
    }
    expect(refused[0]).toBe(0);
    expect(refused.filter((i) => i >= 4 * JITTER_PERIOD)).toEqual([]);
    expect(sameSurface(50, [10], 0)).toBe(false);
    /* Nothing recorded — the frame after a cut — is no surface to follow, and teaches no swing. */
    expect(sameSurface(10, [0, 0, 0], 5)).toBe(false);
    expect(nextDepthSwing(3, missedBy(10, [0, 0]))).toBe(0);
  });

  it('A SURFACE THAT IS NOT THE ONE THE RECORD FOLLOWED IS CLIPPED AS IT WAS WITHOUT IT, for its first period', () => {
    /*
     * Last frame's depth says when a still pixel shows another surface — something has moved across
     * it — and that record is no record: nothing widens by it, and the new surface, a flickering
     * thread of its own so its spread grows at once, is resolved exactly as it is without the
     * anti-flicker until its new record has seen a period of it. Kept, the old record would have
     * widened the box by the first thread's swing from the first frame.
     */
    const flickering = resolveGrey(aliased(20 * JITTER_PERIOD));
    const revealed = aliased(JITTER_PERIOD, [1, 4, 6]).map((frame, i) => ({
      ...frame,
      same: i === 0 ? false : undefined,
    }));
    const withIt = resolveGrey(revealed, true, flickering);
    const without = resolveGrey(revealed, false, flickering);
    expect(withIt.shown).toEqual(without.shown);
  });
});

describe('the anti-flicker over a longer jitter', () => {
  it('A PERIOD OF EIGHT IS THIS RESOLVE’S OWN RULE, AND EIGHTEEN WIDENS TO WHAT ITS HARDEST THREAD NEEDS', () => {
    /*
     * Eight phases: a tenth-of-a-period memory of 1/8 and the six spreads the record's own comment
     * derives. Eighteen: the hardest thread's spread just before its catch is the steady state
     * (m + ((p − 1)m² − m)·r) / (1 − (1 − m)·r) with m = 1/18 and r = (17/18)^17 = 0.378424 —
     * 0.054387 / 0.642600 = 0.084636 of its contrast — so its catch, 17/18 away, needs 11.1589
     * spreads; eight phases need 0.875 / 0.181086 = 4.83197, and six over that is the room kept:
     * 6 × 11.1589 / 4.83197 = 13.856.
     */
    const eight = flickerRule(JITTER_PERIOD);
    expect(eight.memory).toBe(1 / 8);
    expect(eight.width).toBeCloseTo(6, 12);
    const eighteen = flickerRule(18);
    expect(eighteen.memory).toBe(1 / 18);
    expect(eighteen.width).toBeCloseTo(13.856, 3);
  });

  /** A record fed `periods` periods of a thread caught once in each period of `phases`. */
  function caughtOnce(phases: number, periods: number, rule: FlickerRule): Flicker {
    const record = freshFlicker({ spread: 0, sum: 0, mean: 0, repeated: 0 }, 0, rule);
    for (let f = 1; f < phases * periods; f += 1) {
      nextFlicker(record, record, f % phases === phases - 1 ? 1 : 0, 1, f % phases === 0, rule);
    }
    return record;
  }

  it('THE HARDEST THREAD OF AN EIGHTEEN-PHASE JITTER IS PROVEN BY ITS OWN RULE, and never by the eight-phase one', () => {
    /* Caught in one phase of eighteen at full contrast: its catch lands 17/18 from its mean, which
       six spreads never reach and 13.9 do — the count it carries out says which. */
    expect(caughtOnce(18, 8, flickerRule(18)).repeated).toBe(1);
    expect(caughtOnce(18, 8, flickerRule(JITTER_PERIOD)).repeated).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';

import {
  JITTER_PERIOD,
  TemporalHistory,
  clipToNeighbourhood,
  jitterOffset,
  jitterProjection,
} from './temporalAa.ts';

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
    expect(history.openFrame(1280, 720)).toBe(false);
  });

  it('has something to sample once a frame has been accumulated', () => {
    const history = new TemporalHistory();
    history.openFrame(1280, 720);
    history.accumulated();
    expect(history.openFrame(1280, 720)).toBe(true);
  });

  /*
   * **A resized target is a rebuilt texture**, so what it held is gone whatever the resolve would
   * like to believe.
   */
  it('has nothing to sample when the target is resized', () => {
    const history = new TemporalHistory();
    history.openFrame(1280, 720);
    history.accumulated();
    expect(history.openFrame(1920, 1080)).toBe(false);
  });

  it('recovers on the frame after a resize', () => {
    const history = new TemporalHistory();
    history.openFrame(1280, 720);
    history.accumulated();
    history.openFrame(1920, 1080);
    history.accumulated();
    expect(history.openFrame(1920, 1080)).toBe(true);
  });

  /*
   * **A cut is a new scene.** Reprojecting across one finds the old picture everywhere the new
   * camera happens to point, and it smears for as many frames as the blend takes to forget.
   */
  it('has nothing to sample after the camera cuts', () => {
    const history = new TemporalHistory();
    history.openFrame(1280, 720);
    history.accumulated();
    history.invalidate();
    expect(history.openFrame(1280, 720)).toBe(false);
  });

  /*
   * **The jitter advances every frame, accumulated or not.** Tying it to the accumulation would
   * hold the sequence still on the frames a resize or a cut discarded, and the same offset twice
   * in a row is one sample rather than two.
   */
  it('advances the jitter on every frame it opens', () => {
    const history = new TemporalHistory();
    const first = history.frameIndex;
    history.openFrame(1280, 720);
    expect(history.frameIndex).toBe(first + 1);
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

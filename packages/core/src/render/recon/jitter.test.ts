import { mat4, vec4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { JITTER_PERIOD, jitterOffset as taaJitterOffset, jitterProjection } from '../temporalAa.ts';
import { halton, jitterClip, jitterOffset, reconJitterPhases } from './jitter.ts';

/**
 * The sub-pixel sequence a reconstruction samples along.
 *
 * **The temporal resolve already had one, fixed at eight phases**, and reconstruction needs more:
 * a frame rendered at two thirds of the output's width covers each output pixel with fewer samples,
 * and the sequence has to be long enough to land every output pixel's worth of positions before it
 * repeats. So the sequence is generalised to any phase count here and the eight-phase one is the
 * same numbers it always was.
 */

test('the Halton sequence starts where it is defined to start', () => {
  expect(halton(1, 2)).toBe(0.5);
  expect(halton(2, 2)).toBe(0.25);
  expect(halton(3, 2)).toBe(0.75);
  expect(halton(1, 3)).toBeCloseTo(1 / 3, 15);
  /* Five is 12 in base three, and its digits reversed after the point are 2/3 + 1/9. */
  expect(halton(5, 3)).toBeCloseTo(7 / 9, 15);
  expect(halton(0, 2)).toBe(0);
});

test('every offset lands inside one pixel, centred on zero, at every phase count', () => {
  const out = new Float32Array(2);
  for (const phases of [1, 2, 8, 18, 32, 64]) {
    for (let frame = 0; frame < phases * 2; frame += 1) {
      jitterOffset(frame, phases, out);
      expect(Math.abs(out[0] as number), `${String(phases)} phases`).toBeLessThan(0.5);
      expect(Math.abs(out[1] as number)).toBeLessThan(0.5);
    }
  }
});

test('the sequence repeats on its phase count, so history alignment is predictable', () => {
  const a = new Float32Array(2);
  const b = new Float32Array(2);
  for (const phases of [8, 18, 32]) {
    jitterOffset(3, phases, a);
    jitterOffset(3 + phases, phases, b);
    expect(Array.from(b)).toEqual(Array.from(a));
    /* And a negative frame is the same position a whole number of periods on. */
    jitterOffset(3 - phases, phases, b);
    expect(Array.from(b)).toEqual(Array.from(a));
  }
});

test('the offsets over one period average to zero, so the image does not drift', () => {
  /*
   * **Exactly rather than nearly.** Halton's own mean is not the pixel centre — eight samples in
   * base two average 0.445 — and accumulating towards an off-centre mean resolves to a picture
   * displaced from the depth it is tested against. Each period is centred on its own mean.
   */
  const out = new Float32Array(2);
  for (const phases of [8, 18, 32]) {
    let sx = 0;
    let sy = 0;
    for (let frame = 0; frame < phases; frame += 1) {
      jitterOffset(frame, phases, out);
      sx += out[0] as number;
      sy += out[1] as number;
    }
    expect(Math.abs(sx / phases), `${String(phases)} phases`).toBeLessThan(1e-7);
    expect(Math.abs(sy / phases)).toBeLessThan(1e-7);
  }
});

test('every phase of a period is its own position', () => {
  const out = new Float32Array(2);
  for (const phases of [8, 18, 32]) {
    const seen = new Set<string>();
    for (let frame = 0; frame < phases; frame += 1) {
      jitterOffset(frame, phases, out);
      seen.add(`${String(out[0])},${String(out[1])}`);
    }
    expect(seen.size).toBe(phases);
  }
});

test('THE TEMPORAL RESOLVE’S EIGHT PHASES ARE THE NUMBERS THEY WERE, so its captures do not move', () => {
  /*
   * The first phase is Halton's first point, (1/2, 1/3), less the mean of the first eight: 57/128
   * in base two, and exactly 1/2 in base three, whose first eight points are the ninths from 1 to 8.
   */
  const out = new Float32Array(2);
  expect(JITTER_PERIOD).toBe(8);
  const [x, y] = taaJitterOffset(0);
  expect(x).toBeCloseTo(0.5 - 57 / 128, 14);
  expect(y).toBeCloseTo(1 / 3 - 1 / 2, 14);
  for (let frame = 0; frame < 24; frame += 1) {
    jitterOffset(frame, JITTER_PERIOD, out);
    const [tx, ty] = taaJitterOffset(frame);
    expect(out[0]).toBe(Math.fround(tx));
    expect(out[1]).toBe(Math.fround(ty));
  }
});

test('the same frame index always gives the same offset, because this must be reproducible', () => {
  const a = new Float32Array(2);
  const b = new Float32Array(2);
  jitterOffset(42, 16, a);
  jitterOffset(42, 16, b);
  expect(Array.from(a)).toEqual(Array.from(b));
});

test('a reconstruction takes eight phases for every output pixel a render pixel covers', () => {
  /*
   * The count the published upscalers use: eight times the area ratio, rounded up, so a render at
   * two thirds of the output a side — 2.25 output pixels a render pixel — takes eighteen.
   */
  expect(reconJitterPhases(1920, 1920)).toBe(8);
  expect(reconJitterPhases(1280, 1920)).toBe(18);
  expect(reconJitterPhases(960, 1920)).toBe(32);
  expect(reconJitterPhases(1477, 1920)).toBe(14);
  /* 13.2 phases is fourteen, not thirteen: a short period leaves positions unvisited. */
  expect(reconJitterPhases(1495, 1920)).toBe(14);
  /* Never fewer than the temporal resolve's eight, whatever a caller passes. */
  expect(reconJitterPhases(1920, 960)).toBe(8);
  expect(reconJitterPhases(0, 1920)).toBe(8);
});

test('jitter enters a perspective projection as a translation and leaves depth alone', () => {
  /*
   * **The plan asked for the jitter in the projection's third column**, and the engine already
   * rejected that for a reason worth keeping: its one geometry funnel carries a combined
   * view-projection, where the third column multiplies world z. `jitterProjection` adds the offset
   * times w in clip space instead, which is the third-column trick exactly for a bare perspective
   * — the entries it changes are the ones that trick changes — and is right for everything else.
   */
  /* Double precision, so the screen check below measures the jitter and not a rounding. */
  const proj = mat4.perspective(new Float64Array(16), Math.PI / 3, 16 / 9, 0.1, 100);
  const out = new Float64Array(16);
  jitterProjection(out, proj, 0.25, -0.25, 1920, 1080);
  expect(out[10]).toBe(proj[10]);
  expect(out[14]).toBe(proj[14]);
  /* A perspective's w is minus view z, so the third column gains minus the offset in clip units. */
  expect(out[8]).toBeCloseTo(-(2 * 0.25) / 1920, 12);
  expect(out[9]).toBeCloseTo((2 * 0.25) / 1080, 12);
  /* And a point at any depth moves by the same quarter pixel. */
  for (const z of [-0.5, -10, -90]) {
    const point = Float64Array.of(1, 2, z, 1);
    const before = vec4.transformMat4(new Float64Array(4), point, proj);
    const after = vec4.transformMat4(new Float64Array(4), point, out);
    const dx = ((after[0] / after[3] - before[0] / before[3]) * 1920) / 2;
    expect(dx).toBeCloseTo(0.25, 9);
  }
});

/**
 * What a contributed pass does with the frame's jitter: moves what it draws by exactly that much
 * of the screen, at every depth.
 *
 * **Hand-derived literals, at two depths.** A camera at the origin looking down -z through a
 * 90-degree frustum puts a point at `(0, 0, -d)` on the centre of the screen whatever `d` is, so the
 * jitter is the whole of where it lands. A translation that forgot to scale by w would move the
 * near point and the far one by different amounts, and this would say so.
 */
test('a clip-space jitter moves a point by exactly itself on screen, near and far', () => {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
  const jitter = Float32Array.from([0.004, -0.0025]);
  const out = new Float32Array(16);
  jitterClip(out, projection as Float32Array, jitter);
  for (const depth of [0.5, 40]) {
    const clip = vec4.transformMat4(vec4.create(), [0, 0, -depth, 1], out);
    expect(clip[0] / clip[3]).toBeCloseTo(0.004, 7);
    expect(clip[1] / clip[3]).toBeCloseTo(-0.0025, 7);
  }
});

test('a zero jitter hands the matrix back bit for bit', () => {
  const source = Float32Array.from({ length: 16 }, (_, i) => 0.1 + i / 7);
  const out = new Float32Array(16);
  jitterClip(out, source, new Float32Array(2));
  expect(Array.from(out)).toEqual(Array.from(source));
});

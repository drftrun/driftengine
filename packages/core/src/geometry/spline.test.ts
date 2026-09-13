import { describe, expect, test } from 'vitest';
import { Spline, createSplineSample } from './spline.ts';
import type { SplinePoint, SplineSample } from './spline.ts';

function pt(x: number, y: number, z: number, bankRad = 0, widthM = 6): SplinePoint {
  return { x, y, z, bankRad, widthM };
}

/**
 * Out, hard around, and back. The shape that breaks a naive frame: the tangent
 * sweeps through 180° and every up-vector heuristic that reaches for world up
 * gets ambiguous somewhere in the middle of it.
 */
function hairpinPoints(): SplinePoint[] {
  const points: SplinePoint[] = [pt(0, 0, 0), pt(10, 0, 0), pt(20, 0, 0)];
  for (let a = -Math.PI / 2; a <= Math.PI / 2 + 1e-6; a += Math.PI / 8) {
    points.push(pt(30 + Math.cos(a) * 8, 0, 8 + Math.sin(a) * 8));
  }
  points.push(pt(20, 0, 16), pt(10, 0, 16), pt(0, 0, 16));
  return points;
}

function sampleAt(spline: Spline, d: number): SplineSample {
  const out = createSplineSample();
  spline.sampleAt(d, out);
  return out;
}

function distance(a: SplineSample, b: SplineSample): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('Spline', () => {
  test('samples are evenly spaced along the curve, not along its parameter', () => {
    /*
     * The defect this catches is invisible in a straight line and ruins every
     * corner: parameter-spaced samples bunch where the curve is tight, so a
     * ribbon has huge triangles on the straights and a width that pulses
     * through bends. It reads as the track breathing.
     */
    const spline = new Spline(hairpinPoints());
    const step = spline.lengthM / 50;
    let previous = sampleAt(spline, 0);
    for (let i = 1; i <= 50; i++) {
      const here = sampleAt(spline, i * step);
      expect(distance(previous, here), `step ${i}`).toBeCloseTo(step, 1);
      previous = here;
    }
  });

  test('the frame stays continuous through a corner that doubles back', () => {
    // A naive up-vector frame flips when the tangent passes vertical or
    // reverses, and the ribbon turns inside out for one segment — a hole in the
    // track that only appears on one archetype.
    const spline = new Spline(hairpinPoints());
    let previous = sampleAt(spline, 0);
    for (let d = 0.5; d < spline.lengthM; d += 0.5) {
      const here = sampleAt(spline, d);
      const dot =
        previous.rightX * here.rightX +
        previous.rightY * here.rightY +
        previous.rightZ * here.rightZ;
      expect(dot, `flip at ${d}m`).toBeGreaterThan(0);
      previous = here;
    }
  });

  test('the frame survives a climb through vertical', () => {
    // World-up cross products degenerate exactly here, and a track that ramps
    // steeply is a thing this generator is going to build.
    const spline = new Spline([
      pt(0, 0, 0),
      pt(10, 2, 0),
      pt(14, 10, 0),
      pt(14, 20, 0),
      pt(10, 28, 0),
      pt(0, 30, 0),
    ]);
    for (let d = 0; d <= spline.lengthM; d += 0.5) {
      const s = sampleAt(spline, d);
      expect(Number.isFinite(s.normalX + s.normalY + s.normalZ), `NaN at ${d}m`).toBe(true);
      expect(Math.hypot(s.rightX, s.rightY, s.rightZ), `right at ${d}m`).toBeCloseTo(1, 5);
      expect(
        s.rightX * s.tangentX + s.rightY * s.tangentY + s.rightZ * s.tangentZ,
        `right ⟂ tangent at ${d}m`,
      ).toBeCloseTo(0, 5);
    }
  });

  test('banking rotates the surface without moving the centreline', () => {
    // Bank is applied about the tangent through the centre; getting the pivot
    // wrong lifts the whole track off its own path, which is only visible where
    // two segments meet.
    const flat = new Spline([pt(0, 0, 0), pt(10, 0, 0), pt(20, 0, 0), pt(30, 0, 0)]);
    const bank = 0.4;
    const banked = new Spline([
      pt(0, 0, 0, bank),
      pt(10, 0, 0, bank),
      pt(20, 0, 0, bank),
      pt(30, 0, 0, bank),
    ]);
    for (let d = 0; d <= flat.lengthM; d += 2) {
      const a = sampleAt(flat, d);
      const b = sampleAt(banked, d);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
      expect(b.z).toBeCloseTo(a.z, 6);
      // Positive bank lifts the right edge, so `right` acquires exactly sin(θ)
      // of world up and the surface normal leans the same amount.
      expect(b.rightY).toBeCloseTo(Math.sin(bank), 4);
      expect(b.normalY).toBeCloseTo(Math.cos(bank), 4);
    }
  });

  test('bank and width change smoothly rather than in steps', () => {
    /*
     * A banking value that jumps at each control point puts a crease across the
     * track, and the character hits it as a bump the generator never authored.
     */
    const spline = new Spline([
      pt(0, 0, 0, 0, 4),
      pt(10, 0, 0, 0, 4),
      pt(20, 0, 0, 0.5, 9),
      pt(30, 0, 0, 0.5, 9),
      pt(40, 0, 0, 0, 4),
    ]);
    let previous = sampleAt(spline, 0);
    for (let d = 0.25; d <= spline.lengthM; d += 0.25) {
      const here = sampleAt(spline, d);
      expect(Math.abs(here.bankRad - previous.bankRad), `bank step at ${d}m`).toBeLessThan(0.05);
      expect(Math.abs(here.widthM - previous.widthM), `width step at ${d}m`).toBeLessThan(0.5);
      previous = here;
    }
  });

  test('sampling outside the curve clamps to its ends', () => {
    const spline = new Spline([pt(0, 0, 0), pt(10, 0, 0), pt(20, 0, 0)]);
    const before = sampleAt(spline, -50);
    const after = sampleAt(spline, spline.lengthM + 50);
    expect(before.x).toBeCloseTo(0, 3);
    expect(after.x).toBeCloseTo(20, 3);
  });

  test('a degenerate spline produces no geometry rather than NaN', () => {
    // Two identical control points, one point, zero points. The generator is
    // seeded, so this will happen eventually and it must not be a blank frame.
    for (const points of [[], [pt(1, 2, 3)], [pt(1, 2, 3), pt(1, 2, 3)]]) {
      const spline = new Spline(points);
      expect(spline.lengthM).toBe(0);
      const s = sampleAt(spline, 5);
      expect(Number.isFinite(s.x + s.y + s.z)).toBe(true);
      expect(Number.isFinite(s.tangentX + s.tangentY + s.tangentZ)).toBe(true);
      expect(Math.hypot(s.tangentX, s.tangentY, s.tangentZ)).toBeCloseTo(1, 5);
    }
  });

  test('repeated control points do not poison the curve', () => {
    // Centripetal parameterisation divides by a chord length. A duplicated
    // point is the cheapest way to get a NaN across the whole track.
    const spline = new Spline([pt(0, 0, 0), pt(10, 0, 0), pt(10, 0, 0), pt(20, 0, 0)]);
    for (let d = 0; d <= spline.lengthM; d += 0.5) {
      const s = sampleAt(spline, d);
      expect(Number.isFinite(s.x + s.y + s.z), `NaN at ${d}m`).toBe(true);
    }
  });

  test('sampling allocates nothing, because it runs every tick', () => {
    const spline = new Spline(hairpinPoints());
    const out = createSplineSample();
    const before = out;
    spline.sampleAt(12, out);
    expect(out).toBe(before);
  });
});

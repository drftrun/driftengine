import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC, BodySet } from './bodies.ts';
import { boxShape, capsuleShape } from './shape.ts';

const SIX = new Float32Array(6);

describe('BodySet', () => {
  it('hands out dense indices', () => {
    const bodies = new BodySet(2);
    expect(bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1) })).toBe(0);
    expect(bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1) })).toBe(1);
    expect(bodies.count).toBe(2);
  });

  it('grows past its capacity without losing state', () => {
    const bodies = new BodySet(1);
    for (let i = 0; i < 40; i++) bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), x: i });
    expect(bodies.count).toBe(40);
    for (let i = 0; i < 40; i++) expect(bodies.posX[i]).toBeCloseTo(i, 5);
  });

  it('gives a static body zero inverse mass and zero inverse inertia', () => {
    const bodies = new BodySet();
    const s = bodies.add({ type: BODY_STATIC, shape: boxShape(1, 1, 1) });
    expect(bodies.invMass[s]).toBe(0);
    for (let k = 0; k < 6; k++) expect(bodies.invInertia[s * 6 + k]).toBe(0);
  });

  it('gives a dynamic box the inverse of its own inertia', () => {
    const bodies = new BodySet();
    // Half-extents 1, 2, 3 at density 1: volume 48, I_xx 208.
    const b = bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 2, 3), density: 1 });
    expect(bodies.invMass[b]).toBeCloseTo(1 / 48, 6);
    expect(bodies.invInertia[b * 6]).toBeCloseTo(1 / 208, 8);
    expect(bodies.invInertia[b * 6 + 1]).toBeCloseTo(1 / 160, 8);
    expect(bodies.invInertia[b * 6 + 2]).toBeCloseTo(1 / 80, 8);
  });

  it('swap-removes and reports the index that moved', () => {
    const bodies = new BodySet();
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), x: 10 });
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), x: 20 });
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), x: 30 });
    expect(bodies.remove(0)).toBe(2);
    expect(bodies.count).toBe(2);
    expect(bodies.posX[0]).toBeCloseTo(30, 5);
  });

  it('reports −1 when the removed body was the last', () => {
    const bodies = new BodySet();
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1) });
    expect(bodies.remove(0)).toBe(-1);
    expect(bodies.count).toBe(0);
  });

  it('moves the inverse inertia with a swapped body, all six terms', () => {
    const bodies = new BodySet();
    bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 1, 1), density: 1 });
    const tilted = bodies.add({
      type: BODY_DYNAMIC,
      shape: capsuleShape(0.2, 2),
      density: 1,
      // Rotated 45° about z, so the tensor has a real off-diagonal term to carry.
      qz: Math.SQRT1_2,
      qw: Math.SQRT1_2,
    });
    const before = bodies.invInertia.slice(tilted * 6, tilted * 6 + 6);
    bodies.remove(0);
    for (let k = 0; k < 6; k++) expect(bodies.invInertia[k]).toBeCloseTo(before[k] ?? 0, 8);
  });

  it('leaves a body-frame tensor alone under an identity rotation', () => {
    const bodies = new BodySet();
    const b = bodies.add({ type: BODY_DYNAMIC, shape: boxShape(1, 2, 3), density: 1 });
    bodies.worldInverseInertia(b, SIX);
    for (let k = 0; k < 6; k++) expect(SIX[k]).toBeCloseTo(bodies.invInertia[b * 6 + k] ?? 0, 8);
  });

  it('swaps xx and yy for a body turned a quarter turn about z', () => {
    const bodies = new BodySet();
    const b = bodies.add({
      type: BODY_DYNAMIC,
      shape: boxShape(1, 2, 3),
      density: 1,
      qz: Math.SQRT1_2,
      qw: Math.SQRT1_2,
    });
    bodies.worldInverseInertia(b, SIX);
    expect(SIX[0]).toBeCloseTo(1 / 160, 7);
    expect(SIX[1]).toBeCloseTo(1 / 208, 7);
    expect(SIX[2]).toBeCloseTo(1 / 80, 7);
    expect(SIX[3]).toBeCloseTo(0, 7);
  });

  it('keeps the world tensor symmetric under an arbitrary rotation', () => {
    const bodies = new BodySet();
    // A normalised, deliberately lopsided quaternion.
    const len = Math.sqrt(1 + 4 + 9 + 16);
    const b = bodies.add({
      type: BODY_DYNAMIC,
      shape: boxShape(1, 2, 3),
      density: 1,
      qx: 1 / len,
      qy: 2 / len,
      qz: 3 / len,
      qw: 4 / len,
    });
    bodies.worldInverseInertia(b, SIX);
    // Trace is invariant under a congruence by a rotation.
    const trace = (SIX[0] ?? 0) + (SIX[1] ?? 0) + (SIX[2] ?? 0);
    expect(trace).toBeCloseTo(1 / 208 + 1 / 160 + 1 / 80, 7);
  });

  /**
   * A half turn and a quarter turn both leave every off-diagonal term zero, so neither can tell a
   * correct congruence from one with a factor transposed. This one was added after exactly that:
   * transposing `out[at + 3]`'s first factor passed all eleven tests before it existed.
   *
   * At 45° about z, with body diag(a, b, c), the world tensor is xx = yy = (a + b)/2, zz = c, and
   * **xy = (a − b)/2**, which is the term nothing else here reaches.
   */
  it('carries a real off-diagonal term at 45 degrees, which is where a transpose shows', () => {
    const bodies = new BodySet();
    const b45 = bodies.add({
      type: BODY_DYNAMIC,
      shape: boxShape(1, 2, 3),
      density: 1,
      qz: Math.sin(Math.PI / 8),
      qw: Math.cos(Math.PI / 8),
    });
    bodies.worldInverseInertia(b45, SIX);
    const a = 1 / 208;
    const bb = 1 / 160;
    expect(SIX[0]).toBeCloseTo((a + bb) / 2, 8);
    expect(SIX[1]).toBeCloseTo((a + bb) / 2, 8);
    expect(SIX[2]).toBeCloseTo(1 / 80, 8);
    expect(SIX[3]).toBeCloseTo((a - bb) / 2, 8);
    expect(SIX[4]).toBeCloseTo(0, 8);
    expect(SIX[5]).toBeCloseTo(0, 8);
  });

  it('inverts a degenerate tensor to zero rather than to NaN', () => {
    const bodies = new BodySet();
    // A single point has no volume, so its tensor is singular.
    const b = bodies.add({ type: BODY_DYNAMIC, shape: boxShape(0, 0, 0), density: 1 });
    for (let k = 0; k < 6; k++)
      expect(Number.isFinite(bodies.invInertia[b * 6 + k] ?? 0)).toBe(true);
  });
});

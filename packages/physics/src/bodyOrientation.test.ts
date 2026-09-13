import { expect, test } from 'vitest';
import { AXIS_X, aabbFromCenter, bodyBounds, createBodyBounds, moveAxis } from './collide/index.ts';
import { ColliderSet } from './colliderSet.ts';
import type { Body } from './collide/index.ts';

function character(over: Partial<Body> = {}): Body {
  return { x: 0, y: 0, z: 0, hx: 0.35, hy: 0.85, hz: 0.35, ...over };
}

test('an upright body bounds to exactly its own half-extents', () => {
  /*
   * The compatibility guarantee, and it has to be exact rather than close: every body in
   * the game is upright until something tilts it, and a bound that differed by a
   * floating-point bit would move every existing collision by that bit.
   */
  const out = bodyBounds(character(), createBodyBounds());

  expect(out.hx).toBe(0.35);
  expect(out.hy).toBe(0.85);
  expect(out.hz).toBe(0.35);
});

test('a body laid on its side is bounded by its length, not its width', () => {
  // Up pointing along +X: the 1.7 m axis now runs across X, and Y holds a cross-section.
  const out = bodyBounds(character({ upX: 1, upY: 0, upZ: 0 }), createBodyBounds());

  expect(out.hx).toBeCloseTo(0.85, 6);
  expect(out.hy).toBeCloseTo(0.35, 6);
  expect(out.hz).toBeCloseTo(0.35, 6);
});

test('a body tilted to a banked deck is taller and wider than its upright box', () => {
  /*
   * The measured case. Every one of the 111 remaining drawn-deck failures sits on a deck
   * banked 0.72 rad, and a character is drawn tilted to its normal — so this is the bound
   * that was missing, and the amount by which the drawn body escaped its own volume.
   */
  const bank = 0.72;
  const out = bodyBounds(
    character({ upX: Math.sin(bank), upY: Math.cos(bank), upZ: 0 }),
    createBodyBounds(),
  );

  const across = 0.85 * Math.sin(bank) + 0.35 * Math.cos(bank);
  const tall = 0.85 * Math.cos(bank) + 0.35 * Math.sin(bank);
  expect(out.hx, 'reaches further across the deck').toBeCloseTo(across, 6);
  expect(out.hx).toBeGreaterThan(0.35);
  /*
   * And *taller* than standing, which is the counter-intuitive half: tilting a box lowers
   * what its long axis contributes to world height but raises what its cross-section does,
   * and for a 1.7 x 0.7 body at this angle the second term wins. 0.87 against 0.85 — small,
   * and it is the sign that matters, because the old bound was short in both directions at
   * once and short is what puts drawn geometry outside its own volume.
   */
  expect(out.hy).toBeCloseTo(tall, 6);
  expect(out.hy).toBeGreaterThan(0.85);
});

test('a tilted body is stopped by a wall its upright box would have cleared', () => {
  /*
   * The behaviour all of this is for. A gap 0.8 m wide passes an upright character (0.7 m
   * across) and cannot pass one lying on its side (1.7 m across) — and before bodies had
   * an orientation, both went through, which is a drawn body inside solid geometry.
   */
  // A slot 0.8 m across, from z = -0.4 to z = +0.4.
  const walls = new ColliderSet([
    aabbFromCenter(2, 0, 2.2, 0.5, 4, 1.8),
    aabbFromCenter(2, 0, -2.2, 0.5, 4, 1.8),
  ]);

  const upright = character({ x: 0 });
  expect(moveAxis(upright, walls, AXIS_X, 4)).toBeCloseTo(4, 6);

  const onSide = character({ x: 0, upX: 0, upY: 0, upZ: 1 });
  expect(moveAxis(onSide, walls, AXIS_X, 4)).toBeLessThan(4);
});

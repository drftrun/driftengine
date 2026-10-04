import { expect, test } from 'vitest';

import { LineBatch } from './lineBatch.ts';
import { recordingGl } from './rendererHarness.ts';

/**
 * How a stroke combines with what is behind it.
 *
 * **An additive stroke was reported missing by a consumer drawing a glowing block outline.** The
 * only additive one was `drawBolts`, which jitters along its own path because it is lightning, so
 * they drew two alpha-blended passes at different softness and measured what it cost: against a
 * bright surface it tints toward the glow colour instead of adding light to it — visible on sand at
 * noon, indistinguishable in a cave.
 *
 * **`AGENTS.md` forbids a mode flag on one verb to get the other, and this is not one.** What
 * separates a line from a bolt is the *path*: a bolt jitters, and nothing here changes that. A line
 * asked to be additive follows the path it was given, keeps its clean edge, and is still fogged.
 * The caller states what the stroke is; it does not ask for a different primitive.
 */
/*
 * The destination factor is what the two modes differ by, so it is read against the same context
 * that produced it: the harness answers an unnamed constant with a fresh object per access, so two
 * contexts cannot be compared and one can.
 */
function blendOf(additive: boolean) {
  const { gl, calls } = recordingGl();
  const batch = new LineBatch(gl, 4, 'lineBatch.test');
  batch.drawTo(gl, 1, additive);
  const args = calls.find((call) => call.name === 'blendFuncSeparate')?.args ?? [];
  return {
    gl,
    source: args[0],
    destination: args[1],
    alphaSource: args[2],
    alphaDestination: args[3],
  };
}

/*
 * The alpha half is the scene's surface share (`sceneCoverage.ts`): a stroke that covers what is
 * behind it covers the surface's share too, so a corner behind it does not darken it; one that is
 * light leaves the share alone.
 */
test('a line covers what is behind it, which is every stroke drawn before this', () => {
  const { gl, source, destination, alphaSource, alphaDestination } = blendOf(false);
  expect(source).toBe(gl.SRC_ALPHA);
  expect(destination).toBe(gl.ONE_MINUS_SRC_ALPHA);
  expect(alphaSource).toBe(gl.ZERO);
  expect(alphaDestination).toBe(gl.ONE_MINUS_SRC_ALPHA);
});

test('and adds to it when the caller says the stroke is light', () => {
  const { gl, source, destination, alphaSource, alphaDestination } = blendOf(true);
  expect(source).toBe(gl.SRC_ALPHA);
  expect(destination).toBe(gl.ONE);
  expect(alphaSource).toBe(gl.ZERO);
  expect(alphaDestination).toBe(gl.ONE);
});

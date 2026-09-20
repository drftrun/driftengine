import { expect, test } from 'vitest';

import { Renderer } from './renderer.ts';
import { recordingGl } from '../../rendererHarness.ts';
import { resolveRenderQuality } from '../../renderQuality.ts';

/**
 * This backend's frame budget, whose every ceiling is `null`.
 *
 * **That is the finding rather than an omission.** WebGL2 sets uniforms per draw and has no ring
 * to run out of, so it draws whatever it is handed; WebGPU holds fourteen per-frame ceilings and
 * skips the work past any of them. Both declare the same fifteen lines and count them alike, which
 * `webgpu/renderer.test.ts` asserts by running one scene through each. A scene over one of those renders in full here and loses
 * geometry there, with nothing failing on either side — and most development happens here,
 * because this is the fallback that runs everywhere.
 *
 * Reporting the count with an honest `null` is what lets a consumer see that coming: the line has
 * the same name on both backends, so a check written once can compare this backend's number
 * against the ceiling the other one publishes.
 */
test('reports a draw count and no ceiling, because this backend imposes none', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  const draws = renderer.frameBudget.lines.find((line) => line.name === 'draws');
  expect(draws, 'the same line name the other backend reports').toBeDefined();
  expect(draws?.ceiling, 'no ring here, so nothing to run out of').toBeNull();
  expect(draws?.dropped).toBe(0);
});

/**
 * **Nothing this backend can be handed will mark the frame as having dropped anything**, which is
 * the half of the divergence that lives here. The other half is asserted in the WebGPU suite,
 * where the same scene refuses the draw. Neither test is meaningful without the other, and
 * together they say precisely what a consumer moving between the two is exposed to.
 */
test('never marks a frame as having dropped work, whatever it is asked for', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  renderer.beginFrame([0, 0, 0]);
  expect(renderer.frameBudget.dropped).toBe(false);
  for (const line of renderer.frameBudget.lines) {
    expect(line.ceiling, `${line.name} imposes no ceiling on this backend`).toBeNull();
  }
});

/**
 * And the line the other backend added for its bind-group cache, reported honestly as nothing.
 *
 * A bind group is a WebGPU object; the equivalent here is loose uniform and sampler calls, which
 * are not created and cached and so cannot leak. Declaring the line anyway is the same argument
 * the draw count above makes: a consumer compares one name across both backends, and a line that
 * is absent on one is a line no cross-backend check can read. The figure it is compared against
 * should also be zero once the other backend's cache is warm, which is the whole point of that fix.
 */
test('declares the other backend’s bind-group line and never asks it', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  const groups = renderer.frameBudget.lines.find((line) => line.name === 'bind groups');
  expect(groups, 'the same line name the other backend reports').toBeDefined();
  expect(groups?.ceiling, 'nothing rationed, so nothing to publish').toBeNull();
  expect(groups?.used, 'and this backend builds none at all').toBe(0);
});

/**
 * **Panels are counted here too, against no ceiling**, so a consumer building an interface out of
 * them on this backend can see the number the other one refuses past. That backend dropped panels
 * past its sixty-fourth without a word or a count until 2026-09-19.
 */
test('counts the panels a frame asks for, and draws every one of them', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  renderer.beginFrame([0, 0, 0]);
  for (let i = 0; i < 80; i++) {
    renderer.fillPanel({ left: i, top: 0, width: 1, height: 1 }, [1, 1, 1], 1);
  }
  const panels = renderer.frameBudget.lines.find((line) => line.name === 'panels');
  expect(panels?.ceiling).toBeNull();
  expect(panels?.used).toBe(80);
  expect(panels?.dropped).toBe(0);
});

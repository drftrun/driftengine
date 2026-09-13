/**
 * The arithmetic behind an area light's specular term, held to what it was measured at.
 *
 * **This gate holds a JavaScript mirror of shader code, and that is a deliberate compromise.** The
 * term itself is GLSL in `packages/core/src/render/shaders/flat/lobes.ts`, which nothing in Node can
 * evaluate; what is asserted here is the *design* — the dominant direction, the scale law, and the
 * accuracy each of them buys against a brute-force integral. A change to `quadCoverage` that is not
 * mirrored here passes, so this cannot prove the shader; what it prevents is somebody adjusting the
 * two constants on taste and finding out from a screenshot.
 *
 * **A coarse grid, because the reference is expensive and must stay converged.** `REFERENCE_SAMPLES`
 * is 512 a side in the script and stays there: an under-sampled reference reads 0.549 where the
 * converged value is 0.997, which is how this subject produced a wrong number once already.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PLACEMENTS, measure } from './areaSpecular.mjs';
import { lobeScale } from './lobeMath.mjs';

/** Every eighth entry of the 32x32 grid, which is 25 cells and a few seconds. */
const STEP = 8;

/**
 * One measurement per placement, kept.
 *
 * The reference is 512 samples a side over 25 cells and every test below wants the same numbers, so
 * measuring per test would pay for the whole grid four times to learn nothing new. `test:scripts` is
 * meant to stay under ten seconds.
 */
const measured = new Map();
const quiet = (label, placement) => {
  if (measured.has(label)) return measured.get(label);
  const log = console.log;
  console.log = () => {};
  try {
    const stat = measure(label, placement, STEP);
    measured.set(label, stat);
    return stat;
  } finally {
    console.log = log;
  }
};

test('the coverage term beats the representative point it replaces, on both placements', () => {
  for (const [name, placement] of Object.entries(PLACEMENTS)) {
    const stat = quiet(name, placement);
    const shipped = stat.shipped.visible;
    const coverage = stat['coverage, env brdf'].visible;
    assert.ok(
      coverage < shipped,
      `${name}: coverage is ${(coverage * 100).toFixed(1)}% against the representative point's ` +
        `${(shipped * 100).toFixed(1)}%, and it is meant to be the better of the two`,
    );
  }
});

test('and it is within the error it was measured at, on the placement a softbox is', () => {
  const stat = quiet('mirror', PLACEMENTS.mirror);
  /*
   * 40.1% measured on the full grid, 2026-09-04. The margin is for the coarser grid here, not for
   * drift: a change that moves this past 50% has changed the term and should say so.
   */
  assert.ok(
    stat['coverage, env brdf'].visible < 0.5,
    `worst visible error is ${(stat['coverage, env brdf'].visible * 100).toFixed(1)}%`,
  );
});

test('the multiple-scattering compensation is worse here, and stays out', () => {
  const stat = quiet('mirror', PLACEMENTS.mirror);
  /*
   * `envSpecularEnergy` returns the multiply-scattered share, and every direct lobe in the shader is
   * single-scattering, so adding it returns energy the light never had. Asserted rather than
   * commented because the argument for putting it in is a good one and somebody will have it again.
   */
  assert.ok(
    stat['coverage, energy'].visible > stat['coverage, env brdf'].visible,
    'the compensated variant is meant to be the worse one against a single-scattering reference',
  );
});

test('the scale law is the one that was fitted', () => {
  /* 2 * alpha below about a quarter, 1.15 * alpha at one. Measured, not chosen; see the script. */
  assert.ok(
    Math.abs(lobeScale(0.01) / 0.01 - 1.9915) < 0.01,
    'near two alpha when the lobe is tight',
  );
  assert.equal(Number(lobeScale(1).toFixed(4)), 1.15, 'and 1.15 alpha at alpha one');
});

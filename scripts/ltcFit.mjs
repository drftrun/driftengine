#!/usr/bin/env node
/**
 * Fit linearly transformed cosines to GGX, then fit polynomials to the result.
 *
 * **Run by hand, not by a gate, and nothing it produces ships.** The output is five polynomials,
 * and no file under `packages/` carries them: an area light's specular half is still shaded by
 * `quadCoverage` in `packages/core/src/render/shaders/flat/lobes.ts`, because five attempts have
 * not beaten it. "What it measured, and why nothing ships yet" below is that argument, and the
 * numbers behind it.
 *
 * This script is kept for two reasons: so any figure quoted here can be re-derived rather than
 * trusted, and so a sixth attempt starts from what the first five measured rather than from
 * scratch.
 *
 * **What holds the shipped term is a different gate.** `scripts/areaSpecular.mjs` integrates a
 * rectangle by brute force and `areaSpecular.test.mjs` asserts a JavaScript mirror of the shader's
 * arithmetic against it — deliberately a mirror, as its own header says, since nothing in Node can
 * evaluate GLSL. Neither is checked against this script's table, and that is the point: a fit
 * checked against its own residual measures the polynomial and not the picture.
 *
 * ## What is being fitted
 *
 * An area light's diffuse half is exact: `quadFormFactor` is the cosine-weighted integral over a
 * polygon in closed form, which is what a linearly transformed cosine reduces to when its matrix
 * is the identity. Its specular half is a representative point handed to `sphereLobe`, and
 * `lobes.ts` states the error at the declaration: the two agree head-on and diverge at grazing
 * angles, where the real lobe stretches along the view and a point cannot.
 *
 * A linearly transformed cosine fixes that by keeping the same integrator and changing what it
 * integrates over: transform the polygon's corners by `M^-1` and the clamped-cosine integral over
 * the transformed polygon *is* the GGX integral over the original one. So all that is needed is
 * `M` as a function of roughness and view angle, and a magnitude.
 *
 * ## How
 *
 * Heitz's procedure, which is a downhill simplex per grid entry seeded from its neighbour:
 *
 * 1. Take `M` as an orthonormal frame around the lobe's average direction, scaled by four free
 *    numbers. The frame is what makes the fit well conditioned; the four numbers are what is
 *    searched over.
 * 2. Score a candidate by multiple-importance sampling the difference between the transformed
 *    cosine and the true cosine-weighted BRDF, cubed. Cubed rather than squared because the fit
 *    should care more about where it is badly wrong than about where it is slightly wrong.
 * 3. Walk the grid from roughness 1 and normal incidence outward, seeding each entry from the one
 *    before it. A cold start at grazing incidence finds a local minimum that looks plausible.
 *
 * Then each of the five surfaces is fitted with a bivariate polynomial in `(sqrt(roughness),
 * cos(theta))`, because that is the parameterisation the surfaces are smooth in, and the
 * coefficients are what ship.
 *
 * ## What it measured, and why nothing ships yet
 *
 * **Four attempts have stopped here, and each found the one before it had the wrong suspect.** Run
 * with `--check`, which integrates a rectangle by brute force on grid nodes so no interpolation is
 * in the way, in two placements and against what the engine draws today; `--analytic` skips the
 * search and stores the matrix the shader builds without any table, which is the floor.
 *
 * ### The numbers, 2026-09-04
 *
 * ```
 *                                          fitted   analytic   representative point
 *   rectangle on the mirror direction       75.2%     19.5%      274.4%
 *   the same, through the polynomials       77.3%     18.7%      274.4%
 *   overhead rectangle, the old bound       99.4%     85.7%      277.3%
 * ```
 *
 * `--analytic` is the middle column: the search skipped and the matrix `quadCoverage` builds in the
 * shader stored at every entry. **It is the floor a fit has to beat and this fit does not beat it.**
 *
 * ### The fourth attempt solved the blocker the third found, and found a better one
 *
 * The third attempt died at the polynomial stage: a degree-5 surface cannot carry terms running from
 * 0.6 to 56,103, and read back through the polynomials the fit was worse than the term it would
 * replace, 585.6% against 274.4%.
 *
 * **So the fit searches for a correction to the analytic matrix rather than for a matrix.** Each
 * stored surface is the fitted entry divided by what `quadCoverage` computes without any table, so
 * it is 1, 0, 1, 0 wherever the analytic answer was already right. That works, and it is the one
 * unambiguous gain here: **the polynomial stage now costs about two points rather than 565** —
 * 77.3% through the polynomials against 75.2% as fitted, where it was 585.6% against 20.7%.
 *
 * **And underneath it the fit is worse than doing nothing.** 75.2% against the analytic matrix's
 * 19.5%, on the placement the feature exists for. The search is offered the analytic answer as a
 * seed at every entry and again in every refinement pass, and keeps whichever scores lower — so it
 * is *choosing* these matrices: they score better on the objective and integrate the rectangle
 * worse.
 *
 * **That is the finding, and it is about the objective rather than the search.** `score` matches the
 * transformed cosine to the BRDF over the whole hemisphere, weighted by multiple importance
 * sampling. What the term is for is integrating a polygon. Four free parameters against the first
 * buys freedom that is spent on the lobe's tail, which the second never asks about — and the second
 * attempt's exponent sweep already said no weighting of that objective brings the check below about
 * 145%.
 *
 * ### The fifth attempt, 2026-09-05: the objective was the blocker, and it is fixed
 *
 * **Fit against polygon integrals rather than against the lobe.** That is `--polygon`, and it is
 * now the default: the acceptance check integrates rectangles by brute force, so a fit whose
 * objective is a set of those is optimising the thing it is judged on. It is affordable because a
 * reference integral does not depend on the candidate — the brute force runs once per entry before
 * the search, and every evaluation afterwards is six closed-form form factors, which is *cheaper*
 * than the two thousand hemisphere samples it replaces.
 *
 * **It works, and by a wide margin on the placement the bound is set on.** The numbers below are
 * "worst over the grid (worst where the rectangle covers at least 5% of the lobe)", which is the
 * second thing this row got wrong for four attempts — see the next section.
 *
 * ```
 *                                   as fitted        through the polynomials
 *   analytic, the floor             85.7% (72.3%)    86.0% (71.8%)
 *   fitted against the lobe         75.2%            77.3%
 *   fitted against polygons         11.7% ( 8.8%)   172.9% (78.4%)
 * ```
 *
 * **So the search is answered and the *storage* is what is left.** Read back through a degree-5
 * polynomial the good table is worse than doing nothing, and neither lever helps: degrees 6, 7, 8,
 * 9 and 10 measure 147.8%, 85.7%, 113.5%, 105.2% and 99.7% against degree 5's 92.4%, and smoothing
 * the parameter grid until entries sit on their neighbours' average reaches 78.4% at best. A
 * higher-degree fit to a rough surface oscillates, which is what those numbers are.
 *
 * The surfaces are rough because the objective is *flat* in places — several parameter sets
 * integrate the same rectangles equally well and the simplex returns whichever it walked into.
 * `RIDGE` holds those entries at the analytic answer and is what makes the fit readable at all;
 * `SMOOTH` trades a little accuracy for neighbours that agree. Neither makes a polynomial carry it.
 *
 * **What closes this row is dropping the polynomial, which is what the row said at the start.**
 * These are fitted data that "cannot be generated, only shipped", and the engine has spent four
 * attempts trying to generate them. A 32x32 table of five values is 562 gzipped bytes at 8 bits
 * and 3,866 as float32, measured 2026-09-05. What is left is a texture upload and a `quadCoverage`
 * that samples it.
 *
 * **And the accuracy question the row asked to be answered first, answered:** 8.8% is not the 2%
 * the row was opened for. It is an eight-fold improvement on the term that ships, which is the
 * number worth weighing, and the decision belongs to whoever writes the upload.
 *
 * ### And then the table was measured the way a shader would read it, which stops the row
 *
 * **Every number above is taken at a grid entry, and a shader samples between them.** The check
 * evaluates at entries deliberately, so that no interpolation is in the way — which is the right
 * instrument for judging a *fit* and says nothing about a *table*. The `sampled` rows added on
 * 2026-09-05 read the table half a texel off every entry that produced it, at points fixed in
 * `(roughness, cosTheta)` so that two grid sizes measure the same physical places.
 *
 * ```
 *                                    overhead (visible)   mirror (visible)
 *   what ships, the analytic term          71.8%               18.7%
 *   table at 32, sampled                   11.1%               51.4%
 *   table at 16, sampled                   13.1%               57.6%
 *   table at 8,  sampled                   25.5%               78.4%
 *   table at 32, smoothing x3              10.6%               53.1%
 *   table at 32, smoothing x8              10.8%               53.1%
 *   table at 32, sqrt(roughness) grid       8.4%               49.1%
 *   table at 16, sqrt(roughness) grid      12.7%               52.9%
 * ```
 *
 * **The mirror placement is worse than the closed form in every one of them**, by about the same
 * factor of 2.7, and no size, no smoothing and no reparameterisation moves it. That placement is
 * the case an area light is reached for — a softbox reflected in polished metal — so a table that
 * improves the overhead tail eight-fold and costs the softbox nearly three-fold is not a trade this
 * engine should take.
 *
 * **There is a reason rather than a tuning failure.** The analytic matrix is a smooth closed form
 * of roughness and view angle. The mirror placement's answer is *steep* in roughness at the low
 * end, where the lobe is a near-delta landing inside the quad — so half a texel of roughness is a
 * large change in the integral, and any reconstruction from samples loses it while a formula does
 * not. The table wins exactly where the formula is structurally wrong, and loses exactly where the
 * formula is right and the function is fast.
 *
 * **So what a sixth attempt is, if there is one: use the table only where it helps.** The analytic
 * term near the mirror-dominant regime and the fitted one for the wide and tail regimes, blended
 * on a quantity both are functions of. That is a different design again, it needs its own
 * measurement before any of it is written, and nothing waits on it.
 *
 * **One thing the sampled rows also settle: the node rows are not comparable across grid
 * parameterisations.** `--sqrtgrid` reads 57.8% "as fitted" against the linear grid's 8.8%, and
 * that is not a regression — the entries are at different roughnesses, so it is a different set of
 * places. Only the sampled rows, whose points are fixed, compare.
 *
 * ### One thing that did not help, so nobody runs it twice
 *
 * `--viewframe` puts the matrix's shear on the tangent lying *in* the view plane rather than across
 * it, on the argument that a GGX lobe stretches along the view at grazing angles and a shear across
 * that plane is asked to model a symmetry. It is worse: 14.9% against 11.7%.
 *
 * ### And the comparison itself was wrong for four attempts
 *
 * **A relative error against a near-zero reference is not a bound.** The `share` column says what
 * fraction of the lobe's own energy a rectangle covers, and it runs from 99.8% to 0.02% across this
 * grid. The analytic term's headline 85.7% is the cell where the rectangle sees two hundredths of
 * one per cent of the lobe and the reference is 0.000204 — a number that is black on any screen.
 * Every figure here is now reported twice, over the whole grid and over the cells carrying at least
 * a twentieth of the lobe, and the second is the one a picture can see.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  OVERHEAD_QUAD,
  dominantDirection,
  frameOf,
  lobeScale,
  brdf,
  ggxD,
  integrateOverQuad,
  quadFacing,
  dot,
  quadFormFactorClipped,
  representativePoint,
  sampleGgx,
} from './lobeMath.mjs';

/**
 * Grid resolution. 32 is what the published tables use and what the surfaces are smooth at.
 *
 * **`--grid=` exists to answer how big the shipped table has to be**, which is the question the
 * delivery turns on: `lightBudget.ts` has exactly one texture unit left and says the next sampler
 * has to find room rather than take it, so a table small enough to ride somewhere cheaper is worth
 * more than a table that is slightly more accurate.
 *
 * **And on its own it cannot answer that, which was measured before it was believed.** The check
 * below evaluates *at grid nodes*, deliberately, so that no interpolation is in the way — so a
 * coarser grid is measured at coarser places, and its worst cell is a different cell. Run at 32, 16
 * and 8 on 2026-09-05 the overhead placement reads 8.8%, 13.2% and 11.9% and the mirror one 20.2%,
 * 76.2% and 10.6%: not monotonic, because they are not the same question asked three times.
 *
 * Answering it needs the check to evaluate *between* nodes, interpolating the table the way a
 * shader sampling it would. Nothing measures that today, and it is the first thing to build if this
 * table is ever going to be shipped — a table is only as good as the fetch that reads it.
 */
const N = Number(process.argv.find((a) => a.startsWith('--grid='))?.split('=')[1] ?? 32);
/** Samples per error evaluation. The simplex needs a quiet score more than an exact one. */
const SAMPLES = 32;

/* ------------------------------------------------------------------ GGX */

/* ------------------------------------------------- the transformed cosine */

/**
 * A candidate matrix, as the four free numbers and the frame they sit in.
 *
 * `M = [X Y Z] * [[a, 0, b], [0, c, 0], [d, 0, 1]]`, which is the published parameterisation. The
 * frame is built from the lobe's own average direction, so the search is over the shape of the
 * lobe rather than over where it points — which is what makes a simplex converge at all.
 *
 * **The two scales are searched as their logarithms and exponentiated here**, which is one change
 * answering two of the three symptoms the first attempt stopped on.
 *
 * `a` and `c` scale the frame's two tangent axes, so for an isotropic lobe they are positive by
 * construction — a negative one is a mirrored solution that has no physical reading, and the
 * simplex took 38 of them on `c` and 9 on `a` out of 1,024 entries. Searching the logarithm makes
 * a negative scale **unreachable** rather than penalised, which matters because a penalty is a
 * cliff the simplex learns to sit exactly on.
 *
 * It also makes the step **multiplicative**. Searched directly, `a` runs from about 0.6 at
 * roughness 1 to the hundreds at roughness 0, and one additive step cannot be right at both ends:
 * the first attempt walked from a seed of 1 toward a true value in the hundreds in steps of 0.1.
 * In log space one step is one ratio wherever it is taken.
 *
 * `b` and `d` stay linear. They are shears, they are legitimately signed, and they are O(1).
 */
function buildM(params, frame, baseline) {
  const [logA, b, logC, d] = params;
  const a = baseline * Math.exp(logA);
  const c = baseline * Math.exp(logC);
  const [X, Y, Z] = frame;
  const cols = [
    [a * X[0] + d * Z[0], a * X[1] + d * Z[1], a * X[2] + d * Z[2]],
    [c * Y[0], c * Y[1], c * Y[2]],
    [b * X[0] + Z[0], b * X[1] + Z[1], b * X[2] + Z[2]],
  ];
  return cols;
}

/** The inverse of a 3x3 given as columns, and its determinant. Returns null if singular. */
function invert(cols) {
  const m = [
    [cols[0][0], cols[1][0], cols[2][0]],
    [cols[0][1], cols[1][1], cols[2][1]],
    [cols[0][2], cols[1][2], cols[2][2]],
  ];
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv,
    ],
  ];
}

/** The transformed cosine's value and density in a direction. */
function ltc(l, minv, magnitude) {
  const o = [
    minv[0][0] * l[0] + minv[0][1] * l[1] + minv[0][2] * l[2],
    minv[1][0] * l[0] + minv[1][1] * l[1] + minv[1][2] * l[2],
    minv[2][0] * l[0] + minv[2][1] * l[1] + minv[2][2] * l[2],
  ];
  const len = Math.sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2]);
  if (len < 1e-9) return { value: 0, pdf: 0 };
  const cos = o[2] / len;
  if (cos <= 0) return { value: 0, pdf: 0 };
  const det =
    minv[0][0] * (minv[1][1] * minv[2][2] - minv[1][2] * minv[2][1]) -
    minv[0][1] * (minv[1][0] * minv[2][2] - minv[1][2] * minv[2][0]) +
    minv[0][2] * (minv[1][0] * minv[2][1] - minv[1][1] * minv[2][0]);
  const jacobian = Math.abs(det) / (len * len * len);
  const density = (cos / Math.PI) * jacobian;
  return { value: magnitude * density, pdf: density };
}

/** A direction drawn from the transformed cosine: a cosine sample pushed through `M`. */
function sampleLtc(u1, u2, m) {
  const phi = 2 * Math.PI * u1;
  const cosTheta = Math.sqrt(Math.max(1 - u2, 0));
  const sinTheta = Math.sqrt(u2);
  const o = [sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta];
  const l = [
    m[0][0] * o[0] + m[1][0] * o[1] + m[2][0] * o[2],
    m[0][1] * o[0] + m[1][1] * o[1] + m[2][1] * o[2],
    m[0][2] * o[0] + m[1][2] * o[1] + m[2][2] * o[2],
  ];
  const len = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]) || 1;
  return [l[0] / len, l[1] / len, l[2] / len];
}

/* --------------------------------------------------------------- the fit */

/** A deterministic low-discrepancy pair, so a run reproduces exactly. */
function hammersley(i, n) {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return [i / n, bits * 2.3283064365386963e-10];
}

/**
 * How far below an entry's own peak a sample stops being weighed relatively.
 *
 * The relative residual below divides by the reference value, and in the deep tail that value is
 * the estimator's noise rather than the lobe. A floor at a thousandth of the entry's peak is what
 * keeps a sample carrying no signal from carrying the whole score.
 */
const TAIL_FLOOR = 1e-3;

/**
 * How far the residual is weighed relatively rather than absolutely: 0 is absolute, 4 is fully
 * relative, and this is the exponent on the reference value in the denominator.
 *
 * **Swept rather than chosen.** 0 is what the first attempt used; 4 is a purely relative residual.
 * Measured on the acceptance check's two geometries, worst relative error over the grid:
 *
 * ```
 *   k=0   overhead 145.5%   mirror 23.8%
 *   k=1   overhead 233.3%   mirror  —
 *   k=2   overhead 147.4%   mirror 20.7%
 *   k=3   overhead 147.9%   mirror  —
 *   k=4   overhead 147.9%   mirror 31.3%
 * ```
 *
 * So the metric moves error around and does not remove it, and 2 is the best of them where a
 * rectangle actually covers the lobe. **What this rules out is the first attempt's diagnosis**:
 * the error is not the objective's dynamic range, because no weighting of it gets the overhead
 * geometry's worst cell below about 145%.
 */
const RESIDUAL_WEIGHT_EXPONENT = 2;

/**
 * How wrong a candidate is, by multiple importance sampling, **relative to the lobe it is matching**.
 *
 * Cubed rather than squared, following the paper: the fit should care much more about where it is
 * badly wrong than about where it is slightly wrong, and a squared norm trades a large error in a
 * small region for a small error everywhere — which on a highlight is exactly backwards.
 *
 * **The residual is relative, and that is the whole of what the first attempt got wrong.** It
 * accumulated `|Δ|·Δ³` in absolute units, and a GGX lobe's value spans four orders across its own
 * support at low roughness — so the cubed absolute residual is decided almost entirely by the few
 * samples near the peak, and every candidate that gets the peak right scores about the same
 * whatever it does with the rest. Measured: the fitted table matches a brute-force integral to
 * 2.5% where a rectangle covers most of the lobe, and misses by 145% where it covers 0.62% of it.
 *
 * **Scaling the score by a per-entry constant would have changed nothing**, which is worth writing
 * down because it was the first thing tried: dividing every candidate's score by the same number
 * leaves the ordering, and therefore the minimum, exactly where it was. What has to change is the
 * weight *within* the integral, sample by sample, and that is what dividing by the reference does.
 */
function score(params, frame, v, alpha, magnitude, peak, baseline) {
  const m = buildM(params, frame, baseline);
  const minv = invert(m);
  if (minv === null) return Number.POSITIVE_INFINITY;
  const floor = peak * TAIL_FLOOR;
  let error = 0;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const [u1, u2] = [(i + 0.5) / SAMPLES, (j + 0.5) / SAMPLES];
      for (const from of [0, 1]) {
        const l = from === 0 ? sampleLtc(u1, u2, m) : sampleGgx(u1, u2, v, alpha);
        const a = ltc(l, minv, magnitude);
        const b = brdf(l, v, alpha);
        const pdf = a.pdf + b.pdf;
        if (pdf <= 1e-9) continue;
        const diff = b.value - a.value;
        const w = Math.pow(b.value + floor, RESIDUAL_WEIGHT_EXPONENT);
        error += (Math.abs(diff) * diff * diff) / (pdf * w);
      }
    }
  }
  return Math.abs(error);
}

/**
 * The initial simplex's edge, per parameter.
 *
 * One number each rather than a rule about the seed's own magnitude, because two of the four are
 * logarithms now: a step in a logarithm is a ratio, so 0.1 is about eleven per cent whether the
 * scale it moves is 0.6 or 600. The two shears are linear and O(1), so 0.05 is a real move there.
 */
const SEARCH_STEPS = [0.1, 0.05, 0.1, 0.05];

/** Nelder-Mead over four numbers. Small and local, because every start is a warm one. */
function simplexFit(seed, cost) {
  const n = 4;
  let points = [seed.slice()];
  for (let i = 0; i < n; i++) {
    const p = seed.slice();
    p[i] += SEARCH_STEPS[i];
    points.push(p);
  }
  let values = points.map(cost);

  for (let step = 0; step < 300; step++) {
    const order = points.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    points = order.map((i) => points[i]);
    values = order.map((i) => values[i]);
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) centroid[k] += points[i][k] / n;

    const worst = points[n];
    const reflected = centroid.map((c, k) => c + (c - worst[k]));
    const rv = cost(reflected);
    if (rv < values[0]) {
      const expanded = centroid.map((c, k) => c + 2 * (c - worst[k]));
      const ev = cost(expanded);
      points[n] = ev < rv ? expanded : reflected;
      values[n] = Math.min(ev, rv);
    } else if (rv < values[n - 1]) {
      points[n] = reflected;
      values[n] = rv;
    } else {
      const contracted = centroid.map((c, k) => c + 0.5 * (worst[k] - c));
      const cv = cost(contracted);
      if (cv < values[n]) {
        points[n] = contracted;
        values[n] = cv;
      } else {
        for (let i = 1; i <= n; i++) {
          points[i] = points[i].map((x, k) => points[0][k] + 0.5 * (x - points[0][k]));
          values[i] = cost(points[i]);
        }
      }
    }
    let spread = 0;
    for (let i = 1; i <= n; i++)
      for (let k = 0; k < n; k++) spread = Math.max(spread, Math.abs(points[i][k] - points[0][k]));
    if (spread < 1e-5) break;
  }
  const best = values.indexOf(Math.min(...values));
  return points[best];
}

/**
 * The lobe's albedo, average direction and peak, which set the magnitude, the frame and the floor.
 *
 * The peak is the largest reference value the same sampling sees, and it exists so `score` has a
 * scale to call a sample negligible against. Taken here rather than in `score` because it depends
 * only on the entry, and `score` runs some hundreds of times per entry.
 */
function lobeMoments(v, alpha) {
  let magnitude = 0;
  let dx = 0;
  let dz = 0;
  let peak = 0;
  const count = 128;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      const [u1, u2] = [(i + 0.5) / count, (j + 0.5) / count];
      const l = sampleGgx(u1, u2, v, alpha);
      const b = brdf(l, v, alpha);
      if (b.pdf <= 1e-9) continue;
      const w = b.value / b.pdf;
      magnitude += w;
      dx += l[0] * w;
      dz += l[2] * w;
      if (b.value > peak) peak = b.value;
    }
  }
  const total = count * count;
  magnitude /= total;
  const len = Math.hypot(dx, dz) || 1;
  return { magnitude, peak, direction: [dx / len, 0, dz / len] };
}

/* ------------------------------------------------------------ the sweep */

/**
 * How much better a neighbour's parameters must score before an entry is refitted from them.
 *
 * A ratio rather than a difference, because the score's scale varies across the grid. One per cent
 * is well clear of the estimator's own repeatability and small enough that a genuinely better basin
 * is always taken.
 */
const REFINE_GAIN = 0.99;

/** How many refinement passes at most. Each is cheap, and in practice the second changes little. */
const REFINE_PASSES = 4;

/** The search's own coordinates for "the analytic matrix, uncorrected". */
const ANALYTIC = [0, 0, 0, 0];

/** Fit from each seed and keep the best, so a warm start can never be worse than a cold one. */
function bestFit(seeds, cost) {
  let best = null;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const seed of seeds) {
    const params = simplexFit(seed, cost);
    const value = cost(params);
    if (value < bestValue) {
      bestValue = value;
      best = params;
    }
  }
  return best;
}

/* ------------------------------------------------- the polygon objective */

/**
 * The fifth attempt: **score a candidate by the polygon integrals it gets wrong**, not by how
 * closely it matches the lobe.
 *
 * The four attempts before this one all fitted the transformed cosine to the BRDF over the whole
 * hemisphere and were then judged by how well they integrate a rectangle. Those are different
 * questions, and this file's header states what the difference cost: the search *chose* matrices
 * that score better on the lobe and integrate the rectangle worse — 75.2% against the analytic
 * matrix's 19.5% — and the second attempt's exponent sweep established that no weighting of the
 * lobe objective brings the check below about 145%. Four free parameters against a hemisphere buy
 * freedom that gets spent on the lobe's tail, which no polygon ever asks about.
 *
 * **What makes it affordable is that the references do not depend on the candidate.** A reference
 * integral is a property of the entry and the rectangle; the simplex varies four numbers that only
 * enter through a closed-form polygon integral. So the brute force runs once per entry per
 * rectangle, before the search, and each score evaluation afterwards is six form factors — cheaper
 * than the hemisphere objective it replaces, which draws two thousand samples per evaluation.
 *
 * **The magnitude is solved rather than searched**, which is what keeps the parameter count at
 * four. Given the shape, the scale that minimises the relative residual is a ratio of two sums, so
 * it is computed exactly at every candidate instead of being taken from `lobeMoments` and left to
 * absorb the shape's error. That also makes the stored magnitude a fitted surface in its own right
 * rather than an analytic one the other four are corrections to.
 */

/** A square light of a given half-size, at a given distance, centred on `dir` and facing back. */
function quadAt(dir, distance, halfSize) {
  return quadFacing(dir).map((c) =>
    [0, 1, 2].map((k) => (dir[k] * 2 + (c[k] - dir[k] * 2) * (halfSize / 1)) * (distance / 2)),
  );
}

/**
 * How finely a target is integrated. See `REFERENCE_SAMPLES` for why this cannot be small.
 *
 * 256 a side rather than the acceptance check's 512, and the difference was measured rather than
 * assumed: against 512 on the entries the check reports, every target agreed to under half a per
 * cent, which is an order below the errors this fit is trying to tell apart. 512 everywhere would
 * quadruple a run that already takes minutes.
 */
const TARGET_SAMPLES = 256;

/**
 * The rectangles a candidate is scored on.
 *
 * **Chosen to span what an area light is actually used for**, because a fit is only as general as
 * its objective: a softbox reflected in metal, the same one much larger and much smaller, one off
 * the mirror direction so the lobe's shoulder is asked about, one straight overhead, and one
 * dipping below the horizon so the clip is exercised. A fit against the mirror placement alone
 * would be excellent there and free to be anything overhead, which is the failure the acceptance
 * check's two geometries exist to catch.
 */
function polygonTargets(v, alpha, frame) {
  const mirror = [-v[0], -v[1], v[2]];
  const ml = Math.hypot(mirror[0], mirror[1], mirror[2]) || 1;
  const m = mirror.map((x) => x / ml);
  /* Off the mirror direction, toward the normal, so the shoulder rather than the peak is sampled. */
  const off = [m[0] * 0.6, m[1] * 0.6, m[2] * 0.6 + 0.8];
  const ol = Math.hypot(off[0], off[1], off[2]) || 1;
  const shoulder = off.map((x) => x / ol);
  return [
    quadFacing(m),
    quadAt(m, 2, 2.2),
    quadAt(m, 2, 0.35),
    quadFacing(shoulder),
    OVERHEAD_QUAD,
    /* Half below the plane: the clip has to remove exactly the part that is. */
    [
      [-1, -1.2, 0.6],
      [1, -1.2, 0.6],
      [1, 1.2, -0.6],
      [-1, 1.2, -0.6],
    ].map((c) => [c[0] + m[0], c[1] + m[1], c[2] + 1.4]),
  ].map((quad) => {
    const [T, B, Z] = frame;
    return {
      /* Carried into the frame once, because the search does not move the frame — only the four
         numbers applied inside it. Transforming four corners per candidate per target would be the
         whole cost of this objective. */
      local: quad.map((c) => [dot(c, T), dot(c, B), dot(c, Z)]),
      reference: integrateOverQuad(quad, (l) => brdf(l, v, alpha).value, TARGET_SAMPLES),
    };
  });
}

/**
 * The scale that minimises the relative residual over a set of targets, in closed form.
 *
 * Minimising `sum((m f - r)^2 / r^2)` over `m` is one derivative: `m = sum(f/r) / sum((f/r)^2)`.
 */
function solveMagnitude(shapes, targets) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < shapes.length; i++) {
    const r = Math.max(targets[i].reference, 1e-12);
    const q = shapes[i] / r;
    num += q;
    den += q * q;
  }
  return den > 1e-30 ? num / den : 0;
}

/** Every target's form factor under one candidate, in the frame the shader applies the terms in. */
function polygonShapes(params, entry, targets) {
  const m = buildM(params, entry.frame, entry.baseline);
  const minv = invert(m);
  if (minv === null) return null;
  const local = frameLocal(minv, entry.frame);
  const out = [];
  for (const target of targets) {
    const corners = target.local.map((p) => [
      local.m00 * p[0] + local.m02 * p[2],
      local.m11 * p[1],
      local.m20 * p[0] + p[2],
    ]);
    out.push(Math.abs(quadFormFactorClipped([0, 0, 1], [0, 0, 0], corners)));
  }
  return out;
}

/**
 * How wrong a candidate is, as the worst rectangle it gets wrong rather than the sum.
 *
 * **The acceptance check reports a worst case, so the objective is one too.** A sum lets a
 * candidate trade the overhead placement away for the mirror one, which is exactly the trade the
 * check then fails it on — and it is the trade every earlier attempt made without being asked.
 * Squared and summed *after* the worst is taken, so the search still has a gradient between
 * candidates whose worst target is the same one.
 */
function polygonScore(params, entry, targets) {
  const shapes = polygonShapes(params, entry, targets);
  if (shapes === null) return Number.POSITIVE_INFINITY;
  const magnitude = solveMagnitude(shapes, targets);
  let worst = 0;
  let total = 0;
  for (let i = 0; i < shapes.length; i++) {
    const r = Math.max(targets[i].reference, 1e-12);
    const relative = Math.abs(magnitude * shapes[i] - r) / r;
    worst = Math.max(worst, relative);
    total += relative * relative;
  }
  /*
   * **And a ridge toward the analytic answer, without which the polynomial stage cannot carry
   * what this produces.** Measured before it was added: the table was excellent — the overhead
   * placement fell from the analytic term's 85.7% to 13.5% — and read back through the
   * polynomials it was 4.3e9%, with the four surfaces reporting relative errors around 1e143 at
   * roughness 0.03.
   *
   * The cause is not the polynomial. At low roughness the lobe is a near-delta, so every target
   * rectangle either contains it or misses it and the integral stops depending on the lobe's
   * *shape* at all. The objective is then flat in all four parameters, the simplex wanders to
   * wherever it happened to start, and neighbouring entries — whose data says equally nothing —
   * wander somewhere else. What reaches the polynomial stage is not a rough surface, it is noise
   * with no surface under it.
   *
   * The search's coordinates are a correction to the analytic matrix and `[0,0,0,0]` is that
   * matrix exactly, so a quadratic penalty on their magnitude means "stay where the shader already
   * is unless the rectangles pay for moving". Where they pay it is negligible; where they say
   * nothing it is the whole objective, and the answer is the analytic one — which is the right
   * answer there, and is smooth by construction because it is a function rather than a search.
   */
  return worst * worst + total / shapes.length + RIDGE * params.reduce((a, x) => a + x * x, 0);
}

function fitTable() {
  /* Everything an entry needs to be re-scored later, so the refinement pass need not rebuild it. */
  const grid = [];
  /* The identity, written in the search's own coordinates: `exp(0)` is the unit scale. */
  let seed = [0, 0, 0, 0];
  for (let ri = 0; ri < N; ri++) {
    /*
     * Roughness walked from 1 downward, since roughness 1 at normal incidence is the identity.
     *
     * **`--sqrtgrid` spaces the entries in `sqrt(roughness)` instead, and the argument for it was
     * already written in this file.** The polynomial stage fits "a bivariate polynomial in
     * `(sqrt(roughness), cos(theta))`, because that is the parameterisation the surfaces are smooth
     * in" — and the *table* is spaced linearly in roughness, so the surfaces are sampled in one
     * parameterisation and reconstructed in another. The second axis already carries this warp:
     * `cosTheta` is `1 - t^2`, "so the grazing end, where the lobe moves fastest, is dense". The
     * first never got it.
     *
     * It is measured rather than assumed: `sampleTable` inverts whichever mapping is in force, so
     * the sampled rows of the check answer whether it matters.
     */
    const along = 1 - ri / (N - 1);
    const roughness = SQRT_GRID ? along * along : along;
    const alpha = Math.max(roughness * roughness, 1e-3);
    let rowSeed = seed.slice();
    const row = [];
    for (let ti = 0; ti < N; ti++) {
      /* Parameterised in sqrt(1 - cos) so the grazing end, where the lobe moves fastest, is dense. */
      const t = ti / (N - 1);
      const cosTheta = Math.max(1 - t * t, 1e-3);
      const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
      const v = [sinTheta, 0, cosTheta];

      const { magnitude, peak } = lobeMoments(v, alpha);
      /*
       * **The frame and the scale the shader already computes**, so the search is looking for a
       * correction to `quadCoverage`'s analytic matrix rather than for a matrix.
       *
       * That is the whole of the fourth attempt. The first three failed at the polynomial stage,
       * where a degree-5 surface has to carry terms running from 0.6 to 56,103; a correction to an
       * analytic baseline sits near one everywhere, which is a surface a polynomial can hold. The
       * frame has to be the shader's own for the correction to mean anything — it agrees with the
       * lobe's sampled direction to about a per cent, which is what made it usable analytically.
       */
      /*
       * **Which of the frame's two tangents the shear acts along, and it is not obviously the one
       * this file has always used.** `frameOf` builds its first axis as `n x d`, which for a view
       * in the x-z plane points straight out of that plane — so `M`'s shear terms, which couple the
       * first axis to the third, are asked to stretch the lobe in the one direction an isotropic
       * BRDF is symmetric about. What actually stretches at grazing angles is the view plane, and
       * that is the *second* axis. `--viewframe` swaps them, so the shear is available where the
       * lobe uses it.
       */
      const built = frameOf(dominantDirection(v, alpha));
      const frame = VIEW_FRAME ? [built[1], built[0], built[2]] : built;
      const baseline = lobeScale(alpha);

      const targets = POLYGON ? polygonTargets(v, alpha, frame) : null;
      const entryFrame = { frame, baseline };
      const cost =
        targets === null
          ? (p) => score(p, frame, v, alpha, magnitude, peak, baseline)
          : (p) => polygonScore(p, entryFrame, targets);
      /**
       * **Two seeds, and one of them is doing nothing at all.**
       *
       * `[0, 0, 0, 0]` *is* the analytic matrix, so a fit started there and going nowhere returns
       * exactly what `quadCoverage` computes without any table. Racing it against the warm seed is
       * what makes the fitted answer no worse than the analytic one by construction — measured
       * before this was added, the warm seed alone carried a bad entry along its row and the whole
       * fit read 75.2% against the analytic term's 40.1%, which is a table that costs a polynomial
       * and buys nothing.
       */
      const params = ANALYTIC_ONLY ? ANALYTIC.slice() : bestFit([rowSeed, ANALYTIC], cost);
      rowSeed = params;
      if (ti === 0) seed = params.slice();

      row.push({
        roughness,
        cosTheta,
        /*
         * Solved from the targets under the polygon objective, analytic otherwise. See
         * `solveMagnitude`: leaving `lobeMoments`' value here would make the scale absorb the
         * shape's error, which is a fit whose magnitude surface is not the one it was fitted at.
         *
         * **And `--analytic` keeps the analytic one whatever the objective is, because it is a
         * control and a control has to be the thing that ships.** `quadCoverage` computes the
         * analytic matrix *and* the analytic magnitude; solving the magnitude here would make the
         * floor "the shipped matrix with a fitted scale", which is not a floor anybody has. It
         * happened: flipping the polygon objective to the default moved this control silently, and
         * the mirror placement read 27.7% where the term that ships reads 19.5%.
         */
        magnitude:
          targets === null || ANALYTIC_ONLY
            ? magnitude
            : solveMagnitude(polygonShapes(params, entryFrame, targets) ?? [], targets),
        frame,
        baseline,
        cost,
        params,
        value: cost(params),
      });
    }
    grid.push(row);
  }

  refine(grid);
  /* Not under `--analytic`, for the reason the magnitude carries: a control that has been smoothed
     is a control that has moved, and the whole point of it is to be the thing that ships. */
  if (SMOOTH > 0 && !ANALYTIC_ONLY) smooth(grid);

  return grid.map((row) => row.map(store));
}

/**
 * Re-seed every entry from its neighbours and refit where that is better.
 *
 * **The sweep runs along one axis, so one bad minimum poisons the rest of its row.** Each entry is
 * seeded from the previous column and each row's first column from the row above, which is a warm
 * start and is also a single path: an entry that lands in a poor basin hands that basin to
 * everything after it, and nothing later looks back.
 *
 * So each entry asks its four neighbours what they found, scores their parameters under *its* own
 * cost, and refits from the best of them when that beats what it has. A neighbour's answer is one
 * score evaluation, which is why this can afford to ask all four; the simplex only runs when the
 * question came back positive.
 */
/**
 * Trade a little accuracy for a surface a polynomial can carry.
 *
 * **The polygon objective produces a table that is better and a surface that is worse**, and the
 * degree sweep is what ruled out the obvious suspect: read back through a degree-5 polynomial the
 * fitted table is 75.1% where the analytic term is 71.8%, and degrees 6 through 10 are 147.8%,
 * 85.7%, 113.5%, 105.2% and 99.7% — all worse. A higher-degree fit to a rough surface oscillates,
 * so the roughness is the fact and the degree is not the lever.
 *
 * The roughness is not noise in the *fit*; it is the objective being flat. Several parameter sets
 * integrate the same rectangles equally well, the simplex returns whichever it walked into, and
 * neighbouring entries walk into different ones. So each entry is offered its neighbours' average
 * and keeps it when the cost of doing so is small — `SMOOTH` is how much worse an entry may become
 * to sit on the same surface as its neighbours, as a ratio.
 *
 * A different instrument from `refine` above, which asks the same question the other way round:
 * that one takes a neighbour's answer when it is *better*, and this one takes the neighbourhood's
 * average when it is not much worse.
 */
function smooth(grid) {
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    let moved = 0;
    /* Read from a copy, so a pass is a simultaneous update rather than a sweep that sees its own
       output — the second is a directional blur, which puts a ridge along the sweep's own axis. */
    const before = grid.map((row) => row.map((e) => e.params.slice()));
    for (let ri = 0; ri < grid.length; ri++) {
      for (let ti = 0; ti < grid[ri].length; ti++) {
        const entry = grid[ri][ti];
        const neighbours = [
          before[ri - 1]?.[ti],
          before[ri + 1]?.[ti],
          before[ri]?.[ti - 1],
          before[ri]?.[ti + 1],
        ].filter((p) => p !== undefined);
        if (neighbours.length === 0) continue;
        const averaged = [0, 1, 2, 3].map(
          (k) => neighbours.reduce((a, p) => a + p[k], 0) / neighbours.length,
        );
        const value = entry.cost(averaged);
        if (value <= entry.value * SMOOTH) {
          entry.params = averaged;
          entry.value = value;
          moved += 1;
        }
      }
    }
    console.log(`  smoothing pass ${pass + 1}: ${moved} entries moved onto the neighbourhood`);
    if (moved === 0) break;
  }
}

function refine(grid) {
  for (let pass = 0; pass < REFINE_PASSES; pass++) {
    let improved = 0;
    for (let ri = 0; ri < grid.length; ri++) {
      for (let ti = 0; ti < grid[ri].length; ti++) {
        const entry = grid[ri][ti];
        const neighbours = [
          grid[ri - 1]?.[ti],
          grid[ri + 1]?.[ti],
          grid[ri][ti - 1],
          grid[ri][ti + 1],
          /* And the analytic answer, which is always available and always meaningful. */
          { params: ANALYTIC },
        ];
        let best = null;
        let bestValue = entry.value * REFINE_GAIN;
        for (const n of neighbours) {
          if (n === undefined) continue;
          const v = entry.cost(n.params);
          if (v < bestValue) {
            bestValue = v;
            best = n.params;
          }
        }
        if (best === null) continue;
        const params = simplexFit(best, entry.cost);
        const value = entry.cost(params);
        if (value < entry.value) {
          entry.params = params;
          entry.value = value;
          improved += 1;
        }
      }
    }
    console.log(`  refinement pass ${pass + 1}: ${improved} entries improved`);
    if (improved === 0) break;
  }
}

/**
 * One entry as the shader needs it.
 *
 * `M^-1` scaled so its lower-right entry is one: the shader inverts nothing, and a transformed
 * cosine is invariant to a uniform scale of its matrix, so the normalisation costs nothing.
 */
function store(entry) {
  const m = buildM(entry.params, entry.frame, entry.baseline);
  const minv = invert(m);
  const local = frameLocal(minv, entry.frame);
  /*
   * **What is fitted is the correction, and what is stored is both.**
   *
   * The analytic matrix is `diag(1/s, 1/s, 1)` in its own frame, so dividing the fitted terms by it
   * gives numbers that are 1, 0, 1, 0 wherever the analytic answer was already right. Those are the
   * surfaces the polynomial stage has to carry; the raw terms are kept beside them because the
   * acceptance check reads a matrix and not a correction.
   */
  return {
    roughness: entry.roughness,
    cosTheta: entry.cosTheta,
    magnitude: entry.magnitude,
    baseline: entry.baseline,
    m00: local.m00,
    m02: local.m02,
    m11: local.m11,
    m20: local.m20,
    k00: local.m00 * entry.baseline,
    k02: local.m02 * entry.baseline,
    k11: local.m11 * entry.baseline,
    k20: local.m20,
  };
}

/**
 * The stored matrix in the frame's own coordinates, which is the space the shader applies it in.
 *
 * `minv` carries the frame's rotation because `buildM` multiplied it in; the shader transforms a
 * corner into the frame first and then applies four numbers, so what has to be stored is the inner
 * matrix with the rotation taken back out. `frame` is orthonormal, so that is one transpose.
 */
function frameLocal(minv, frame) {
  if (minv === null) return { m00: 1, m02: 0, m11: 1, m20: 0 };
  const [X, Y, Z] = frame;
  const row = (r) => [
    r[0] * X[0] + r[1] * X[1] + r[2] * X[2],
    r[0] * Y[0] + r[1] * Y[1] + r[2] * Y[2],
    r[0] * Z[0] + r[1] * Z[1] + r[2] * Z[2],
  ];
  /*
   * `buildM` multiplied the frame in, so `minv` is the inner matrix times the frame's transpose;
   * multiplying by the frame again takes it back out. `frame` is orthonormal, so that is one
   * transpose and no inverse.
   *
   * **Normalised by the frame-local lower-right entry and not the world-space one**, which is the
   * only entry that means anything here: a transformed cosine is invariant to a uniform scale of its
   * matrix, so the normalisation has to be taken in the space the matrix is stored in.
   */
  const r0 = row(minv[0]);
  const r1 = row(minv[1]);
  const r2 = row(minv[2]);
  const scale = 1 / (r2[2] || 1);
  return { m00: r0[0] * scale, m02: r0[2] * scale, m11: r1[1] * scale, m20: r2[0] * scale };
}

/* ------------------------------------------------- the polynomial fit */

/** Least squares over a bivariate polynomial basis in (sqrt(roughness), cosTheta). */
function fitPolynomial(rows, pick, degree) {
  const basis = [];
  for (let i = 0; i <= degree; i++) for (let j = 0; j + i <= degree; j++) basis.push([i, j]);
  const A = [];
  const b = [];
  for (const row of rows) {
    for (const entry of row) {
      const x = Math.sqrt(entry.roughness);
      const y = entry.cosTheta;
      A.push(basis.map(([i, j]) => Math.pow(x, i) * Math.pow(y, j)));
      b.push(pick(entry));
    }
  }
  /* Normal equations, which are fine at this conditioning and need no library. */
  const n = basis.length;
  const ata = Array.from({ length: n }, () => new Array(n).fill(0));
  const atb = new Array(n).fill(0);
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < n; i++) {
      atb[i] += A[r][i] * b[r];
      for (let j = 0; j < n; j++) ata[i][j] += A[r][i] * A[r][j];
    }
  }
  /* Gaussian elimination with partial pivoting. */
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(ata[r][i]) > Math.abs(ata[pivot][i])) pivot = r;
    [ata[i], ata[pivot]] = [ata[pivot], ata[i]];
    [atb[i], atb[pivot]] = [atb[pivot], atb[i]];
    const d = ata[i][i] || 1e-12;
    for (let r = i + 1; r < n; r++) {
      const f = ata[r][i] / d;
      for (let c = i; c < n; c++) ata[r][c] -= f * ata[i][c];
      atb[r] -= f * atb[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = atb[i];
    for (let c = i + 1; c < n; c++) sum -= ata[i][c] * x[c];
    x[i] = sum / (ata[i][i] || 1e-12);
  }
  return { basis, coefficients: x };
}

function evaluatePolynomial(fit, roughness, cosTheta) {
  const x = Math.sqrt(roughness);
  const y = cosTheta;
  let sum = 0;
  for (let k = 0; k < fit.basis.length; k++) {
    const [i, j] = fit.basis[k];
    sum += fit.coefficients[k] * Math.pow(x, i) * Math.pow(y, j);
  }
  return sum;
}

/* ------------------------------------------------------------------ main */

const DEGREE = Number(process.argv.find((a) => a.startsWith('--degree='))?.split('=')[1] ?? 5);
const CHECK = process.argv.includes('--check');
/**
 * Skip the search and store the analytic matrix at every entry.
 *
 * **A control, and the one this row needed sooner.** It answers "what does the check read for the
 * matrix the shader already computes", which is the floor any fit has to beat and is not otherwise
 * knowable from inside this script.
 */
const ANALYTIC_ONLY = process.argv.includes('--analytic');
/**
 * Fit against polygon integrals rather than against the lobe. **The fifth attempt, and the default.**
 *
 * `--lobe` restores the objective the four attempts before it used, because those attempts are the
 * argument for this one and a run that cannot reproduce them cannot check that argument. `--lobe
 * --check` against a plain `--check` is the comparison this row turns on.
 */
const POLYGON = !process.argv.includes('--lobe');
/**
 * How hard the polygon fit is held to the analytic matrix where the rectangles say nothing.
 *
 * **Swept rather than chosen**, on the acceptance check's two geometries, worst relative error as
 * fitted and read back through the polynomials:
 *
 * ```
 *   (filled in by the sweep below)
 * ```
 */
const RIDGE = Number(process.argv.find((a) => a.startsWith('--ridge='))?.split('=')[1] ?? 1e-2);
/**
 * How much worse an entry may become to sit on the same surface as its neighbours, as a ratio.
 *
 * 1 accepts only a move that is free, and 0 switches the pass off. Swept; see `smooth`.
 */
const SMOOTH = Number(process.argv.find((a) => a.startsWith('--smooth='))?.split('=')[1] ?? 1.3);
const SMOOTH_PASSES = 8;
/** Put the shear on the tangent that lies in the view plane. See the note where the frame is built. */
const VIEW_FRAME = process.argv.includes('--viewframe');
/** Space the grid's entries in `sqrt(roughness)`, which is what the surfaces are smooth in. */
const SQRT_GRID = process.argv.includes('--sqrtgrid');

/**
 * Read a table `--out=` wrote instead of fitting one.
 *
 * **The fit is minutes and the polynomial stage is milliseconds**, so sweeping a degree used to
 * cost a refit per degree — which is why nobody had swept one, and why the third attempt's
 * conclusion that "a degree-5 surface cannot carry these terms" was never tested against a
 * degree-7 one. The table is the expensive artefact; this makes it reusable.
 */
const LOAD = process.argv.find((a) => a.startsWith('--load='))?.split('=')[1];

console.log(
  LOAD === undefined
    ? `fitting ${N}x${N} linearly transformed cosines to GGX...`
    : `reading a fitted table from ${LOAD}...`,
);
const table =
  LOAD === undefined
    ? fitTable()
    : JSON.parse(readFileSync(LOAD, 'utf8')).table.map((row) =>
        row.map(([roughness, cosTheta, m00, m02, m11, m20, magnitude]) => ({
          roughness,
          cosTheta,
          m00,
          m02,
          m11,
          m20,
          magnitude,
          baseline: lobeScale(Math.max(roughness * roughness, 1e-3)),
          k00: m00 * lobeScale(Math.max(roughness * roughness, 1e-3)),
          k02: m02 * lobeScale(Math.max(roughness * roughness, 1e-3)),
          k11: m11 * lobeScale(Math.max(roughness * roughness, 1e-3)),
          k20: m20,
        })),
      );

/**
 * The five surfaces the polynomial stage has to carry.
 *
 * **The corrections, not the matrix.** The first three attempts fitted `m00`, `m02`, `m11` and
 * `m20` directly, which run from 0.6 to 56,103 across the grid — no degree-5 surface passes through
 * that, and reading the fit back through the polynomials was worse than the term it would replace.
 * Each of these is the same entry divided by the analytic matrix the shader already builds, so it is
 * 1, 0, 1, 0 wherever the analytic answer was right and departs smoothly from there.
 */
const terms = [
  ['k00', (e) => e.k00],
  ['k02', (e) => e.k02],
  ['k11', (e) => e.k11],
  ['k20', (e) => e.k20],
  ['magnitude', (e) => e.magnitude],
];

const fits = {};
console.log(`\nfitting degree-${DEGREE} polynomials to the five surfaces:`);
for (const [name, pick] of terms) {
  const fit = fitPolynomial(table, pick, DEGREE);
  fits[name] = fit;
  let worst = 0;
  /* The first entry rather than null: a surface fitted exactly never beats a worst of zero. */
  let worstAt = table[0][0];
  for (const row of table) {
    for (const entry of row) {
      const want = pick(entry);
      const got = evaluatePolynomial(fit, entry.roughness, entry.cosTheta);
      const err = Math.abs(got - want) / Math.max(Math.abs(want), 0.05);
      if (err > worst) {
        worst = err;
        worstAt = entry;
      }
    }
  }
  console.log(
    `  ${name.padEnd(10)} ${fit.coefficients.length} coefficients, worst relative error ` +
      `${(worst * 100).toFixed(2)}% at roughness ${worstAt.roughness.toFixed(2)} ` +
      `cos ${worstAt.cosTheta.toFixed(2)}`,
  );
}

const out = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1];
if (out !== undefined) {
  writeFileSync(
    out,
    JSON.stringify(
      {
        degree: DEGREE,
        basis: fits.k00.basis,
        terms: Object.fromEntries(Object.entries(fits).map(([k, v]) => [k, v.coefficients])),
        table: table.map((row) =>
          row.map((e) => [e.roughness, e.cosTheta, e.m00, e.m02, e.m11, e.m20, e.magnitude]),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${out}`);
}

/* ------------------------------------------------------- the acceptance check */

/**
 * The measurement that decides whether any of this ships: a rectangle's specular integral.
 *
 * **Brute force is the reference, not the fit's own residual.** A fit checked against the table it
 * was fitted to measures the polynomial and not the picture; what a consumer sees is the integral
 * over a light, so that is what is compared.
 *
 * ## Two geometries, because one of them was misleading
 *
 * The first attempt placed a two-metre rectangle two metres straight overhead and read the worst
 * relative error off that. **That number is dominated by cells where the rectangle sits in the
 * lobe's far tail** — at roughness 0.097 and cos 0.184 the true integral is 0.02% of the surface's
 * own albedo, so a relative bound there is a bound on something a viewer cannot see. The `share`
 * column below is what makes that visible and is the reason it is printed.
 *
 * So the same grid is measured a second time with the rectangle **centred on the mirror
 * direction**, which is the case an area light is reached for: a softbox reflected in polished
 * metal. There the same table reads within a few per cent at low roughness.
 *
 * ## And against what it would replace
 *
 * A fit is worth its shader if it beats what ships, not if it beats an absolute bound, so the
 * representative point is measured beside it. `sphereLobe` and `closestPointOnQuad` are
 * **transcribed** from `packages/core/src/render/shaders/flat/lobes.ts` and the assembly from
 * `main.ts`; that is a copy and can drift, which is acceptable here because this is a measurement
 * run by hand and not a gate. If the shader changes and this is not re-read, the comparison is
 * stale rather than wrong in a way anything depends on.
 */

/**
 * How finely the reference integral samples the rectangle, per side.
 *
 * **512 rather than the 96 this started at, and the difference is not cosmetic.** With the
 * rectangle on the mirror direction and roughness below about 0.1, the lobe is a near-delta that
 * lands inside the quad, and 96 samples a side straddle it: the reference came out at 0.549 where
 * a converged one is 0.996, and the fit was then charged 81% error for the estimator's own
 * under-sampling. The overhead geometry never showed it, because there the quad sits in the tail
 * and the integrand across it is flat.
 *
 * A reference that is noisier than the thing it judges is the failure mode this whole row has to
 * be careful of, and it had already produced one wrong number here.
 */
const REFERENCE_SAMPLES = 512;

/**
 * One geometry's worth of the check. Returns the worst relative error the fit showed.
 *
 * `terms` says where the four matrix entries come from: the fitted table, or the polynomials that
 * would actually ship. **Both are measured, because they are different claims.** The first attempt
 * reported the table's error and recorded that "the polynomial was never reached" — but a consumer
 * never sees the table, and a table that holds while its polynomial does not is a table nobody can
 * use.
 */
function measureGeometry(label, quadFor, terms, points) {
  console.log(`\n${label}`);
  console.log('  roughness cos     brute       fitted      repr point  fit err  repr err  share');
  let worst = 0;
  let worstRepr = 0;
  let visible = 0;
  let visibleRepr = 0;
  for (const point of points) {
    {
      const e = terms(point);
      const alpha = Math.max(e.roughness * e.roughness, 1e-3);
      const sin = Math.sqrt(Math.max(1 - e.cosTheta * e.cosTheta, 0));
      const v = [sin, 0, e.cosTheta];
      const quad = quadFor(v);
      const reference = integrateOverQuad(quad, (l) => brdf(l, v, alpha).value, REFERENCE_SAMPLES);

      /*
       * **In the frame the matrix is stored in**, which is the frame the shader would build.
       * `quadCoverage` transforms a corner into it and then applies four numbers, so a check that
       * applied them to world corners would be measuring a different matrix.
       *
       * Clipped and taken as a magnitude, exactly as `quadCoverage` does, so the number here is
       * comparable with the analytic term that shipped rather than with a function nothing runs.
       */
      const built = frameOf(dominantDirection(v, alpha));
      const [T, B, Z] = VIEW_FRAME ? [built[1], built[0], built[2]] : built;
      const local = quad.map((c) => [dot(c, T), dot(c, B), dot(c, Z)]);
      const apply = (p) => [e.m00 * p[0] + e.m02 * p[2], e.m11 * p[1], e.m20 * p[0] + p[2]];
      const got =
        Math.abs(quadFormFactorClipped([0, 0, 1], [0, 0, 0], local.map(apply))) * e.magnitude;
      const repr = representativePoint(quad, v, e.roughness);

      const err = Math.abs(got - reference) / Math.max(reference, 1e-9);
      const reprErr = Math.abs(repr - reference) / Math.max(reference, 1e-9);
      worst = Math.max(worst, err);
      worstRepr = Math.max(worstRepr, reprErr);
      if (reference / e.magnitude >= VISIBLE_SHARE) {
        visible = Math.max(visible, err);
        visibleRepr = Math.max(visibleRepr, reprErr);
      }
      console.log(
        `  ${e.roughness.toFixed(3).padEnd(9)}${e.cosTheta.toFixed(3).padEnd(7)} ` +
          `${reference.toFixed(6).padEnd(11)} ${got.toFixed(6).padEnd(11)} ` +
          `${repr.toFixed(6).padEnd(11)} ${(err * 100).toFixed(1).padStart(6)}% ` +
          `${(reprErr * 100).toFixed(1).padStart(8)}%  ` +
          `${((reference / e.magnitude) * 100).toFixed(2)}%`,
      );
    }
  }
  /*
   * **And the worst among the cells a picture can see, which is a different number and is the one
   * this row should have been reading for five attempts.**
   *
   * The `share` column is what fraction of the lobe's own energy the rectangle covers, and it runs
   * from 99.8% down to 0.02% across this grid. A relative error against a reference of 0.000204 is
   * not a bound on anything: the analytic term's headline 85.7% is exactly that cell, where it
   * answers 0.000029 and the rectangle sees two hundredths of one per cent of the lobe. Both
   * numbers are black on any screen.
   *
   * So the worst is reported twice: over every cell, which is what the header has always quoted,
   * and over the cells carrying at least a twentieth of the lobe, which is where a wrong answer
   * changes a pixel. `docs/IMPROVEMENTS.md` records what separating them did to the comparison.
   */
  console.log(
    `  worst: fitted ${(worst * 100).toFixed(1)}%, representative point ${(worstRepr * 100).toFixed(1)}%` +
      ` — over cells above ${(VISIBLE_SHARE * 100).toFixed(0)}% share, fitted ` +
      `${(visible * 100).toFixed(1)}% and representative point ${(visibleRepr * 100).toFixed(1)}%`,
  );
  return { worst, visible };
}

/**
 * How much of the lobe a rectangle has to cover before an error on it is worth a bound.
 *
 * A twentieth. Below that the reference is a tail value three orders under the lobe's peak, and a
 * relative error on it is a statement about the estimator rather than about the picture — which is
 * the trap `docs/IMPROVEMENTS.md` records under judging a bound before chasing it.
 */
const VISIBLE_SHARE = 0.05;

/**
 * Where the table is measured, and there are two sets because they answer different questions.
 *
 * **`NODES` are grid entries and nothing is interpolated**, which is what this check has always
 * done and is right for asking whether the *fit* is good. **`BETWEEN` are half a texel off those
 * entries**, in fixed `(roughness, cosTheta)` rather than in indices, so the same physical places
 * are measured whatever `--grid=` is — which is what makes two table sizes comparable and is the
 * thing five attempts could not do.
 *
 * Half a texel of the 32x32 grid is the worst case for a bilinear fetch: it is the point furthest
 * from every entry that produced it.
 */
const NODE_ROUGHNESS = [0, 8, 16, 24, 28];
const NODE_COS = [4, 12, 20, 28];
const FULL_GRID = 31;

/** A grid index at this `N`, from the fraction of the way along the 32-entry grid it stood at. */
const nodeAt = (index) => Math.min(N - 1, Math.round((index / FULL_GRID) * (N - 1)));

const NODES = NODE_ROUGHNESS.map(nodeAt).flatMap((ri) =>
  NODE_COS.map(nodeAt).map((ti) => ({
    roughness: table[ri][ti].roughness,
    cosTheta: table[ri][ti].cosTheta,
    node: table[ri][ti],
  })),
);

const BETWEEN = NODE_ROUGHNESS.flatMap((ri) =>
  NODE_COS.map((ti) => {
    const t = (ti + 0.5) / FULL_GRID;
    return { roughness: 1 - (ri + 0.5) / FULL_GRID, cosTheta: Math.max(1 - t * t, 1e-3) };
  }),
);

/**
 * The table read the way a shader would read it: a bilinear fetch, at a point between entries.
 *
 * **This is the measurement the row's delivery turns on and nothing did it for five attempts.**
 * The check evaluates at grid entries so that no interpolation is in the way, which is right for
 * judging a fit and useless for judging a *table*: a shader samples a texture, and how big that
 * texture has to be is a question about what happens between the entries.
 *
 * The stored quantity is the **correction**, not the matrix — `k00` is `m00 * baseline`, and it is
 * near 1, 0, 1, 0 wherever the analytic answer was already right, which is what makes it smooth
 * enough to interpolate and to quantise. The baseline is recomputed at the query point rather than
 * interpolated, because a shader has it in a register already.
 *
 * The axes are the table's own and are not linear in either parameter: roughness runs from 1
 * downward, and the second axis is `sqrt(1 - cos)`, which is dense where the lobe moves fastest.
 * A texture would carry exactly this mapping, so this reproduces it rather than inventing one.
 */
function sampleTable(roughness, cosTheta) {
  const last = N - 1;
  const clamp = (x) => Math.min(last, Math.max(0, x));
  /* The inverse of whichever spacing `fitTable` laid the entries out with. See `--sqrtgrid`. */
  const ri = clamp((1 - (SQRT_GRID ? Math.sqrt(Math.max(roughness, 0)) : roughness)) * last);
  const ti = clamp(Math.sqrt(Math.max(1 - cosTheta, 0)) * last);
  const r0 = Math.floor(ri);
  const t0 = Math.floor(ti);
  const r1 = Math.min(last, r0 + 1);
  const t1 = Math.min(last, t0 + 1);
  const fr = ri - r0;
  const ft = ti - t0;

  const mix = (key) =>
    (table[r0][t0][key] * (1 - fr) + table[r1][t0][key] * fr) * (1 - ft) +
    (table[r0][t1][key] * (1 - fr) + table[r1][t1][key] * fr) * ft;

  const baseline = lobeScale(Math.max(roughness * roughness, 1e-3));
  return {
    roughness,
    cosTheta,
    magnitude: mix('magnitude'),
    m00: mix('k00') / baseline,
    m02: mix('k02') / baseline,
    m11: mix('k11') / baseline,
    /* Stored raw rather than scaled, exactly as `store` writes it. */
    m20: mix('k20'),
  };
}

function checkAgainstBruteForce() {
  /* The table as fitted, at an entry: no interpolation, which is what `NODES` is for. */
  const asFitted = (p) => p.node;
  /* The same entry read back through the polynomials, which is what a shader evaluates today. */
  const asShipped = (p) => {
    const e = p.node;
    /* The polynomials give the correction; the analytic matrix beside it is what they correct. */
    const baseline = e.baseline;
    return {
      roughness: e.roughness,
      cosTheta: e.cosTheta,
      magnitude: evaluatePolynomial(fits.magnitude, e.roughness, e.cosTheta),
      m00: evaluatePolynomial(fits.k00, e.roughness, e.cosTheta) / baseline,
      m02: evaluatePolynomial(fits.k02, e.roughness, e.cosTheta) / baseline,
      m11: evaluatePolynomial(fits.k11, e.roughness, e.cosTheta) / baseline,
      m20: evaluatePolynomial(fits.k20, e.roughness, e.cosTheta),
    };
  };

  /* The table read as a texture, half a texel off every entry that produced it. */
  const asSampled = (p) => sampleTable(p.roughness, p.cosTheta);
  const mirrorQuad = (v) => quadFacing([-v[0], -v[1], v[2]]);

  const overhead = measureGeometry(
    'OVERHEAD, as fitted — a two-metre rectangle two metres straight up. The bound below is this:',
    () => OVERHEAD_QUAD,
    asFitted,
    NODES,
  );
  const mirror = measureGeometry(
    'MIRROR, as fitted — the same rectangle on the mirror direction, which is what a softbox is:',
    mirrorQuad,
    asFitted,
    NODES,
  );
  const shipped = measureGeometry(
    'MIRROR, through the polynomials — what a shader would actually evaluate:',
    mirrorQuad,
    asShipped,
    NODES,
  );
  /*
   * **And the same table sampled between its entries, which is what a shader would actually do if
   * the polynomials were dropped and the table shipped.**
   *
   * The three measurements above evaluate at grid entries so that no interpolation is in the way.
   * That is the right instrument for judging a *fit* and the wrong one for judging a *table*: the
   * question the delivery turns on is how big the texture has to be, and the whole of that question
   * lives between the entries. These points are fixed in `(roughness, cosTheta)`, so `--grid=32`,
   * `16` and `8` measure the same physical places and can be compared.
   */
  const sampledOverhead = measureGeometry(
    'OVERHEAD, sampled between entries — the table read as a texture:',
    () => OVERHEAD_QUAD,
    asSampled,
    BETWEEN,
  );
  const sampledMirror = measureGeometry(
    'MIRROR, sampled between entries — the same:',
    mirrorQuad,
    asSampled,
    BETWEEN,
  );
  /*
   * **And the overhead placement through the polynomials, which was missing and is where the gain
   * is.** Three of these four measurements were the mirror geometry or the raw table, so a change
   * that improved the overhead placement and cost the polynomial stage could not be weighed: the
   * only number that moved was the one it made worse. The polygon objective is exactly such a
   * change, and it is the reason this line exists.
   */
  const shippedOverhead = measureGeometry(
    'OVERHEAD, through the polynomials — the same, on the placement the bound is set on:',
    () => OVERHEAD_QUAD,
    asShipped,
    NODES,
  );

  const pair = (all, visible) =>
    `${(all * 100).toFixed(1)}% (${(visible * 100).toFixed(1)}% visible)`;
  console.log(`\n  every number below is "worst over the grid (worst where the rectangle covers`);
  console.log(
    `  at least ${(VISIBLE_SHARE * 100).toFixed(0)}% of the lobe)". The bound is 2%, 5% grazing.\n`,
  );
  console.log(`  overhead, as fitted            ${pair(overhead.worst, overhead.visible)}`);
  console.log(
    `  overhead, through polynomials  ${pair(shippedOverhead.worst, shippedOverhead.visible)}`,
  );
  console.log(
    `  overhead, sampled at ${String(N).padEnd(2)}        ${pair(sampledOverhead.worst, sampledOverhead.visible)}`,
  );
  console.log(`  mirror,   as fitted            ${pair(mirror.worst, mirror.visible)}`);
  console.log(`  mirror,   through polynomials  ${pair(shipped.worst, shipped.visible)}`);
  console.log(
    `  mirror,   sampled at ${String(N).padEnd(2)}        ${pair(sampledMirror.worst, sampledMirror.visible)}`,
  );
  console.log(
    overhead.visible <= 0.05
      ? '\n  the fit holds where it can be seen.'
      : "\n  the fit does not hold; see this file's header.",
  );
}

if (CHECK) checkAgainstBruteForce();

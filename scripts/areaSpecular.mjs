#!/usr/bin/env node
/**
 * What an area light's specular term should be, measured against the integral it approximates.
 *
 * **Run by hand, not by a gate**, like `ltcFit.mjs` beside it, and for the same reason: it decides
 * the shape of a shader term rather than guarding one.
 *
 * ## Why this exists
 *
 * `docs/CAPABILITIES.md` described the representative point as diverging from a fitted LTC "at
 * grazing angles, where the real lobe stretches along the view and a point cannot". Measured
 * against a brute-force integral, what it actually does is **lose the reflection**: on a smooth
 * surface reflecting a rectangle it returns 0.000233 where the integral is 0.9207, and head-on on a
 * rough one it is several times too bright. Nobody had put the two side by side.
 *
 * ## What is measured
 *
 * The reference is `∫ BRDF·cos` over the rectangle, by area sampling, at `REFERENCE_SAMPLES` a
 * side. Two placements, because one of them on its own is misleading:
 *
 * - **overhead**, a rectangle straight up, which at grazing incidence lands in the lobe's far tail;
 * - **mirror**, the same rectangle centred on the mirror direction, which is a softbox reflected in
 *   polished metal and is the case an area light is reached for.
 *
 * **Every error is printed beside the share of the surface's own albedo that cell carries**, and the
 * summary reports the worst twice: over every cell, and over cells a viewer could see. A relative
 * error against a reference that goes to zero is not a bound, and this file's subject spent two
 * sessions being steered by one.
 *
 * ## What the candidates are
 *
 * - `shipped` — `sphereLobe` at the closest point on the rectangle, times `ndl`, times the
 *   rectangle's *diffuse* form factor, which is what `main.ts` adds today.
 * - `coverage` — the surface's own specular albedo times the fraction of the lobe the rectangle
 *   covers. The fraction is a form factor taken in a space where the lobe is a clamped cosine:
 *   stretch the polygon across the lobe's dominant direction by the lobe's own width and the
 *   ordinary polygon form factor answers it. **A linearly transformed cosine with an analytic
 *   matrix instead of a fitted one** — no tables, no texture unit, and the two pieces it needs
 *   (`quadFormFactor` and the environment BRDF) are already in the shader.
 *
 * The scale law was measured rather than chosen: fitting one isotropic scale per grid entry against
 * the lobe puts it at **2·α** for α up to about a quarter and **1.15·α** at α = 1, so the shipped
 * law interpolates between those.
 */

import { pathToFileURL } from 'node:url';

import {
  OVERHEAD_QUAD,
  dominantDirection,
  dot,
  frameOf,
  lobeScale,
  brdf,
  integrateOverQuad,
  quadFacing,
  quadFormFactorClipped,
  representativePoint,
  sampleGgx,
} from './lobeMath.mjs';

/**
 * How finely the reference integral samples the rectangle, per side.
 *
 * A near-delta lobe landing inside the quad is what sets this: at 96 a side the reference read 0.549
 * where the converged value is 0.997 and charged a candidate 81% for its own under-sampling.
 */
const REFERENCE_SAMPLES = 512;

/** Below this roughness the lobe is a delta and no area-sampled reference resolves it. */
const MEASURABLE_ROUGHNESS = 0.1;

/** Below this view cosine the surface is edge-on, where every specular model is singular. */
const MEASURABLE_COSINE = 0.1;

/** Cells carrying less of the albedo than this are the tail, and a relative error there is noise. */
const VISIBLE_SHARE = 0.01;

/** The lobe's directional albedo, by sampling. What a rectangle covering the whole lobe returns. */
export function albedoOf(v, alpha) {
  let sum = 0;
  const n = 128;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const l = sampleGgx((i + 0.5) / n, (j + 0.5) / n, v, alpha);
      const b = brdf(l, v, alpha);
      if (b.pdf <= 1e-9) continue;
      sum += b.value / b.pdf;
    }
  }
  return sum / (n * n);
}

/**
 * Karis's environment BRDF fit, transcribed from `lobes.ts`, at `f0` of one.
 *
 * The candidate uses this rather than the sampled albedo, because it is what the shader has. It
 * costs accuracy and the summary prints both so the cost is on the record.
 */
export function envBrdfApprox(ndv, roughness) {
  const c0 = [-1, -0.0275, -0.572, 0.022];
  const c1 = [1, 0.0425, 1.04, -0.04];
  const r = c0.map((c, i) => roughness * c + c1[i]);
  const a004 = Math.min(r[0] * r[0], Math.pow(2, -9.28 * ndv)) * r[0] + r[1];
  return [a004 * -1.04 + r[2], a004 * 1.04 + r[3]];
}

/**
 * Fdez-Agüera's multiple-scattering compensation, transcribed from `lobes.ts`. **Measured, and it
 * belongs to the environment path rather than to this one.**
 *
 * The reasoning that put it here was that `dfg.x + dfg.y` integrates a single scattering event and
 * comes to `1 - 0.55 * roughness`, which the engine already corrects for a probe. Measured against
 * this reference it is **worse**: 211.3% against 40.1%, at roughness 1 head-on.
 *
 * The reference is the honest reason. `brdf` here is single-scattering GGX with height-correlated
 * Smith and no compensation, which is also what the direct lighting in `main.ts` computes, so its
 * albedo *is* what `dfg.x + dfg.y` approximates. Returning the multiply-scattered share on top of it
 * returns energy the lobe being integrated never had. It is kept as a candidate because the
 * reasoning for it is good enough that somebody will have it again.
 */
export function envSpecularEnergy(f0, dfg) {
  const single = f0 * dfg[0] + dfg[1];
  const energy = dfg[0] + dfg[1];
  const missing = 1 - energy;
  const average = f0 + (1 - f0) / 21;
  const multi = (single * average) / (1 - missing * average);
  return single + multi * missing;
}

/**
 * The fraction of the lobe a rectangle covers.
 *
 * A clamped-cosine integral over the polygon transformed into the space where the lobe *is* a
 * clamped cosine, which is the whole idea a linearly transformed cosine rests on. The transform
 * here is analytic rather than fitted: an orthonormal frame on the lobe's direction, scaled across
 * it by the lobe's width.
 */
export function coverageOf(quad, v, alpha) {
  const [T, B, Z] = frameOf(dominantDirection(v, alpha));
  const inverse = 1 / Math.max(lobeScale(alpha), 1e-4);
  const local = quad.map((c) => [dot(c, T) * inverse, dot(c, B) * inverse, dot(c, Z)]);
  /* Clipped in the transformed space, which is where a transformed cosine's horizon is, and with
     the same function the shader runs so the number below is the number that would ship. */
  return Math.max(quadFormFactorClipped([0, 0, 1], [0, 0, 0], local), 0);
}

export const CANDIDATES = {
  shipped: (quad, v, roughness) => representativePoint(quad, v, roughness),
  'coverage, sampled albedo': (quad, v, roughness, alpha, albedo) =>
    albedo * coverageOf(quad, v, alpha),
  'coverage, env brdf': (quad, v, roughness, alpha) =>
    (envBrdfApprox(v[2], roughness)[0] + envBrdfApprox(v[2], roughness)[1]) *
    coverageOf(quad, v, alpha),
  'coverage, energy': (quad, v, roughness, alpha) =>
    envSpecularEnergy(1, envBrdfApprox(v[2], roughness)) * coverageOf(quad, v, alpha),
};

const NAMES = Object.keys(CANDIDATES);
const VERBOSE = process.argv.includes('--verbose');

/** The placements, exported so the gate beside this measures exactly what the report does. */
export const PLACEMENTS = {
  overhead: () => OVERHEAD_QUAD,
  mirror: (v) => quadFacing([-v[0], -v[1], v[2]]),
};

export function measure(label, quadFor, step = 3) {
  console.log(`\n${label}`);
  if (VERBOSE) {
    console.log(
      '  roughness cos     brute       share    ' + NAMES.map((n) => n.padEnd(26)).join(''),
    );
  }
  const stat = Object.fromEntries(
    NAMES.map((n) => [n, { all: 0, allAt: null, visible: 0, visibleAt: null }]),
  );

  for (let ri = 0; ri <= 31; ri += step) {
    for (let ti = 0; ti <= 31; ti += step) {
      const roughness = 1 - ri / 31;
      const t = ti / 31;
      const cosTheta = Math.max(1 - t * t, 1e-3);
      const alpha = Math.max(roughness * roughness, 1e-3);
      const sin = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
      const v = [sin, 0, cosTheta];
      const quad = quadFor(v);

      const reference = integrateOverQuad(quad, (l) => brdf(l, v, alpha).value, REFERENCE_SAMPLES);
      const albedo = albedoOf(v, alpha);
      const share = reference / Math.max(albedo, 1e-9);

      const cells = NAMES.map((n) => {
        const got = CANDIDATES[n](quad, v, roughness, alpha, albedo);
        const error = Math.abs(got - reference) / Math.max(reference, 1e-12);
        const s = stat[n];
        if (error > s.all) {
          s.all = error;
          s.allAt = [roughness, cosTheta, share];
        }
        if (
          share >= VISIBLE_SHARE &&
          cosTheta >= MEASURABLE_COSINE &&
          roughness >= MEASURABLE_ROUGHNESS &&
          error > s.visible
        ) {
          s.visible = error;
          s.visibleAt = [roughness, cosTheta, share];
        }
        return { got, error };
      });

      if (VERBOSE) {
        console.log(
          `  ${roughness.toFixed(3).padEnd(9)}${cosTheta.toFixed(3).padEnd(7)} ` +
            `${reference.toFixed(6).padEnd(11)} ${(share * 100).toFixed(2).padStart(6)}%  ` +
            cells
              .map((c) => `${c.got.toFixed(6)} ${(c.error * 100).toFixed(1).padStart(7)}%   `)
              .join(''),
        );
      }
    }
  }

  const where = (x) =>
    x === null
      ? '—'
      : `roughness ${x[0].toFixed(2)}, cos ${x[1].toFixed(2)}, ${(x[2] * 100).toFixed(2)}% of albedo`;
  console.log(
    `  worst over every cell, and over cells with roughness >= ${MEASURABLE_ROUGHNESS}, ` +
      `cos >= ${MEASURABLE_COSINE} and >= ${VISIBLE_SHARE * 100}% of the albedo:`,
  );
  for (const n of NAMES) {
    const s = stat[n];
    console.log(
      `    ${n.padEnd(26)} all ${(s.all * 100).toFixed(1).padStart(9)}%  (${where(s.allAt)})`,
    );
    console.log(
      `    ${''.padEnd(26)} vis ${(s.visible * 100).toFixed(1).padStart(9)}%  (${where(s.visibleAt)})`,
    );
  }
  return stat;
}

/* Run as a program; imported by `areaSpecular.test.mjs`, which asserts the claims below. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  measure('OVERHEAD — a two-metre rectangle two metres straight up:', PLACEMENTS.overhead);
  measure(
    'MIRROR — the same rectangle centred on the mirror direction, which is what a softbox is:',
    PLACEMENTS.mirror,
  );

  console.log(
    '\n  A perfect mirror and an edge-on surface are excluded from the second figure and not from the\n' +
      '  first: at roughness 0 the lobe is a delta no area-sampled reference resolves, and at cos 0 the\n' +
      '  surface covers no pixels. Both are printed so neither is hidden.',
  );
}

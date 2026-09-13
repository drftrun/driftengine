/**
 * The GGX lobe, and the geometry every measurement of an area light needs.
 *
 * **Extracted so there is one BRDF rather than two.** `ltcFit.mjs` fits a transformed cosine to this
 * lobe and `areaSpecular.mjs` measures what the shader computes against an integral of it; a second
 * copy of `brdf` would let those two answer differently about the same surface, which is the failure
 * that makes a pair of measurement scripts worse than one.
 *
 * Everything here is a density or an integral over one, in a frame where the surface normal is +Z
 * and the view lies in the xz plane, which an isotropic lobe makes general.
 */

/** The two vector helpers everything below needs, exported so a caller shares one definition. */
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const normalise = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return a.map((x) => x / l);
};

/** Trowbridge-Reitz, in its own normalisation, because this is a density. */
export function ggxD(ndh, alpha) {
  const a2 = alpha * alpha;
  const d = ndh * ndh * (a2 - 1) + 1;
  return a2 / Math.max(Math.PI * d * d, 1e-12);
}

/** Smith's lambda for GGX, the height-correlated form's building block. */
export function lambda(cosTheta, alpha) {
  const c = Math.max(cosTheta, 1e-6);
  const tan2 = (1 - c * c) / (c * c);
  return 0.5 * (-1 + Math.sqrt(1 + alpha * alpha * tan2));
}

/**
 * The cosine-weighted BRDF and the density that samples it.
 *
 * `V` is in the xz plane by construction — the fit is isotropic, so the only thing a view
 * direction carries is its angle from the normal.
 */
export function brdf(l, v, alpha) {
  const ndl = l[2];
  const ndv = v[2];
  if (ndl <= 0 || ndv <= 0) return { value: 0, pdf: 0 };
  let hx = l[0] + v[0];
  let hy = l[1] + v[1];
  let hz = l[2] + v[2];
  const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
  hx /= hl;
  hy /= hl;
  hz /= hl;
  const ndh = Math.max(hz, 0);
  const vdh = Math.max(v[0] * hx + v[1] * hy + v[2] * hz, 1e-6);
  const d = ggxD(ndh, alpha);
  const g2 = 1 / (1 + lambda(ndv, alpha) + lambda(ndl, alpha));
  /* Cosine-weighted: the `ndl` of the reflectance integral is folded in, so this is what a
     transformed cosine has to match shape for shape. */
  return { value: (d * g2) / (4 * ndv), pdf: (d * ndh) / (4 * vdh) };
}

/** A half vector drawn from the GGX distribution, for the importance-sampled half of the score. */
export function sampleGgx(u1, u2, v, alpha) {
  const phi = 2 * Math.PI * u1;
  const cosTheta = Math.sqrt((1 - u2) / (1 + (alpha * alpha - 1) * u2));
  const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
  const h = [sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta];
  const vdh = v[0] * h[0] + v[1] * h[1] + v[2] * h[2];
  return [2 * vdh * h[0] - v[0], 2 * vdh * h[1] - v[1], 2 * vdh * h[2] - v[2]];
}

/** A two-metre square, two metres away, centred on `dir` and facing back at the origin. */
export function quadFacing(dir) {
  const centre = dir.map((x) => x * 2);
  const up = Math.abs(dir[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  let t = [
    up[1] * dir[2] - up[2] * dir[1],
    up[2] * dir[0] - up[0] * dir[2],
    up[0] * dir[1] - up[1] * dir[0],
  ];
  const tl = Math.hypot(t[0], t[1], t[2]) || 1;
  t = t.map((x) => x / tl);
  const b = [
    dir[1] * t[2] - dir[2] * t[1],
    dir[2] * t[0] - dir[0] * t[2],
    dir[0] * t[1] - dir[1] * t[0],
  ];
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([su, sv]) => [0, 1, 2].map((k) => centre[k] + su * t[k] + sv * b[k]));
}

/** The cosine-weighted solid angle of a polygon, which is the integral a transformed cosine has. */
export function quadFormFactor(corners) {
  const u = corners.map((c) => {
    const l = Math.hypot(c[0], c[1], c[2]) || 1;
    return [c[0] / l, c[1] / l, c[2] / l];
  });
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = u[i];
    const b = u[(i + 1) % 4];
    const cosA = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const cl = Math.hypot(cr[0], cr[1], cr[2]) || 1;
    sum += Math.acos(cosA) * (cr[2] / cl);
  }
  return Math.abs(sum) / (2 * Math.PI);
}

/** Integrate any per-direction quantity over a quad, by area sampling. */
export function integrateOverQuad(quad, f, samples) {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const u = (i + 0.5) / samples;
      const w = (j + 0.5) / samples;
      const p = [0, 1, 2].map(
        (k) =>
          (1 - u) * ((1 - w) * quad[0][k] + w * quad[3][k]) +
          u * ((1 - w) * quad[1][k] + w * quad[2][k]),
      );
      const len = Math.hypot(p[0], p[1], p[2]);
      const l = [p[0] / len, p[1] / len, p[2] / len];
      if (l[2] <= 0) continue;
      const du = [0, 1, 2].map(
        (k) => ((1 - w) * (quad[1][k] - quad[0][k]) + w * (quad[2][k] - quad[3][k])) / samples,
      );
      const dw = [0, 1, 2].map(
        (k) => ((1 - u) * (quad[3][k] - quad[0][k]) + u * (quad[2][k] - quad[1][k])) / samples,
      );
      const cr = [
        du[1] * dw[2] - du[2] * dw[1],
        du[2] * dw[0] - du[0] * dw[2],
        du[0] * dw[1] - du[1] * dw[0],
      ];
      const area = Math.hypot(cr[0], cr[1], cr[2]);
      const cosPatch = Math.abs((cr[0] * l[0] + cr[1] * l[1] + cr[2] * l[2]) / (area || 1));
      sum += (f(l) * area * cosPatch) / (len * len);
    }
  }
  return sum;
}

/** `sphereLobe`, transcribed from `lobes.ts`. See this section's header about the copy. */
export function sphereLobe(ndh, roughness, sourceRadius, dist) {
  const a = Math.max(roughness * roughness, 1e-3);
  const widened = Math.min(1, Math.max(a, a + sourceRadius / Math.max(2 * dist, 1e-3)));
  const energy = (a / widened) * (a / widened);
  const w2 = widened * widened;
  const d = ndh * ndh * (w2 - 1) + 1;
  return (energy * (w2 * w2)) / Math.max(d * d, 1e-8);
}

/**
 * What `main.ts` adds for one area light's specular, with colour, Fresnel and occlusion at one.
 *
 * The surface is at the origin with normal +Z, which is the frame the whole fit is in.
 */
export function representativePoint(quad, v, roughness) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const centre = [0, 1, 2].map((k) => (quad[0][k] + quad[1][k] + quad[2][k] + quad[3][k]) / 4);
  let right = [0, 1, 2].map((k) => (quad[1][k] - quad[0][k]) / 2);
  let up = [0, 1, 2].map((k) => (quad[3][k] - quad[0][k]) / 2);
  const hx = Math.hypot(right[0], right[1], right[2]);
  const hy = Math.hypot(up[0], up[1], up[2]);
  right = right.map((x) => x / hx);
  up = up.map((x) => x / hy);

  /* `reflect(-toEye, n)` for a normal of +Z. */
  const mirrorRay = [-v[0], -v[1], -v[2] + 2 * v[2]];
  let planeNormal = cross(right, up);
  const pl = Math.hypot(planeNormal[0], planeNormal[1], planeNormal[2]) || 1;
  planeNormal = planeNormal.map((x) => x / pl);
  const denom = dot(mirrorRay, planeNormal);
  let hit = centre.slice();
  if (Math.abs(denom) > 1e-4) {
    const t = dot(centre, planeNormal) / denom;
    if (t > 0) hit = mirrorRay.map((x) => x * t);
  }
  const offset = [0, 1, 2].map((k) => hit[k] - centre[k]);
  const x = Math.min(hx, Math.max(-hx, dot(offset, right)));
  const y = Math.min(hy, Math.max(-hy, dot(offset, up)));
  const nearest = [0, 1, 2].map((k) => centre[k] + right[k] * x + up[k] * y);

  const areaDist = Math.hypot(nearest[0], nearest[1], nearest[2]);
  const areaL = nearest.map((c) => c / Math.max(areaDist, 1e-4));
  const areaNdl = Math.max(areaL[2], 0);
  if (areaNdl <= 0) return 0;
  let half = [0, 1, 2].map((k) => areaL[k] + v[k]);
  const hl = Math.hypot(half[0], half[1], half[2]) || 1;
  half = half.map((c) => c / hl);
  const lobe = sphereLobe(Math.max(half[2], 0), roughness, Math.min(hx, hy), areaDist);
  return lobe * areaNdl * quadFormFactor(quad);
}

/** A two-metre square two metres straight overhead, which is one of the two placements measured. */
export const OVERHEAD_QUAD = [
  [-1, -1, 2],
  [1, -1, 2],
  [1, 1, 2],
  [-1, 1, 2],
];

/**
 * The same, clipped to the horizon and signed, which is exactly what `lobes.ts` computes.
 *
 * **The shader's version is the one a shipped term is judged by**, so a candidate measured with the
 * unclipped form above is measuring a function nothing runs. A polygon partly below the plane must
 * contribute only the part above it, and corners below it are projected onto it rather than dropped
 * — dropping one leaves the polygon open and the sum meaningless.
 */
export function quadFormFactorClipped(n, p, corners) {
  const sub = (c) => [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const v = corners.map(sub);
  const d = v.map((x) => dot(x, n));
  if (d.every((x) => x < 0)) return 0;
  for (let i = 0; i < 4; i++) {
    const m = Math.min(d[i], 0);
    v[i] = [v[i][0] - n[0] * m, v[i][1] - n[1] * m, v[i][2] - n[2] * m];
  }
  const u = v.map((x) => {
    const l = Math.hypot(x[0], x[1], x[2]) || 1;
    return [x[0] / l, x[1] / l, x[2] / l];
  });
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = u[i];
    const b = u[(i + 1) % 4];
    const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const cl = Math.hypot(cr[0], cr[1], cr[2]) || 1;
    sum +=
      Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) *
      dot([cr[0] / cl, cr[1] / cl, cr[2] / cl], n);
  }
  return sum / (2 * Math.PI);
}

/** An orthonormal frame whose Z is `d`. */
export function frameOf(d) {
  const up = Math.abs(d[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1];
  const t = normalise([
    up[1] * d[2] - up[2] * d[1],
    up[2] * d[0] - up[0] * d[2],
    up[0] * d[1] - up[1] * d[0],
  ]);
  const b = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
  return [t, b, d];
}

/**
 * Where the lobe points, which is the mirror ray only while the surface is smooth.
 *
 * At roughness 1 the lobe is broad and leans back toward the normal, and a frame on the mirror ray
 * then measures the wrong solid angle — worth 213% against 42% on the mirror placement when it was
 * measured both ways. The standard cheap interpolation, and the same one the sampled lobe direction
 * gives to within a per cent, which is how it was checked.
 */
export function dominantDirection(v, alpha) {
  const mirror = [-v[0], -v[1], v[2]];
  const t = (1 - alpha) * (Math.sqrt(1 - alpha) + alpha);
  return normalise([mirror[0] * t, mirror[1] * t, mirror[2] * t + (1 - t)]);
}

/**
 * How wide the transformed cosine is, per unit of the lobe's own width.
 *
 * Measured: fitting one isotropic scale per grid entry against the lobe, bracketed so the search
 * cannot fall into the basin that fits the tail rather than the body, lands at **2·α** for α up to
 * about a quarter and **1.15·α** at α = 1.
 */
export function lobeScale(alpha) {
  return alpha * (1.15 + 0.85 * (1 - alpha));
}

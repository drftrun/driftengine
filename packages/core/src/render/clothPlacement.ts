/**
 * Where a cloth-bound vertex goes: the reference for what the vertex stage computes.
 *
 * A render vertex bound to a simulation triangle (particles a, b, c) sits at its barycentric point
 * — `a·(1 − u − v) + b·u + c·v` — raised `offset` along the triangle's normal; its normal turns as
 * the triangle turned since rest. The turn is the rotation from the triangle's rest frame
 * to its frame now, each frame built from its first edge and its normal, so a vertex beside the
 * triangle, a fold's width away, moves as the cloth moves rather than as its skeleton does.
 *
 * **A vertex bound to one particle** — all three indices equal — sits on it and keeps its normal:
 * a single point has no frame to turn by. That is how a binding says "follow this particle".
 *
 * **A reference, as `recon/motionVectors.ts` is**: nothing at run time calls it. The vertex stage in
 * `shaders/clothBinding.ts` and the cloth motion stage in `shaders/recon/motion.wgsl.ts` are the
 * same arithmetic for the device, and nothing but a device holds them to this — the source tests
 * pin where the shader moves a vertex, not the numbers it moves it by. `demo/dev/skinnedCloth.html`
 * is where the two backends were compared, and they agree to two levels in 255.
 */

/** Where a placement lands, written into caller-owned arrays. */
export interface ClothPlacement {
  readonly position: Float64Array;
  readonly normal: Float64Array;
}

const NOW = new Float64Array(9);
const REST = new Float64Array(9);

/** A triangle's frame — first edge, normal × edge, normal — as three columns, into `out`. */
function frame(
  particles: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  out: Float64Array,
): void {
  const ex = (particles[b * 3] as number) - (particles[a * 3] as number);
  const ey = (particles[b * 3 + 1] as number) - (particles[a * 3 + 1] as number);
  const ez = (particles[b * 3 + 2] as number) - (particles[a * 3 + 2] as number);
  const fx = (particles[c * 3] as number) - (particles[a * 3] as number);
  const fy = (particles[c * 3 + 1] as number) - (particles[a * 3 + 1] as number);
  const fz = (particles[c * 3 + 2] as number) - (particles[a * 3 + 2] as number);
  let nx = ey * fz - ez * fy;
  let ny = ez * fx - ex * fz;
  let nz = ex * fy - ey * fx;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
  const tx = ex / el;
  const ty = ey / el;
  const tz = ez / el;
  out[0] = tx;
  out[1] = ty;
  out[2] = tz;
  out[3] = ny * tz - nz * ty;
  out[4] = nz * tx - nx * tz;
  out[5] = nx * ty - ny * tx;
  out[6] = nx;
  out[7] = ny;
  out[8] = nz;
}

/** Place one vertex: `now` and `rest` are particle positions, three floats each. */
export function clothPlace(
  now: ArrayLike<number>,
  rest: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  u: number,
  v: number,
  offset: number,
  restNormal: readonly [number, number, number],
  out: ClothPlacement,
): void {
  if (a === b && b === c) {
    out.position[0] = now[a * 3] as number;
    out.position[1] = now[a * 3 + 1] as number;
    out.position[2] = now[a * 3 + 2] as number;
    out.normal[0] = restNormal[0];
    out.normal[1] = restNormal[1];
    out.normal[2] = restNormal[2];
    return;
  }
  frame(now, a, b, c, NOW);
  frame(rest, a, b, c, REST);
  const w = 1 - u - v;
  for (let k = 0; k < 3; k++) {
    out.position[k] =
      (now[a * 3 + k] as number) * w +
      (now[b * 3 + k] as number) * u +
      (now[c * 3 + k] as number) * v +
      (NOW[6 + k] as number) * offset;
  }
  /* Turned by now × restᵀ: the rest normal in the rest frame's terms, rebuilt in the frame now. */
  const t =
    (REST[0] as number) * restNormal[0] +
    (REST[1] as number) * restNormal[1] +
    (REST[2] as number) * restNormal[2];
  const s =
    (REST[3] as number) * restNormal[0] +
    (REST[4] as number) * restNormal[1] +
    (REST[5] as number) * restNormal[2];
  const n =
    (REST[6] as number) * restNormal[0] +
    (REST[7] as number) * restNormal[1] +
    (REST[8] as number) * restNormal[2];
  for (let k = 0; k < 3; k++) {
    out.normal[k] =
      (NOW[k] as number) * t + (NOW[3 + k] as number) * s + (NOW[6 + k] as number) * n;
  }
}

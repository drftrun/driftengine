/**
 * Where a skeleton puts a skinned cloth: each particle's skinned position and normal, each
 * collider's ends, and the share of the character's own motion a free particle is carried by.
 *
 * **From joint globals and inverse binds, not from a skin palette.** A palette is `global × inverse
 * bind` and is all skinning needs, but a collider sits on a joint's own frame, which only the
 * global gives; taking both pieces lets one pose serve both. Model space throughout, then the model
 * matrix, so the cloth simulates in the world and a turn swings it.
 *
 * **Normals are carried by each joint's upper 3×3**, not its inverse transpose: right for the
 * rotations and uniform scales a rig is made of, and wrong for a sheared or non-uniformly scaled
 * joint, which a garment's rig does not have. Renormalised after blending.
 *
 * Allocation-free: everything writes into arrays handed in.
 */
import { exactCos } from './exact.ts';

/** `a × b` into `out` at `at`, column-major 4×4. `out` may not alias either. */
export function multiply4(
  a: ArrayLike<number>,
  aAt: number,
  b: ArrayLike<number>,
  bAt: number,
  out: Float32Array,
  at: number,
): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[aAt + k * 4 + r] as number) * (b[bAt + c * 4 + k] as number);
      }
      out[at + c * 4 + r] = sum;
    }
  }
}

/** `model × global_j × inverseBind_j` for every joint, into `skin`. */
export function skinMatrices(
  globals: Float32Array,
  inverseBind: Float32Array,
  model: Float32Array,
  scratch: Float32Array,
  skin: Float32Array,
): void {
  const joints = inverseBind.length / 16;
  for (let j = 0; j < joints; j++) {
    multiply4(globals, j * 16, inverseBind, j * 16, scratch, 0);
    multiply4(model, 0, scratch, 0, skin, j * 16);
  }
}

/**
 * Each particle's skinned position and normal, by up to eight influences, into `position` and
 * `normal`. Without a rig (`skin` null), the rest pose under the model matrix alone.
 */
export function skinParticles(
  rest: Float32Array,
  restNormal: Float32Array | null,
  joints: Float32Array | null,
  weights: Float32Array | null,
  joints2: Float32Array | null,
  weights2: Float32Array | null,
  skin: Float32Array | null,
  model: Float32Array,
  position: Float32Array,
  normal: Float32Array,
): void {
  const count = rest.length / 3;
  for (let i = 0; i < count; i++) {
    const x = rest[i * 3] as number;
    const y = rest[i * 3 + 1] as number;
    const z = rest[i * 3 + 2] as number;
    const nx = restNormal === null ? 0 : (restNormal[i * 3] as number);
    const ny = restNormal === null ? 0 : (restNormal[i * 3 + 1] as number);
    const nz = restNormal === null ? 1 : (restNormal[i * 3 + 2] as number);
    let px = 0;
    let py = 0;
    let pz = 0;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    if (skin === null || joints === null || weights === null) {
      const m = model;
      px = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
      py = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
      pz = (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
      qx = (m[0] as number) * nx + (m[4] as number) * ny + (m[8] as number) * nz;
      qy = (m[1] as number) * nx + (m[5] as number) * ny + (m[9] as number) * nz;
      qz = (m[2] as number) * nx + (m[6] as number) * ny + (m[10] as number) * nz;
    } else {
      for (let set = 0; set < 2; set++) {
        const js = set === 0 ? joints : joints2;
        const ws = set === 0 ? weights : weights2;
        if (js === null || ws === null) continue;
        for (let k = 0; k < 4; k++) {
          const w = ws[i * 4 + k] as number;
          if (w === 0) continue;
          const m = (js[i * 4 + k] as number) * 16;
          px +=
            w *
            ((skin[m] as number) * x +
              (skin[m + 4] as number) * y +
              (skin[m + 8] as number) * z +
              (skin[m + 12] as number));
          py +=
            w *
            ((skin[m + 1] as number) * x +
              (skin[m + 5] as number) * y +
              (skin[m + 9] as number) * z +
              (skin[m + 13] as number));
          pz +=
            w *
            ((skin[m + 2] as number) * x +
              (skin[m + 6] as number) * y +
              (skin[m + 10] as number) * z +
              (skin[m + 14] as number));
          qx +=
            w *
            ((skin[m] as number) * nx +
              (skin[m + 4] as number) * ny +
              (skin[m + 8] as number) * nz);
          qy +=
            w *
            ((skin[m + 1] as number) * nx +
              (skin[m + 5] as number) * ny +
              (skin[m + 9] as number) * nz);
          qz +=
            w *
            ((skin[m + 2] as number) * nx +
              (skin[m + 6] as number) * ny +
              (skin[m + 10] as number) * nz);
        }
      }
    }
    position[i * 3] = px;
    position[i * 3 + 1] = py;
    position[i * 3 + 2] = pz;
    const length = Math.sqrt(qx * qx + qy * qy + qz * qz);
    const inverse = length > 1e-12 ? 1 / length : 0;
    normal[i * 3] = qx * inverse;
    normal[i * 3 + 1] = qy * inverse;
    normal[i * 3 + 2] = qz * inverse;
  }
}

/**
 * Each collider's two ends in the world, six floats a collider: `model × global × frame` applied to
 * the frame's origin and to `length` along its +Z. A sphere's two ends are one point.
 */
export function placeColliders(
  colliders: readonly {
    readonly joint: number;
    readonly length?: number;
    readonly frame?: Float32Array;
  }[],
  globals: Float32Array,
  model: Float32Array,
  scratch: Float32Array,
  ends: Float32Array,
): void {
  for (let k = 0; k < colliders.length; k++) {
    const collider = colliders[k] as (typeof colliders)[number];
    multiply4(model, 0, globals, collider.joint * 16, scratch, 0);
    const frame = collider.frame;
    if (frame !== undefined) {
      multiply4(scratch, 0, frame, 0, scratch, 16);
      scratch.copyWithin(0, 16, 32);
    }
    const length = collider.length ?? 0;
    for (let c = 0; c < 3; c++) {
      const origin = scratch[12 + c] as number;
      ends[k * 6 + c] = origin;
      ends[k * 6 + 3 + c] = origin + (scratch[8 + c] as number) * length;
    }
  }
}

/**
 * Carry free particles by the share of the character's motion they do not keep as their own.
 *
 * The character moved by `next × previous⁻¹`: a rotation about its old origin and a move of that
 * origin. A particle is moved by `1 − angularInertia` of the first and `1 − linearInertia` of the
 * second, its velocity turned by the same share — so inertia 1 leaves the cloth in the world and 0
 * moves it as if it were simulated in the character's space. **A blend of the rotated point, not a
 * fraction of the angle**, which is exact at the two ends and, for the few degrees a character turns
 * in a step, indistinguishable between them; it needs no trigonometry, so it is the same bits on
 * every engine. Both matrices rigid.
 */
export function carryParticles(
  position: Float32Array,
  velocity: Float32Array,
  inverseMass: Float32Array,
  previous: Float32Array,
  next: Float32Array,
  linearInertia: number,
  angularInertia: number,
): void {
  const turn = 1 - angularInertia;
  const move = 1 - linearInertia;
  if (turn === 0 && move === 0) return;
  /* R = R_next × R_previousᵀ, row r column c at r + c·3. */
  const r = ROTATION;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++)
        sum += (next[k * 4 + row] as number) * (previous[k * 4 + col] as number);
      r[row + col * 3] = sum;
    }
  }
  const ox = previous[12] as number;
  const oy = previous[13] as number;
  const oz = previous[14] as number;
  const dx = ((next[12] as number) - ox) * move;
  const dy = ((next[13] as number) - oy) * move;
  const dz = ((next[14] as number) - oz) * move;
  for (let i = 0; i < inverseMass.length; i++) {
    if ((inverseMass[i] as number) === 0) continue;
    const at = i * 3;
    const x = (position[at] as number) - ox;
    const y = (position[at + 1] as number) - oy;
    const z = (position[at + 2] as number) - oz;
    position[at] =
      (position[at] as number) +
      ((r[0] as number) * x + (r[3] as number) * y + (r[6] as number) * z - x) * turn +
      dx;
    position[at + 1] =
      (position[at + 1] as number) +
      ((r[1] as number) * x + (r[4] as number) * y + (r[7] as number) * z - y) * turn +
      dy;
    position[at + 2] =
      (position[at + 2] as number) +
      ((r[2] as number) * x + (r[5] as number) * y + (r[8] as number) * z - z) * turn +
      dz;
    const vx = velocity[at] as number;
    const vy = velocity[at + 1] as number;
    const vz = velocity[at + 2] as number;
    velocity[at] =
      vx + ((r[0] as number) * vx + (r[3] as number) * vy + (r[6] as number) * vz - vx) * turn;
    velocity[at + 1] =
      vy + ((r[1] as number) * vx + (r[4] as number) * vy + (r[7] as number) * vz - vy) * turn;
    velocity[at + 2] =
      vz + ((r[2] as number) * vx + (r[5] as number) * vy + (r[8] as number) * vz - vz) * turn;
  }
}

const ROTATION = new Float64Array(9);

/**
 * How far the character jumped between two poses: its origin's distance and its rotation's angle.
 * The angle through `trace`, `cos θ = (tr R − 1) / 2`, compared as a cosine, through `exactCos` so
 * every engine draws the line in one place.
 */
export function jumped(
  previous: Float32Array,
  next: Float32Array,
  distance: number,
  angle: number,
): boolean {
  const dx = (next[12] as number) - (previous[12] as number);
  const dy = (next[13] as number) - (previous[13] as number);
  const dz = (next[14] as number) - (previous[14] as number);
  if (dx * dx + dy * dy + dz * dz > distance * distance) return true;
  if (!(angle < Math.PI)) return false;
  let trace = 0;
  for (let d = 0; d < 3; d++) {
    for (let k = 0; k < 3; k++)
      trace += (next[k * 4 + d] as number) * (previous[k * 4 + d] as number);
  }
  return (trace - 1) / 2 < exactCos(angle);
}

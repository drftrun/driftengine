/**
 * The skinned cloth's kernels: one substep's prediction, each kind of constraint over one batch, and
 * the velocities a substep leaves.
 *
 * **Plain functions over flat arrays, one per GPU dispatch.** The WebGPU solver runs the same steps
 * as compute passes over the same arrays, and its WGSL is written to be read beside this file: a
 * kernel here is a thread's body there, the batch loop is the dispatch. Keeping them that shape is
 * what lets the device parity check compare like with like.
 *
 * **XPBD throughout**: a constraint's compliance becomes `α = compliance / h²`, and its multiplier
 * accumulates over the substep's iterations, so stiffness is a property of the cloth rather than of
 * how many times it was iterated — §7 of the physics design, as `cloth.ts` states it.
 *
 * Allocation-free: every kernel writes into arrays it is handed.
 */
import { exactAcos } from './exact.ts';

/** A particle's predicted position: damping and drag, then gravity, then a substep of travel. */
export function predictParticles(
  position: Float32Array,
  previous: Float32Array,
  velocity: Float32Array,
  inverseMass: Float32Array,
  h: number,
  keep: number,
  dragKeep: number,
  gravity: readonly [number, number, number],
  wind: readonly [number, number, number],
): void {
  const count = inverseMass.length;
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    previous[at] = position[at] as number;
    previous[at + 1] = position[at + 1] as number;
    previous[at + 2] = position[at + 2] as number;
    if ((inverseMass[i] as number) === 0) continue;
    for (let c = 0; c < 3; c++) {
      const air = wind[c] as number;
      const v =
        air + ((velocity[at + c] as number) * keep - air) * dragKeep + (gravity[c] as number) * h;
      velocity[at + c] = v;
      position[at + c] = (position[at + c] as number) + v * h;
    }
  }
}

/** Distance constraints `order[from]` to `order[to]`, one batch. */
export function solveDistanceBatch(
  position: Float32Array,
  inverseMass: Float32Array,
  pairs: Uint32Array,
  rest: Float32Array,
  compliance: Float32Array,
  lambda: Float32Array,
  order: Uint32Array,
  from: number,
  to: number,
  invH2: number,
): void {
  for (let n = from; n < to; n++) {
    const k = order[n] as number;
    const a = pairs[k * 2] as number;
    const b = pairs[k * 2 + 1] as number;
    const wa = inverseMass[a] as number;
    const wb = inverseMass[b] as number;
    const w = wa + wb;
    if (w === 0) continue;
    const dx = (position[b * 3] as number) - (position[a * 3] as number);
    const dy = (position[b * 3 + 1] as number) - (position[a * 3 + 1] as number);
    const dz = (position[b * 3 + 2] as number) - (position[a * 3 + 2] as number);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-9) continue;
    const alpha = (compliance[k] as number) * invH2;
    const old = lambda[k] as number;
    const delta = (-(length - (rest[k] as number)) - alpha * old) / (w + alpha);
    lambda[k] = old + delta;
    const s = delta / length;
    position[a * 3] = (position[a * 3] as number) - dx * s * wa;
    position[a * 3 + 1] = (position[a * 3 + 1] as number) - dy * s * wa;
    position[a * 3 + 2] = (position[a * 3 + 2] as number) - dz * s * wa;
    position[b * 3] = (position[b * 3] as number) + dx * s * wb;
    position[b * 3 + 1] = (position[b * 3 + 1] as number) + dy * s * wb;
    position[b * 3 + 2] = (position[b * 3 + 2] as number) + dz * s * wb;
  }
}

/* Scratch for one bending constraint: relative positions, normals and the four gradients. */
const E = new Float64Array(3);
const P3 = new Float64Array(3);
const P4 = new Float64Array(3);
const N1 = new Float64Array(3);
const N2 = new Float64Array(3);
const Q = new Float64Array(12);
const W = new Float64Array(4);
const IDS = new Uint32Array(4);

/** A vector's length, through `Math.sqrt`, which every engine rounds the same. */
function length3(v: Float64Array): number {
  const x = v[0] as number;
  const y = v[1] as number;
  const z = v[2] as number;
  return Math.sqrt(x * x + y * y + z * z);
}

function cross(a: Float64Array, b: Float64Array, out: Float64Array, at = 0): void {
  out[at] = (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number);
  out[at + 1] = (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number);
  out[at + 2] = (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number);
}

/**
 * Dihedral bending constraints of one batch: Müller et al.'s position-based bending constraint, the
 * angle between the two triangles' normals held at its rest value (π is flat).
 *
 * The constraint is `acos(n1 · n2) − rest`, whose gradient is the paper's `q` vectors over
 * `sin θ`: **the paper's `q` are the negative of the derivative of `n1 · n2`**, measured against a
 * finite difference at every component, which is why its update carries a minus sign where a reader
 * taking `q` for the derivative would put a plus — and why a first version here folded a hinge
 * further instead of unfolding it. **Divided rather than multiplied through**, because near flat the `q` vectors vanish
 * with `sin θ` and their ratio stays finite: the paper's own form, `sin θ · q`, slows to nothing just
 * where a garment spends its time. A configuration within a millionth of flat or of folded shut is
 * left for the next iteration rather than divided by.
 */
export function solveBendingBatch(
  position: Float32Array,
  inverseMass: Float32Array,
  quads: Uint32Array,
  rest: Float32Array,
  compliance: Float32Array,
  lambda: Float32Array,
  order: Uint32Array,
  from: number,
  to: number,
  invH2: number,
): void {
  for (let n = from; n < to; n++) {
    const k = order[n] as number;
    const i1 = quads[k * 4] as number;
    const i2 = quads[k * 4 + 1] as number;
    const i3 = quads[k * 4 + 2] as number;
    const i4 = quads[k * 4 + 3] as number;
    const w1 = inverseMass[i1] as number;
    const w2 = inverseMass[i2] as number;
    const w3 = inverseMass[i3] as number;
    const w4 = inverseMass[i4] as number;
    if (w1 + w2 + w3 + w4 === 0) continue;
    for (let c = 0; c < 3; c++) {
      const origin = position[i1 * 3 + c] as number;
      E[c] = (position[i2 * 3 + c] as number) - origin;
      P3[c] = (position[i3 * 3 + c] as number) - origin;
      P4[c] = (position[i4 * 3 + c] as number) - origin;
    }
    cross(E, P3, N1);
    cross(E, P4, N2);
    const l1 = length3(N1);
    const l2 = length3(N2);
    if (l1 < 1e-12 || l2 < 1e-12) continue;
    for (let c = 0; c < 3; c++) {
      N1[c] = (N1[c] as number) / l1;
      N2[c] = (N2[c] as number) / l2;
    }
    let d = (N1[0] as number) * (N2[0] as number) + (N1[1] as number) * (N2[1] as number);
    d += (N1[2] as number) * (N2[2] as number);
    d = Math.min(1, Math.max(-1, d));
    const sine = Math.sqrt(1 - d * d);
    if (sine < 1e-6) continue;
    /* q3 = (e × n2 + (n1 × e) d) / |e × p3|, q4 = (e × n1 + (n2 × e) d) / |e × p4|. */
    crossInto(E, N2, N1, E, d, l1, Q, 6);
    crossInto(E, N1, N2, E, d, l2, Q, 9);
    /* q2 = −(p3 × n2 + (n1 × p3) d) / |e × p3| − (p4 × n1 + (n2 × p4) d) / |e × p4|. */
    crossInto(P3, N2, N1, P3, d, l1, Q, 3);
    const a0 = Q[3] as number;
    const a1 = Q[4] as number;
    const a2 = Q[5] as number;
    crossInto(P4, N1, N2, P4, d, l2, Q, 3);
    Q[3] = -(a0 + (Q[3] as number));
    Q[4] = -(a1 + (Q[4] as number));
    Q[5] = -(a2 + (Q[5] as number));
    for (let c = 0; c < 3; c++) {
      Q[c] = -((Q[3 + c] as number) + (Q[6 + c] as number) + (Q[9 + c] as number));
    }
    /* The gradient of acos(d) is q / sin θ (q being −∂d/∂p); its weighted squared length. */
    const weights = W;
    weights[0] = w1;
    weights[1] = w2;
    weights[2] = w3;
    weights[3] = w4;
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const qx = Q[j * 3] as number;
      const qy = Q[j * 3 + 1] as number;
      const qz = Q[j * 3 + 2] as number;
      sum += (weights[j] as number) * (qx * qx + qy * qy + qz * qz);
    }
    sum /= sine * sine;
    if (sum < 1e-12) continue;
    const alpha = (compliance[k] as number) * invH2;
    const old = lambda[k] as number;
    const delta = (-(exactAcos(d) - (rest[k] as number)) - alpha * old) / (sum + alpha);
    lambda[k] = old + delta;
    const scale = delta / sine;
    const ids = IDS;
    ids[0] = i1;
    ids[1] = i2;
    ids[2] = i3;
    ids[3] = i4;
    for (let j = 0; j < 4; j++) {
      const w = weights[j] as number;
      if (w === 0) continue;
      const p = (ids[j] as number) * 3;
      position[p] = (position[p] as number) + w * scale * (Q[j * 3] as number);
      position[p + 1] = (position[p + 1] as number) + w * scale * (Q[j * 3 + 1] as number);
      position[p + 2] = (position[p + 2] as number) + w * scale * (Q[j * 3 + 2] as number);
    }
  }
}

/** `(a × b + (c × e) · d) / length` into `out` at `at`. */
function crossInto(
  a: Float64Array,
  b: Float64Array,
  c: Float64Array,
  e: Float64Array,
  d: number,
  length: number,
  out: Float64Array,
  at: number,
): void {
  const x1 = (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number);
  const y1 = (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number);
  const z1 = (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number);
  const x2 = (c[1] as number) * (e[2] as number) - (c[2] as number) * (e[1] as number);
  const y2 = (c[2] as number) * (e[0] as number) - (c[0] as number) * (e[2] as number);
  const z2 = (c[0] as number) * (e[1] as number) - (c[1] as number) * (e[0] as number);
  out[at] = (x1 + x2 * d) / length;
  out[at + 1] = (y1 + y2 * d) / length;
  out[at + 2] = (z1 + z2 * d) / length;
}

/** Tethers: a particle further than its length from its kinematic anchor is brought back to it. */
export function solveTethers(
  position: Float32Array,
  particles: Uint32Array,
  anchors: Uint32Array,
  lengths: Float32Array,
): void {
  for (let k = 0; k < lengths.length; k++) {
    const p = (particles[k] as number) * 3;
    const a = (anchors[k] as number) * 3;
    const dx = (position[p] as number) - (position[a] as number);
    const dy = (position[p + 1] as number) - (position[a + 1] as number);
    const dz = (position[p + 2] as number) - (position[a + 2] as number);
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const length = lengths[k] as number;
    if (distance <= length || distance < 1e-9) continue;
    const s = length / distance;
    position[p] = (position[a] as number) + dx * s;
    position[p + 1] = (position[a + 1] as number) + dy * s;
    position[p + 2] = (position[a + 2] as number) + dz * s;
  }
}

/** Velocities from where the substep moved each free particle. */
export function finishParticles(
  position: Float32Array,
  previous: Float32Array,
  velocity: Float32Array,
  inverseMass: Float32Array,
  invH: number,
): void {
  for (let i = 0; i < inverseMass.length; i++) {
    const at = i * 3;
    if ((inverseMass[i] as number) === 0) {
      velocity[at] = 0;
      velocity[at + 1] = 0;
      velocity[at + 2] = 0;
      continue;
    }
    velocity[at] = ((position[at] as number) - (previous[at] as number)) * invH;
    velocity[at + 1] = ((position[at + 1] as number) - (previous[at + 1] as number)) * invH;
    velocity[at + 2] = ((position[at + 2] as number) - (previous[at + 2] as number)) * invH;
  }
}

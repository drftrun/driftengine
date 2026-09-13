import type { Pose } from './pose.ts';

/**
 * Combining poses: a blend between two, an additive layer over one, and a joint written directly.
 *
 * All three write into a caller-owned pose and allocate nothing, because every one of them runs
 * per character per frame. All three are pure functions of their inputs — no clock, no RNG — which
 * is the determinism contract `sampleClip` establishes and which a graph over clips has to keep.
 */

/**
 * Blend `a` toward `b` by `t`, into `out`.
 *
 * **Clamped rather than extrapolated.** A weight past the ends puts limbs outside their range,
 * which reads as a broken rig rather than as a weight out of bounds — the same reasoning
 * `sampleClip` holds at a track's ends for. What it costs is that a caller cannot deliberately
 * overshoot; what would make it wrong is somebody wanting to, and the honest answer then is a
 * function that says so in its name.
 *
 * Safe when `out` is also `a` or `b`: every component is read before it is written.
 */
export function blendPoses(a: Pose, b: Pose, t: number, out: Pose): void {
  const weight = t < 0 ? 0 : t > 1 ? 1 : t;
  const joints = out.rotation.length / 4;

  for (let j = 0; j < joints; j++) {
    const v = j * 3;
    for (let c = 0; c < 3; c++) {
      const from = a.translation[v + c] as number;
      out.translation[v + c] = from + ((b.translation[v + c] as number) - from) * weight;
      const scaleFrom = a.scale[v + c] as number;
      out.scale[v + c] = scaleFrom + ((b.scale[v + c] as number) - scaleFrom) * weight;
    }
    slerpInto(a.rotation, j * 4, b.rotation, j * 4, weight, out.rotation, j * 4);
  }
}

/**
 * Apply `delta` on top of `base`, scaled by `weight`, into `out`.
 *
 * **A delta, not a target**, and the difference is the whole of what additive is for: a wave laid
 * over a walk has to move the arm relative to wherever the walk put it rather than replace it. So
 * translation adds, rotation composes, and **scale multiplies** — a scale delta of 1 means
 * unchanged, where adding would make it double.
 *
 * Weight zero is the base untouched, which is what lets a layer fade in from nothing.
 */
export function addPose(base: Pose, delta: Pose, weight: number, out: Pose): void {
  const w = weight < 0 ? 0 : weight;
  const joints = out.rotation.length / 4;

  for (let j = 0; j < joints; j++) {
    const v = j * 3;
    for (let c = 0; c < 3; c++) {
      out.translation[v + c] =
        (base.translation[v + c] as number) + (delta.translation[v + c] as number) * w;
      /* One at weight zero, the delta's own factor at weight one, interpolated between. */
      const factor = 1 + ((delta.scale[v + c] as number) - 1) * w;
      out.scale[v + c] = (base.scale[v + c] as number) * factor;
    }

    /*
     * The delta's rotation is scaled by sliding it away from identity along the shorter arc, then
     * composed onto the base. Scaling by slerping from identity rather than by multiplying the
     * components is what keeps a half-weight delta a half *rotation* instead of a shortened
     * quaternion that renormalises to the whole of it.
     */
    slerpInto(IDENTITY, 0, delta.rotation, j * 4, w > 1 ? 1 : w, SCALED, 0);
    multiplyInto(base.rotation, j * 4, SCALED, 0, out.rotation, j * 4);
  }
}

/**
 * Write one joint's transform straight into a pose.
 *
 * What a solver drives. Track B's ragdolls need a pose to be *data* rather than only the result of
 * sampling, and this is the whole of that requirement — stated here so the seam exists before the
 * track that needs it, rather than being retrofitted around a closed type.
 */
export function setJoint(
  pose: Pose,
  joint: number,
  translation: ArrayLike<number>,
  rotation: ArrayLike<number>,
  scale: ArrayLike<number>,
): void {
  const v = joint * 3;
  const r = joint * 4;
  for (let c = 0; c < 3; c++) {
    pose.translation[v + c] = translation[c] as number;
    pose.scale[v + c] = scale[c] as number;
  }
  for (let c = 0; c < 4; c++) pose.rotation[r + c] = rotation[c] as number;
}

/**
 * Spherical interpolation between two quaternions held in flat arrays, along the shorter arc.
 *
 * The same arithmetic `clip.ts` performs between two keys, over two poses instead — and with the
 * same hemisphere correction, for the same reason: a quaternion and its negation are one
 * orientation, so two poses can be numerically far apart while being geometrically close, and
 * without the flip a limb rotates the long way through the body.
 *
 * Not shared with `clip.ts` because that one reads a keyframe stride and this one reads a joint
 * stride; the arithmetic between them is eight lines, and a shared function taking four offsets
 * would be harder to read than either. What would make that wrong is a third caller.
 */
function slerpInto(
  a: ArrayLike<number>,
  aAt: number,
  b: ArrayLike<number>,
  bAt: number,
  t: number,
  out: Float32Array,
  outAt: number,
): void {
  let ax = a[aAt] as number;
  let ay = a[aAt + 1] as number;
  let az = a[aAt + 2] as number;
  let aw = a[aAt + 3] as number;
  const bx = b[bAt] as number;
  const by = b[bAt + 1] as number;
  const bz = b[bAt + 2] as number;
  const bw = b[bAt + 3] as number;

  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    ax = -ax;
    ay = -ay;
    az = -az;
    aw = -aw;
    dot = -dot;
  }

  let s0: number;
  let s1: number;
  /* Nearly parallel falls back to a straight blend: `acos` at or past 1 is 0 or NaN, and dividing
     by `sin(0)` is the NaN that reaches the palette and takes every vertex the joint touches. */
  if (dot > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }

  let x = s0 * ax + s1 * bx;
  let y = s0 * ay + s1 * by;
  let z = s0 * az + s1 * bz;
  let w = s0 * aw + s1 * bw;
  const length = Math.hypot(x, y, z, w);
  if (length > 0) {
    x /= length;
    y /= length;
    z /= length;
    w /= length;
  }
  out[outAt] = x;
  out[outAt + 1] = y;
  out[outAt + 2] = z;
  out[outAt + 3] = w;
}

/** Quaternion product, in flat arrays. Safe when `out` overlaps either input. */
function multiplyInto(
  a: ArrayLike<number>,
  aAt: number,
  b: ArrayLike<number>,
  bAt: number,
  out: Float32Array,
  outAt: number,
): void {
  const ax = a[aAt] as number;
  const ay = a[aAt + 1] as number;
  const az = a[aAt + 2] as number;
  const aw = a[aAt + 3] as number;
  const bx = b[bAt] as number;
  const by = b[bAt + 1] as number;
  const bz = b[bAt + 2] as number;
  const bw = b[bAt + 3] as number;
  out[outAt] = aw * bx + ax * bw + ay * bz - az * by;
  out[outAt + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[outAt + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[outAt + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/* Module scope, claimed once: `addPose` runs per character per frame. */
const IDENTITY = new Float32Array([0, 0, 0, 1]);
const SCALED = new Float32Array(4);

/**
 * A camera move through world space: an eye, a point it looks at and a field of view, keyed in time.
 *
 * **Not the cinematic player's shots, which frame a subject.** A shot there is placed relative to
 * something that moves, and its keyframes are linear on purpose because a rig damps them. A walk
 * through a building has no subject: it is a route and a gaze, both in world coordinates, and it
 * has to arrive at each key without a kink or the motion reads as a hand-held stumble.
 *
 * **A cubic Hermite through every key, its tangent the key's neighbours' difference over their
 * time apart**, which is Catmull-Rom with the keys' own times as knots. A key is passed exactly, the
 * velocity through it is continuous, and an evenly timed straight run is exactly a constant
 * velocity. What it gives up is continuity of acceleration — the curvature can jump at a key — and
 * what would make that wrong is a move slow and wide enough for the jump to be seen as a change of
 * pull. The answer then is keys further apart, not another curve.
 *
 * The eye and the target are interpolated separately, so a pan and a dolly are written as what they
 * are. Allocation-free after construction: `sampleCameraPath` fills a caller-owned sample.
 */
import type { Vec3 } from '../math/color.ts';

export interface CameraPathKey {
  readonly atSec: number;
  readonly eye: Readonly<Vec3>;
  readonly target: Readonly<Vec3>;
  readonly fovDeg: number;
}

export interface CameraPathOptions {
  /**
   * Whether the move wraps back through its first key. A looped path needs `periodSec`: when the
   * first key comes round again, which must be later than the last key.
   */
  readonly loop: boolean;
  readonly periodSec?: number;
}

/** Seven channels a key: eye, target, field of view. */
const CHANNELS = 7;

export interface CameraPath {
  readonly loop: boolean;
  /** For a loop, the period; for an open path, the time of the last key. */
  readonly durationSec: number;
  readonly count: number;
  readonly times: Float64Array;
  readonly values: Float64Array;
  /** Per key and channel, units a second. */
  readonly tangents: Float64Array;
}

export interface CameraPathSample {
  eye: Vec3;
  target: Vec3;
  fovDeg: number;
}

export function createCameraPathSample(): CameraPathSample {
  return { eye: [0, 0, 0], target: [0, 0, 0], fovDeg: 50 };
}

/** Check the keys and work out every tangent once. Throws at construction, never in a frame. */
export function createCameraPath(
  keys: readonly CameraPathKey[],
  options: CameraPathOptions,
): CameraPath {
  const count = keys.length;
  if (count < 2) throw new Error('a camera path needs at least two keys to move between');
  const times = new Float64Array(count);
  const values = new Float64Array(count * CHANNELS);
  for (let i = 0; i < count; i++) {
    const key = keys[i] as CameraPathKey;
    if (i > 0 && !(key.atSec > (times[i - 1] as number))) {
      throw new Error(`camera path key ${i} at ${key.atSec}s must be later than the one before`);
    }
    times[i] = key.atSec;
    values.set([...key.eye, ...key.target, key.fovDeg], i * CHANNELS);
  }
  const first = times[0] as number;
  const last = times[count - 1] as number;
  let durationSec = last;
  if (options.loop) {
    const period = options.periodSec ?? 0;
    if (!(first + period > last)) {
      throw new Error(`a looped camera path's period ${period}s must end after its last key`);
    }
    durationSec = period;
  }

  const tangents = new Float64Array(count * CHANNELS);
  for (let i = 0; i < count; i++) {
    let before = i - 1;
    let after = i + 1;
    let tBefore = before >= 0 ? (times[before] as number) : 0;
    let tAfter = after < count ? (times[after] as number) : 0;
    if (options.loop) {
      if (before < 0) {
        before = count - 1;
        tBefore = (times[before] as number) - durationSec;
      }
      if (after >= count) {
        after = 0;
        tAfter = (times[0] as number) + durationSec;
      }
    } else {
      /* An open end has one neighbour, and its tangent is the straight line to it. */
      if (before < 0) {
        before = i;
        tBefore = times[i] as number;
      }
      if (after >= count) {
        after = i;
        tAfter = times[i] as number;
      }
    }
    const span = tAfter - tBefore;
    for (let c = 0; c < CHANNELS; c++) {
      const delta =
        (values[after * CHANNELS + c] as number) - (values[before * CHANNELS + c] as number);
      tangents[i * CHANNELS + c] = delta / span;
    }
  }
  return { loop: options.loop, durationSec, count, times, values, tangents };
}

/** The camera at `timeSec`. An open path holds its ends; a looped one wraps. */
export function sampleCameraPath(
  path: CameraPath,
  timeSec: number,
  out: CameraPathSample,
): CameraPathSample {
  const { times, values, tangents, count } = path;
  const first = times[0] as number;
  let t = timeSec;
  if (path.loop) {
    t = first + ((((timeSec - first) % path.durationSec) + path.durationSec) % path.durationSec);
  } else if (t <= first) {
    return write(out, values, 0);
  } else if (t >= (times[count - 1] as number)) {
    return write(out, values, count - 1);
  }

  let i = 0;
  while (i < count - 1 && (times[i + 1] as number) <= t) i++;
  const next = i + 1 < count ? i + 1 : 0;
  const t0 = times[i] as number;
  const t1 = next === 0 ? first + path.durationSec : (times[next] as number);
  const h = t1 - t0;
  const u = (t - t0) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  for (let c = 0; c < CHANNELS; c++) {
    const v =
      h00 * (values[i * CHANNELS + c] as number) +
      h10 * h * (tangents[i * CHANNELS + c] as number) +
      h01 * (values[next * CHANNELS + c] as number) +
      h11 * h * (tangents[next * CHANNELS + c] as number);
    if (c < 3) out.eye[c] = v;
    else if (c < 6) out.target[c - 3] = v;
    else out.fovDeg = v;
  }
  return out;
}

function write(out: CameraPathSample, values: Float64Array, key: number): CameraPathSample {
  const at = key * CHANNELS;
  out.eye[0] = values[at] as number;
  out.eye[1] = values[at + 1] as number;
  out.eye[2] = values[at + 2] as number;
  out.target[0] = values[at + 3] as number;
  out.target[1] = values[at + 4] as number;
  out.target[2] = values[at + 5] as number;
  out.fovDeg = values[at + 6] as number;
  return out;
}

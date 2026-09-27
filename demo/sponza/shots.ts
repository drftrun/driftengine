/**
 * The camera's day: one looped move through the courtyard, timed to the hours in `clock.ts`.
 *
 * Four shots from the reference brief, joined into one path rather than cut:
 * - the ground floor down the long axis at noon;
 * - looking up at the open roof in the afternoon;
 * - across the courtyard at gallery height at golden hour, at the gallery the low sun lights;
 * - the lion-head end in blue hour and at night.
 * Then the long axis again at dawn. Measured against this model's own layout, recorded in the
 * census: the open courtyard spans x −14…9 m and z −3.5…3.4 m, the gallery floor stands at 5.4 m,
 * and the column heads at 8.7 m.
 *
 * **Every eye stays inside the open courtyard**, well clear of the column lines at z = ±3.45 m, so
 * the path never threads a column and none fills the frame; the gallery eyes stand 1.2 m in from
 * it. **And clear of the cypress**, which stands 14.8 m tall at the origin with a crown 1.5 m round:
 * the afternoon eye stands 8 m off it and the golden-hour eyes keep a metre outside its crown, or
 * its branches fill the frame.
 * The cost is that no shot is taken from inside an arcade. What would make that wrong is a shot the
 * arcade's own view is needed for, which would then want a cut and not a longer path.
 */
import {
  createCameraPath,
  createCameraPathSample,
  sampleCameraPath,
} from '../../packages/core/src/index';
import type { CameraPathKey } from '../../packages/core/src/index';
import { LOOP_SEC } from './clock';

const KEYS: CameraPathKey[] = [
  /* 10:00–15:30, noon's floor: a slow dolly down the long axis. */
  { atSec: 0, eye: [-12, 1.6, -0.6], target: [8, 4.2, 0.3], fovDeg: 60 },
  { atSec: 16, eye: [-5.5, 1.6, 0.6], target: [9, 5.2, 0], fovDeg: 60 },
  /* The afternoon, looking up at the roof's opening, clear of the cypress at the origin. */
  { atSec: 26, eye: [-8, 1.4, 0.4], target: [-7.2, 17, -0.6], fovDeg: 72 },
  /*
   * Rising to the gallery for golden hour, looking down the length at the lit far end, with the
   * cypress framing the left rather than standing in the middle: the eyes keep to z = −2.4, a metre
   * clear of its crown. Tried from the floor looking up at the +z top storey, which is where a low
   * sun from −z lands, and the arcades overhead filled the frame whatever the pitch.
   */
  { atSec: 34, eye: [3, 5.5, -2.4], target: [-12, 8.5, 1.2], fovDeg: 62 },
  { atSec: 46, eye: [4.5, 7.2, -2.4], target: [-14, 8, 1.8], fovDeg: 58 },
  { atSec: 58, eye: [-4, 7, -2], target: [-14, 6.5, 2.2], fovDeg: 58 },
  /* Blue hour and the night, down at the lion-head end. */
  { atSec: 70, eye: [-6.5, 2.2, -2.4], target: [-15, 3, 0.4], fovDeg: 60 },
  { atSec: 86, eye: [-9.5, 1.7, -1.8], target: [-15.2, 2.4, 0.2], fovDeg: 55 },
  /* The night courtyard looking back, then dawn rising toward the open roof. */
  { atSec: 100, eye: [-11.5, 1.6, 1.8], target: [6, 5.5, 0], fovDeg: 62 },
  { atSec: 112, eye: [-13, 2.2, 0.4], target: [4, 9, 0], fovDeg: 64 },
];

export const CAMERA_PATH = createCameraPath(KEYS, { loop: true, periodSec: LOOP_SEC });

/**
 * Whether a point stands within `radiusM` of where the camera flies, sampled every quarter second.
 *
 * For the candles, which hang everywhere from 0.7 m to 11 m: the path cannot avoid them, so the ones
 * in its path are moved, as a crew clears a dolly's track. Built once, at load, by the caller.
 */
export function nearCameraPath(radiusM: number): (x: number, y: number, z: number) => boolean {
  const sample = createCameraPathSample();
  const points: number[] = [];
  for (let t = 0; t < LOOP_SEC; t += 0.25) {
    sampleCameraPath(CAMERA_PATH, t, sample);
    points.push(sample.eye[0], sample.eye[1], sample.eye[2]);
  }
  const r2 = radiusM * radiusM;
  return (x, y, z) => {
    for (let i = 0; i < points.length; i += 3) {
      const dx = x - (points[i] as number);
      const dy = y - (points[i + 1] as number);
      const dz = z - (points[i + 2] as number);
      if (dx * dx + dy * dy + dz * dz < r2) return true;
    }
    return false;
  };
}

import { clamp } from '../math/scalar.ts';

/**
 * Where a shot puts the camera, and what it frames.
 *
 * Pure: a shot plus a subject pose plus how far into the shot it is, in and a
 * placement out. No state, no smoothing, no collision — those belong to the rig
 * (`cinematicCamera.ts`), and keeping them apart is what lets the rig evaluate
 * the *same* shot at two poses in a frame, which is how it learns the speed its
 * target is travelling at instead of trailing behind it.
 *
 * Game-agnostic, like the rig: a shot is a placement rule and a subject.
 * Nothing here knows what a character is.
 */
export type ShotKind = 'chase' | 'lowWide' | 'orbit' | 'flyby' | 'overhead' | 'lookAt';

export interface ShotParams {
  readonly kind: ShotKind;
  /** How far the camera sits from its subject, in metres. */
  readonly distance: number;
  /** How high above it. */
  readonly height: number;
  readonly fovDeg: number;
  /** Radians per second, for `orbit`. */
  readonly orbitRate?: number;
  /**
   * How long this shot is going to hold, in seconds, when the caller knows.
   *
   * Only motion *within* a shot needs it, and only to know where the end is so
   * it can arrive there rather than being cut off mid-travel. An `orbit` given a
   * hold eases across the whole of it; one without eases in and then keeps its
   * rate, because inventing a duration would be worse than not having one.
   */
  readonly holdSec?: number;
  /**
   * A fixed world point. `lookAt` frames it; `flyby` uses it as the station to
   * shoot from. Ignored by the others.
   */
  readonly anchor?: readonly [number, number, number];
}

/**
 * How far a `lookAt` shot's aim may sit from its subject, as a share of the shot's own
 * camera distance.
 *
 * A *share of the gap* was the first attempt and it is wrong for the case that matters:
 * a subject thirty metres past its anchor, with even a modest share left behind, pulls the
 * aim further back than the camera stands — so the shot looks the wrong way down its own
 * axis and the subject is behind the lens. Clamping the offset in metres instead cannot do
 * that, because it is measured against the distance the camera is placed at.
 *
 * At half, the aim is never more than half the camera's distance from the subject, which
 * keeps them near the middle of frame at any separation. While the two are closer than
 * that the aim lands on the anchor exactly, which is the composition the shot exists for.
 */
const LOOK_AT_ANCHOR_PULL = 0.5;

/** Where the subject is and which way it faces. Caller-owned and mutated in place. */
export interface SubjectPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** The answer: caller-owned, written in place, never allocated per frame. */
export interface ShotPlacement {
  /** Where the shot wants the camera, before smoothing and before collision. */
  wantX: number;
  wantY: number;
  wantZ: number;
  /** What it wants in the middle of frame. */
  lookX: number;
  lookY: number;
  lookZ: number;
  fovDeg: number;
}

export function createShotPlacement(): ShotPlacement {
  return { wantX: 0, wantY: 0, wantZ: 0, lookX: 0, lookY: 0, lookZ: 0, fovDeg: 70 };
}

/**
 * How long an orbit with no stated hold spends getting up to speed.
 *
 * Long enough to read as a camera being pushed rather than switched on, short
 * enough that a two-second shot still travels. A stated hold is always better —
 * it gets an ease at *both* ends — and the director supplies one.
 */
const ORBIT_EASE_SEC = 1.2;

/**
 * The station a `flyby` shoots from, when the shot did not name one.
 *
 * Split out because the station is captured once, on the cut, and then held: a
 * flyby that follows is a chase cam, and the whole point is a camera the world
 * moves past.
 */
export function flybyStation(
  shot: ShotParams,
  pose: SubjectPose,
  out: [number, number, number],
): void {
  const anchor = shot.anchor;
  if (anchor !== undefined) {
    out[0] = anchor[0] ?? 0;
    out[1] = anchor[1] ?? 0;
    out[2] = anchor[2] ?? 0;
    return;
  }
  const distance = shotParam(shot.distance, 6, 0.5, 400);
  const height = shotParam(shot.height, 2, -50, 200);
  out[0] = pose.x + Math.cos(pose.yaw) * distance;
  out[1] = pose.y + height;
  out[2] = pose.z + Math.sin(pose.yaw) * distance;
}

/**
 * Place `shot` for a subject at `pose`, `ageSec` into the shot.
 *
 * `station` is only read by `flyby`; pass the rig's held station.
 */
export function placeShot(
  shot: ShotParams,
  pose: SubjectPose,
  ageSec: number,
  station: readonly number[],
  out: ShotPlacement,
): void {
  const distance = shotParam(shot.distance, 6, 0.5, 400);
  const height = shotParam(shot.height, 2, -50, 200);
  const { x, y, z, yaw } = pose;

  out.fovDeg = shotParam(shot.fovDeg, 70, 20, 140);
  out.wantX = x;
  out.wantY = y + height;
  out.wantZ = z;
  out.lookX = x;
  out.lookY = y;
  out.lookZ = z;

  switch (shot.kind) {
    case 'chase': {
      // Behind the character's own heading, so the shot reads as following.
      out.wantX = x - Math.sin(yaw) * distance;
      out.wantZ = z + Math.cos(yaw) * distance;
      break;
    }
    case 'lowWide': {
      // Across the line of travel and near the ground, so the character crosses
      // frame instead of receding — the shot that sells a gap.
      out.wantX = x + Math.cos(yaw) * distance;
      out.wantZ = z + Math.sin(yaw) * distance;
      break;
    }
    case 'orbit': {
      const rate = shotParam(shot.orbitRate, 0.6, -3, 3);
      const angle = yaw + sweptAngle(rate, ageSec, shot.holdSec);
      out.wantX = x - Math.sin(angle) * distance;
      out.wantZ = z + Math.cos(angle) * distance;
      break;
    }
    case 'overhead': {
      out.wantX = x - Math.sin(yaw) * distance * 0.4;
      out.wantZ = z + Math.cos(yaw) * distance * 0.4;
      break;
    }
    case 'flyby': {
      out.wantX = station[0] ?? 0;
      out.wantY = station[1] ?? 0;
      out.wantZ = station[2] ?? 0;
      break;
    }
    case 'lookAt': {
      /*
       * Frames a fixed point *and* keeps the subject, handing the frame from one to the
       * other as they separate.
       *
       * The fixed point is the reason this shot kind exists — a grapple shot holds on the
       * ring while the character flies at it, and aiming at the character instead loses the thing
       * the moment is about. But it aimed at the anchor and *nothing else*, and an anchor is
       * a place the character arrives at and then leaves. Once they had swung through it they
       * were simply out of shot, for as long as the cut lasted — reported from a replay
       * as framing that loses the subject entirely, because the camera stops following
       * them in that phase.
       *
       * So the aim is a point on the line between them, pulled toward the anchor by a
       * bounded number of metres. While the two are close the aim *is* the anchor, which is
       * the composition the shot was written for; once the character has flown past, the aim
       * stays with them and the ring slides out toward the edge of frame rather than the
       * character leaving it. Nothing needs to know which phase it is in — the geometry says.
       */
      const anchor = shot.anchor;
      if (anchor !== undefined) {
        const ax = anchor[0] ?? 0;
        const ay = anchor[1] ?? 0;
        const az = anchor[2] ?? 0;
        const gap = Math.hypot(x - ax, y - ay, z - az);
        /*
         * Aim from the *subject* toward the anchor, by at most half the camera's distance.
         * Nearer than that and the aim is the anchor itself; further and the anchor slides
         * out toward the edge of frame while the subject stays in the middle of it.
         */
        const pull = Math.min(gap, distance * LOOK_AT_ANCHOR_PULL);
        const k = gap > 1e-6 ? pull / gap : 0;
        out.lookX = x + (ax - x) * k;
        out.lookY = y + (ay - y) * k;
        out.lookZ = z + (az - z) * k;
      }
      out.wantX = x - Math.sin(yaw) * distance;
      out.wantZ = z + Math.cos(yaw) * distance;
      break;
    }
  }
}

/**
 * How far an orbit has swept by `ageSec` — eased, not `age x rate`.
 *
 * The linear version was reported, exactly, as looking *straight*: measured at a
 * dead constant 3.82 m/s from the twentieth frame of the shot to the last one,
 * still at full speed at the instant the shot was cut away from. A dolly on
 * rails. Every other shot kind travelled exactly 0.000 m over two seconds with a
 * still character, so this was the only self-motion in the file and the only place
 * the complaint could come from.
 *
 * The **arc is preserved**: `rate x hold` is what a hold sweeps either way, since
 * where an orbit starts and finishes is a composition decision and the ease is
 * only about how it gets there. It peaks half again as fast in the middle, which
 * is the cost of standing still at both ends.
 */
function sweptAngle(rate: number, ageSec: number, holdSec: number | undefined): number {
  const hold = holdSec !== undefined && Number.isFinite(holdSec) && holdSec > 0 ? holdSec : 0;
  if (hold > 0) {
    const t = clamp(ageSec / hold, 0, 1);
    return rate * hold * t * t * (3 - 2 * t);
  }

  /*
   * No hold to aim at, so ease in and then keep the rate. This is the integral of
   * `smoothstep(age / EASE)` — which is why the straight part is offset by half
   * the ramp rather than starting from zero, and why the two halves meet with the
   * same speed as well as the same position.
   */
  if (ageSec >= ORBIT_EASE_SEC) return rate * (ageSec - ORBIT_EASE_SEC * 0.5);
  const u = ageSec / ORBIT_EASE_SEC;
  return rate * ORBIT_EASE_SEC * (u * u * u - 0.5 * u * u * u * u);
}

/**
 * Clamp a shot parameter into something a camera can use.
 *
 * Shots are produced by a director working from measured data — a run that
 * lasted no time, an anchor at the origin — and a NaN reaching a view matrix
 * blanks the entire frame without raising anything, which is the worst way for a
 * bad number to fail.
 */
export function shotParam(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

import { clamp } from '../math/scalar.ts';
import { Boom } from './boom.ts';
import { Spring } from '../math/spring.ts';
import { segmentHit } from '@driftengine/physics';
import type { ColliderSet } from '@driftengine/physics';
import { Camera } from './camera.ts';
import { createShotPlacement, flybyStation, placeShot } from './shotPlacement.ts';
import type { ShotParams, SubjectPose } from './shotPlacement.ts';

/**
 * A camera that can be *cut*, for replays and cinematics.
 *
 * The gameplay camera has one job — keep the player able to read where they are
 * about to land — so it is a single smoothed rig that never surprises anyone. A
 * replay camera has the opposite job: it is a director, and its whole
 * vocabulary is choosing a new angle at the right instant.
 *
 * Generic on purpose. A shot here is a placement rule and a subject; which shot
 * suits a grapple, and when to cut, are the game's business. Nothing in this
 * file knows what a character is. *Where* a shot puts the camera lives in
 * `shotPlacement.ts`; this is the rig that moves onto it.
 *
 * The two hard requirements pull against each other. A **cut is instantaneous**
 * — a cut that eases is a swoop, and it destroys the sync with the beat that an
 * edit is built on. Motion **within** a shot is smoothed, because footage that
 * steps judders exactly when somebody is watching it frame by frame. So the
 * smoothing state is reset on a cut rather than smoothed through it.
 */
export type { ShotKind, ShotParams } from './shotPlacement.ts';

/**
 * How fast the rig converges within a shot, in 1/seconds. Higher is tighter.
 *
 * These are spring rates, not `damp` lambdas, and the two are not
 * interchangeable at the same figure: a spring spends the start of a move
 * accelerating instead of covering ground, so it reads gentler. Kept at the old
 * numbers because the error they used to leave behind is gone — see below —
 * which is a change to how the rig *looks* and wants an eye on it, not a number.
 */
const FOLLOW_RATE = 6;
const AIM_RATE = 9;
/**
 * A ceiling on the speed the rig will ride along at, in metres per second.
 *
 * Not a tuning knob: a safety rail. The ride-along speed is measured from the
 * placement's own motion, so a subject that jumps — a caller that teleported one
 * without saying so — would otherwise hand the rig hundreds of metres a second
 * and it would coast off with them. Far above anything a subject can really do,
 * so it never binds in play.
 */
const MAX_TRACK_SPEED = 60;
/** Keeps a boom from ending inside a wall it grazed. */
const BOOM_RADIUS = 0.3;
const BOOM_MIN_FRACTION = 0.12;
/*
 * The boom's rate limits live in `boom.ts` now, shared with the gameplay rig,
 * which had none at all and popped by 4 m when a railing crossed it.
 */

export class CinematicCamera {
  readonly camera = new Camera();

  private shot: ShotParams = { kind: 'chase', distance: 6, height: 2, fovDeg: 70 };
  private shotStartSec = 0;
  private nowSec = 0;
  /**
   * Where the camera wants to be, and where it is looking.
   *
   * Springs rather than first-order lags, which is the fix for *"the transitions
   * between them that it's like straight"*. A lag's speed is proportional to the
   * error it has already built, so the only way it can travel at the subject's
   * speed is to accumulate `speed / lambda` metres of error and hold it: a shot
   * asking for a 7 m boom was measured sitting at 9.219 m behind a 14 m/s
   * character, and re-accumulating that error as a straight slide after every cut —
   * 7.000 → 8.317 → 9.213 over the second after it, peaking on frame 2 and
   * decaying from there. A spring carries a velocity, so it rides along with a
   * target that is moving instead of trailing it, and it accelerates into and
   * settles out of the moves that remain.
   */
  private readonly followX = new Spring();
  private readonly followY = new Spring();
  private readonly followZ = new Spring();
  private readonly aimYaw = new Spring();
  private readonly aimPitch = new Spring();
  /** Place the rig outright on the next update, rather than moving it there. */
  private fresh = true;
  /**
   * Whether that placement may keep travelling at the target's speed.
   *
   * The difference between the two ways a rig is placed, and only the caller
   * knows which happened. A **cut** changes the shot while the subject carries on
   * as it was, so the speed measured across the frame is real and the new shot
   * should open already moving with it — otherwise every cut opens with the rig
   * accelerating from a standstill, which is the slide this replaced. A **snap**
   * is for a subject that teleported: there is no meaningful speed across that
   * frame, and a rig that inherited one would coast off after the character's
   * ghost.
   */
  private freshKeepsSpeed = false;
  /** The arm out to the camera, and its speed limits. See `boom.ts`. */
  private readonly boom = new Boom();
  /** Frozen for `flyby`, which watches from where it was placed. */
  private readonly station: [number, number, number] = [0, 0, 0];
  private readonly pose: SubjectPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly previousPose: SubjectPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private hasPreviousPose = false;
  private readonly placement = createShotPlacement();
  private readonly previousPlacement = createShotPlacement();

  constructor(private readonly colliders: ColliderSet) {}

  /**
   * Switch shots, now.
   *
   * `atSec` is the shot's own start time, used by anything that animates within
   * a shot — an orbit's angle, for instance — so a shot looks the same whenever
   * in the run it is used.
   */
  cut(shot: ShotParams, atSec: number): void {
    this.shot = shot;
    this.shotStartSec = atSec;
    // The next update snaps rather than glides. This *is* the cut.
    this.fresh = true;
    // The subject did not stop for it, so the new shot opens already tracking.
    this.freshKeepsSpeed = true;
  }

  /**
   * Drop the smoothing history, keeping the shot.
   *
   * For a subject that *teleports* — a character who died and is back on a
   * checkpoint, or a scrub bar dropped somewhere else in the run. Smoothing
   * across that is a camera flying the length of the route with nothing in
   * frame, measured at 124 m inside a single shot, and it looks far more like a
   * bug than a cut does.
   *
   * A threshold inside `update` would be the wrong place for this. Only the
   * caller can tell a teleport from a legitimately fast frame: a replay catching
   * up after a freeze advances several simulation ticks in one frame, and a
   * browser that dropped a frame advances a dozen. That is also why this is not
   * `cut` — the two differ over whether the speed across the frame means
   * anything, and the caller is the only one who knows.
   */
  snap(): void {
    this.fresh = true;
    this.freshKeepsSpeed = false;
  }

  /** Seconds since the current shot began. */
  get shotAgeSec(): number {
    return Math.max(0, this.nowSec - this.shotStartSec);
  }

  update(
    frameDt: number,
    subjectX: number,
    subjectY: number,
    subjectZ: number,
    subjectYaw: number,
  ): void {
    const dt = Math.max(0, frameDt);
    this.nowSec += dt;
    const shot = this.shot;
    const age = this.shotAgeSec;

    const pose = this.pose;
    pose.x = subjectX;
    pose.y = subjectY;
    pose.z = subjectZ;
    pose.yaw = subjectYaw;

    // Captured on the cut, from where the subject was at the time, then held.
    if (this.fresh && shot.kind === 'flyby') flybyStation(shot, pose, this.station);

    const want = this.placement;
    placeShot(shot, pose, age, this.station, want);

    /*
     * How fast the placement itself is travelling, by placing the *same* shot
     * where the subject was a frame ago.
     *
     * Measured this way rather than by differencing the last frame's answer,
     * because the last frame's answer belongs to the previous shot and a cut is
     * exactly when this matters most. It also comes out right for the shots whose
     * placement does not follow the subject at all — a `flyby` station gives
     * zero, because both frames read the same held station — and it picks up an
     * orbit's own sweep, which is motion the rig should ride rather than chase.
     */
    let trackVX = 0;
    let trackVY = 0;
    let trackVZ = 0;
    if (dt > 1e-6 && this.hasPreviousPose && (!this.fresh || this.freshKeepsSpeed)) {
      const before = this.previousPlacement;
      placeShot(shot, this.previousPose, Math.max(0, age - dt), this.station, before);
      trackVX = trackSpeed((want.wantX - before.wantX) / dt);
      trackVY = trackSpeed((want.wantY - before.wantY) / dt);
      trackVZ = trackSpeed((want.wantZ - before.wantZ) / dt);
    }

    if (this.fresh) {
      this.followX.reset(want.wantX, trackVX);
      this.followY.reset(want.wantY, trackVY);
      this.followZ.reset(want.wantZ, trackVZ);
    } else {
      this.followX.step(want.wantX, trackVX, FOLLOW_RATE, dt);
      this.followY.step(want.wantY, trackVY, FOLLOW_RATE, dt);
      this.followZ.step(want.wantZ, trackVZ, FOLLOW_RATE, dt);
    }

    /*
     * Collision. The boom is the line from the subject out to the camera, and
     * it shortens against real geometry — a replay camera clipping through an
     * island reads as broken immediately, not as a bad angle.
     */
    const boomX = this.followX.value - want.lookX;
    const boomY = this.followY.value - want.lookY;
    const boomZ = this.followZ.value - want.lookZ;
    const clearFraction = Math.max(
      BOOM_MIN_FRACTION,
      segmentHit(
        want.lookX,
        want.lookY,
        want.lookZ,
        boomX,
        boomY,
        boomZ,
        this.colliders,
        BOOM_RADIUS,
      ),
    );
    if (this.fresh) this.boom.reset(clearFraction);
    else this.boom.step(clearFraction, Math.hypot(boomX, boomY, boomZ), dt);
    const fraction = this.boom.fraction;

    const camX = want.lookX + boomX * fraction;
    const camY = want.lookY + boomY * fraction;
    const camZ = want.lookZ + boomZ * fraction;
    this.camera.position[0] = camX;
    this.camera.position[1] = camY;
    this.camera.position[2] = camZ;

    // Aim. Smoothed separately from position, so a pan stays steady while the
    // rig is still converging on its placement. Its target is where the subject
    // *is* rather than where it is heading, so there is no speed to ride along
    // with — and now that the rig holds its framing, a held shot barely moves it.
    const dx = want.lookX - camX;
    const dy = want.lookY - camY;
    const dz = want.lookZ - camZ;
    const flat = Math.hypot(dx, dz);
    const wantYaw = flat < 1e-4 && Math.abs(dy) < 1e-4 ? this.aimYaw.value : Math.atan2(dx, -dz);
    const wantPitch = flat < 1e-4 ? (dy > 0 ? 1.4 : -1.4) : Math.atan2(dy, flat);

    if (this.fresh) {
      this.aimYaw.reset(wantYaw);
      this.aimPitch.reset(wantPitch);
    } else {
      this.aimYaw.stepAngle(wantYaw, 0, AIM_RATE, dt);
      this.aimPitch.step(wantPitch, 0, AIM_RATE, dt);
    }
    this.camera.yaw = this.aimYaw.value;
    this.camera.pitch = this.aimPitch.value;
    this.camera.fovYDeg = want.fovDeg;

    this.previousPose.x = pose.x;
    this.previousPose.y = pose.y;
    this.previousPose.z = pose.z;
    this.previousPose.yaw = pose.yaw;
    this.hasPreviousPose = true;
    this.fresh = false;
    this.freshKeepsSpeed = false;
  }
}

/** Keep a measured ride-along speed inside what a crane could do. */
function trackSpeed(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, -MAX_TRACK_SPEED, MAX_TRACK_SPEED);
}

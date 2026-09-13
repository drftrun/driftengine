/** Collision-safe, configurable third-person orbit camera rig. */

/**
 * Stations along the arm at which the ground is queried.
 *
 * Eight over a five-metre boom is a station every 60 cm, which is finer than the
 * `Boom` smoothing that consumes the answer can respond to anyway. The cost is eight
 * surface queries a frame on a path that already does a box sweep.
 */
const GROUND_SAMPLES = 8;

import { clamp, damp, dampTracking } from '../math/scalar.ts';
import { Boom } from './boom.ts';
import type { BoomTiming } from './boom.ts';
import { segmentHit } from '@driftengine/physics';
import type { ColliderSet } from '@driftengine/physics';
import { createSurfaceHit } from '../physics/ribbonSurface.ts';
import type { GroundSurface } from '../physics/ribbonSurface.ts';
import { Camera } from './camera.ts';

export interface ThirdPersonCameraOptions {
  boomDistance: number;
  boomRadius: number;
  boomMinDistance: number;
  positionLambda: number;
  fovLambda: number;
  pitchMin: number;
  pitchMax: number;
  initialPitch: number;
  initialFovYDeg: number;
  /**
   * How fast the arm may change length. Absent keeps the numbers every rig had.
   *
   * **The defaults are written for an arm of several metres**, where the speed ceilings bind and
   * the obstruction is a railing sweeping across for a few frames. On a short arm neither ceiling
   * binds, only the damping acts, and easing into a wall is the wrong trade — see `BoomTiming`,
   * which carries the measurement and the immediate-retract spelling.
   */
  readonly boomTiming?: Partial<BoomTiming>;
  /**
   * Whether the rig damps the roll it is handed. Absent means yes, which every rig had.
   *
   * **False is for a caller that has already damped it**, and that is not a niche: a consumer with
   * a comfort setting on roll applies the same value to a first-person view, so a roll damped again
   * here is damped twice and the setting stops meaning what it is asserted to mean. The rig's own
   * damping exists so a subject snapping between surfaces cannot snap the view; a caller that has
   * solved that itself is not asking for it twice.
   */
  readonly dampRoll?: boolean;
}

/**
 * Something that can say how far an arm gets before it hits the world.
 *
 * **An alternative to the `ColliderSet`, on the seam `surface` already uses.** The rig tests its
 * arm with `segmentHit` against a set of boxes, and a consumer whose world is a `PhysicsWorld`
 * does not have one — so using the rig meant building and maintaining a second copy of the world
 * for the camera alone, which is a cost large enough to have kept one consumer off the rig
 * entirely.
 *
 * A segment and a radius in, metres along it or null out. Metres rather than a fraction because
 * that is what a raycast answers and the rig knows its own length; null rather than the length
 * because "nothing was hit" and "something was hit at the far end" are different facts, and a
 * caller should not have to encode the first as the second.
 */
export interface BoomObstruction {
  distance(
    fromX: number,
    fromY: number,
    fromZ: number,
    alongX: number,
    alongY: number,
    alongZ: number,
    radius: number,
  ): number | null;
}

/**
 * Generic camera mechanism. The caller supplies its already-resolved target
 * height and desired FOV, keeping crouch rules and speed effects in the game.
 */
export class ThirdPersonCamera {
  readonly camera = new Camera();

  private smoothX = 0;
  private smoothY = 0;
  private smoothZ = 0;
  /**
   * Where the target was last frame, so its velocity can be differenced out of it.
   *
   * **Differenced here rather than asked of the caller**, because every caller already hands the
   * target over each frame and a second parameter for something derivable from the first is a
   * signature every consumer has to be told about. It is exact for a target moving smoothly, which
   * a vehicle under a fixed step with interpolation is: the engine's own harness measures the
   * subject holding its world speed to within a twentieth of a per cent through frame jitter that
   * moves this camera by 5%.
   */
  /**
   * The frame the arm is built in. World axes unless a caller says otherwise.
   *
   * **The arm used to be a spherical boom about world Y** — `-sin(yaw) cos(pitch)`, `-sin(pitch)`,
   * `cos(yaw) cos(pitch)` — so a subject standing on a wall or a ceiling got an arm that still
   * swung about world up, and the rig placed the eye through the surface the subject was standing
   * on. `groundClear` cut the arm where the eye would go under the deck, which is the same
   * assumption a second time.
   *
   * The rig already anticipated this case and stopped one step short of it: `targetRoll`'s comment
   * says the rig knows nothing about banked surfaces, only that a camera can be tilted, and damps
   * roll here so a subject snapping between surfaces cannot snap the view. The arm is carried the
   * same distance now. Yaw and pitch keep their meaning and become angles inside this frame, so a
   * caller that never sets one gets exactly the arm it always got.
   */
  boomUpX = 0;
  boomUpY = 1;
  boomUpZ = 0;
  /**
   * The frame's forward, **readable because a caller that sets one needs to know what it became**.
   *
   * Both `setBoomUp` and `setBoomForward` orthogonalise against the other axis, so what the rig
   * holds is rarely the vector it was handed — and a caller computing a roll, or asking where its
   * subject's heading ended up, needs the one the arm is actually built from. Assigning these
   * directly does not rebuild the frame; the two setters are what keep the three axes orthonormal.
   */
  boomForwardX = 0;
  boomForwardY = 0;
  boomForwardZ = 1;
  private boomRightX = 1;
  private boomRightY = 0;
  private boomRightZ = 0;

  private lastTargetX = 0;
  private lastTargetY = 0;
  private lastTargetZ = 0;
  private fov: number;
  private roll = 0;
  private snapped = false;
  /**
   * The arm out to the camera, and its speed limits.
   *
   * This rig used to apply the collision query's fraction directly. The query is a
   * step function — a railing either blocks the arm or it does not — so the camera
   * jumped by up to 4 m in a single frame every time one swept across it. That is
   * the same artefact the replay camera was fixed for after it was reported as
   * juddering and jumpy; this rig simply never got the fix, and a railed descent
   * is where it would be worst.
   */
  private readonly boom: Boom;

  /** Reused by the ground query; the rig allocates nothing per frame. */
  private readonly groundHit = createSurfaceHit();

  /**
   * @param surface The walkable ground, where the caller has one. **Not optional in
   * practice**, and the reason is worth stating: `colliders` is not the whole world.
   * A consumer whose drivable surface is a banked ribbon cannot put it in the collider
   * set — a world-axis box around a banked cross-section has a flat lid at its highest
   * corner, which is floor where nothing is drawn and a wall where the next slab's lid
   * stands above the character's feet. So that surface is invisible to `segmentHit`, and a
   * boom tested only against boxes passes straight through the deck.
   *
   * Which is exactly what it did. On a descent, pitching the view down put the eye
   * *under the track*, with the deck between the camera and the character: the rig sees the
   * underside of the surface instead of the character, because dynamic surfaces are not
   * part of what it tests against. Worse in replays, where the camera moves far more than
   * a player ever moves it.
   */
  constructor(
    private readonly colliders: ColliderSet,
    private readonly options: Readonly<ThirdPersonCameraOptions>,
    private readonly surface: GroundSurface | null = null,
    /**
     * A world query for the arm, instead of the collider set.
     *
     * Fourth and defaulted, so no existing call site changes — the same shape `surface` was added
     * in. When it is given, `colliders` is not consulted at all: a caller with one has the whole
     * world behind it and a set of boxes beside it would be a second, partial answer to the same
     * question. See `BoomObstruction` for why one consumer could not supply the set.
     */
    private readonly obstruction: BoomObstruction | null = null,
  ) {
    validateOptions(options);
    this.boom = new Boom(options.boomTiming);
    this.camera.pitch = options.initialPitch;
    this.camera.fovYDeg = options.initialFovYDeg;
    this.fov = options.initialFovYDeg;
  }

  /**
   * Place the rig outright on the next update instead of gliding to it.
   *
   * The first update already does this — a camera that eases in from the origin
   * on the first frame of a session is a swoop nobody asked for. This re-arms it,
   * for a subject that has *moved without travelling*: a scrub bar dropped
   * somewhere else in a replay, or a character put back on a checkpoint. Smoothing
   * across that is a camera flying the length of the route with nothing in frame,
   * which the replay camera has already been measured doing at 124 m in a single
   * shot.
   *
   * Only the caller can tell that apart from a legitimately fast frame, which is
   * why it is a method here rather than a distance threshold in `update`.
   */
  /**
   * How far out the arm may reach before the eye would drop below the ground, as a
   * fraction of its length. 1 when the ground is nowhere near it.
   *
   * Sampled from the far end inward and returned on the first clear station, because the
   * useful answer is the *longest* arm that works. `boomRadius` of clearance, so the eye
   * stops above the deck rather than grazing it — the same margin the box query uses.
   */
  private groundClear(boomX: number, boomY: number, boomZ: number, minFraction: number): number {
    const surface = this.surface;
    if (surface === null) return 1;
    /*
     * **A surface answers a height for an (x, z), so it describes a world-Y deck and nothing
     * else.** "Under the deck" and "behind the support plane" are the same sentence only while up
     * is world up; in any other frame this sampler has already chosen which axis is vertical and
     * there is no reading of it that means what this test means. So it is skipped rather than
     * approximated, and the arm is left to the collision sweep, which is frame-agnostic and is the
     * instrument that actually stops the eye entering geometry.
     */
    if (this.boomUpY < 0.999) return 1;
    const hit = this.groundHit;
    const clearance = this.options.boomRadius;
    for (let i = GROUND_SAMPLES; i >= 1; i--) {
      const t = i / GROUND_SAMPLES;
      if (t < minFraction) break;
      const y = this.smoothY + boomY * t;
      if (!surface.sample(this.smoothX + boomX * t, this.smoothZ + boomZ * t, hit, y)) return t;
      if (y >= hit.y + clearance) return t;
    }
    return minFraction;
  }

  /**
   * Point the boom's up at a direction; the rest of the frame follows it.
   *
   * **Forward is carried from the frame it had rather than derived from a world axis**, which is
   * what makes a body walking from a floor onto a wall and onto a ceiling continuous. Deriving it
   * from a fixed reference would be one line shorter and would put a pole wherever `up` lined up
   * with that reference: the arm would swing through a half turn as a subject crossed it, on a rig
   * whose whole job is that the view does not snap.
   *
   * The fallbacks are only reached when the carried forward has become parallel to the new up,
   * which a continuous rotation cannot do in one step and a teleport can. World Z first and world
   * X behind it, so there is always an answer and it is never a normalised zero.
   *
   * A zero-length vector keeps the frame it had, for the reason `setUp` on the character
   * controller gives: a NaN basis is a camera that is nowhere, and every number downstream of it
   * reads as a rig that has failed rather than as an argument that was refused.
   */
  setBoomUp(x: number, y: number, z: number): void {
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length < 1e-6) return;
    const ux = x / length;
    const uy = y / length;
    const uz = z / length;
    if (this.setBasis(ux, uy, uz, this.boomForwardX, this.boomForwardY, this.boomForwardZ)) return;
    if (this.setBasis(ux, uy, uz, 0, 0, 1)) return;
    this.setBasis(ux, uy, uz, 1, 0, 0);
  }

  /**
   * Point the boom's forward at a direction; the up is kept and the arm is rebuilt around it.
   *
   * **For a subject that has a heading of its own, which the carried forward cannot express.**
   * `setBoomUp` keeps whatever forward the frame had, re-projected — the right default, because it
   * is what makes a body walking from a floor onto a wall continuous, and because most subjects
   * have no heading to speak of. What it cannot say is "behind *this*": a yaw of π puts the eye
   * opposite a forward the caller never chose and, until this existed, could not read either. A
   * subject spawning face-on to a wall got a shot framed at random, and a caller trying to work out
   * how far to roll so that the support surface sits at the bottom of the picture had to know where
   * the arm was — an azimuth measured from an axis nothing reported.
   *
   * **This is not a reversal of the carried forward and does not change it for anyone.** A caller
   * that never calls this carries its forward exactly as before, and one that does still has it
   * re-orthogonalised by every `setBoomUp` — the heading is a direction in the world, and the frame
   * it lands in is the surface's.
   *
   * A zero-length vector, or one parallel to the current up, keeps the frame it had. **Deliberately
   * not the fallback chain `setBoomUp` uses**, and the asymmetry is the point: that method must
   * produce *some* forward because the up is what changed and a frame needs one, so an arbitrary
   * axis is better than none. Here the forward is the argument, and answering a direction the
   * caller did not ask for is precisely the failure this exists to fix.
   */
  setBoomForward(x: number, y: number, z: number): void {
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length < 1e-6) return;
    this.setBasis(this.boomUpX, this.boomUpY, this.boomUpZ, x / length, y / length, z / length);
  }

  /**
   * Build the three axes from an up and a candidate forward, or answer false and change nothing.
   *
   * Shared by both setters so that "orthogonalised against the other axis" means one piece of
   * arithmetic rather than two that have to be kept in step. False is the parallel case: there is
   * no forward perpendicular to an up it is already parallel to, and what each caller does about
   * that is the one thing they do differently.
   */
  private setBasis(
    ux: number,
    uy: number,
    uz: number,
    fx: number,
    fy: number,
    fz: number,
  ): boolean {
    const into = fx * ux + fy * uy + fz * uz;
    const px = fx - ux * into;
    const py = fy - uy * into;
    const pz = fz - uz * into;
    const len = Math.sqrt(px * px + py * py + pz * pz);
    if (len <= 1e-4) return false;
    this.boomUpX = ux;
    this.boomUpY = uy;
    this.boomUpZ = uz;
    this.boomForwardX = px / len;
    this.boomForwardY = py / len;
    this.boomForwardZ = pz / len;
    /* Right-handed with the pair above, which is what makes yaw turn the way it always did. */
    this.boomRightX = uy * this.boomForwardZ - uz * this.boomForwardY;
    this.boomRightY = uz * this.boomForwardX - ux * this.boomForwardZ;
    this.boomRightZ = ux * this.boomForwardY - uy * this.boomForwardX;
    return true;
  }

  snap(): void {
    this.snapped = false;
  }

  /**
   * How much of the arm is clear of the world, from whichever source the rig was given.
   *
   * The injected query wins outright where there is one, for the reason its own type gives: a
   * caller with the whole world behind it does not also want a partial answer from a box set.
   */
  private blockedFraction(boomX: number, boomY: number, boomZ: number): number {
    const radius = this.options.boomRadius;
    if (this.obstruction === null) {
      return segmentHit(
        this.smoothX,
        this.smoothY,
        this.smoothZ,
        boomX,
        boomY,
        boomZ,
        this.colliders,
        radius,
      );
    }
    const metres = this.obstruction.distance(
      this.smoothX,
      this.smoothY,
      this.smoothZ,
      boomX,
      boomY,
      boomZ,
      radius,
    );
    if (metres === null) return 1;
    /* The arm's own length rather than the option's, because the arm is what was tested: a pitched
       boom is `boomDistance` long by construction, and reading the option instead would be right
       until somebody changes how the arm is built. */
    const length = Math.sqrt(boomX * boomX + boomY * boomY + boomZ * boomZ);
    if (length <= 1e-6) return 1;
    return clamp(metres / length, 0, 1);
  }

  update(
    frameDt: number,
    yaw: number,
    pitch: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    targetFovYDeg: number,
    /**
     * Roll, radians. The caller's policy: this rig knows nothing about banked
     * surfaces, only that a camera can be tilted. Damped here rather than by
     * the caller so a subject snapping between surfaces cannot snap the view.
     */
    targetRoll = 0,
  ): void {
    const cam = this.camera;
    const options = this.options;
    cam.yaw = yaw;
    /*
     * Damped unless the caller has already done it. See `ThirdPersonCameraOptions.dampRoll`: a
     * consumer with a comfort setting on roll damps it once and applies the same value elsewhere,
     * and damping it again here means the setting no longer says what it asserts.
     */
    this.roll =
      options.dampRoll === false
        ? targetRoll
        : damp(this.roll, targetRoll, options.fovLambda, frameDt);
    cam.roll = this.roll;
    /*
     * Absolute pitch, not a delta. Accumulating here would make the rig own how
     * fast look responds, which is the caller's policy — and a caller whose
     * pitch is simulation state (so an aim ray can be replayed) cannot let a
     * render-rate camera hold the authoritative value. Still clamped, so a
     * caller with no limits of its own cannot invert the view.
     */
    cam.pitch = clamp(pitch, options.pitchMin, options.pitchMax);

    // Captured before the placing branch clears it, because the arm below has to
    // know whether this is the frame that places the rig.
    const placing = !this.snapped;
    if (!this.snapped) {
      this.smoothX = targetX;
      this.smoothY = targetY;
      this.smoothZ = targetZ;
      this.snapped = true;
    } else {
      /*
       * **Tracking rather than a hold, and it is the default rather than an option.**
       *
       * `damp` is exact for a target standing still, and this one is a subject somebody is
       * driving. Holding it still across the interval made the settled distance a function of the
       * frame time — 1.586 m at 60 Hz against 1.376 m at 28 Hz for a 25 m/s subject at this
       * lambda, so a machine that dropped rate re-framed the shot — and made the gap oscillate
       * under uneven frames, which is what a consumer reported as the subject snapping about
       * inside the picture. A camera arm following something that stands still is the rare case,
       * which is why this is not a flag.
       *
       * The velocity is differenced from the target rather than asked for. See `lastTarget*`.
       */
      const inverseDt = frameDt > 0 ? 1 / frameDt : 0;
      const lambda = options.positionLambda;
      const vx = (targetX - this.lastTargetX) * inverseDt;
      const vy = (targetY - this.lastTargetY) * inverseDt;
      const vz = (targetZ - this.lastTargetZ) * inverseDt;
      this.smoothX = dampTracking(this.smoothX, targetX, vx, lambda, frameDt);
      this.smoothY = dampTracking(this.smoothY, targetY, vy, lambda, frameDt);
      this.smoothZ = dampTracking(this.smoothZ, targetZ, vz, lambda, frameDt);
    }
    this.lastTargetX = targetX;
    this.lastTargetY = targetY;
    this.lastTargetZ = targetZ;

    /*
     * **Roll and the field of view keep the hold, deliberately.** Both follow targets that step —
     * a surface change, a speed band — and a one-frame `delta/dt` across a step is a spike, which
     * `dampTracking` would then aim `v/lambda` beyond. The defect measured was the position lag,
     * and a subject's position is the one of the three that moves smoothly by construction.
     */
    this.fov = damp(this.fov, targetFovYDeg, options.fovLambda, frameDt);
    cam.fovYDeg = this.fov;

    const cosPitch = Math.cos(cam.pitch);
    /*
     * The same three terms as before, placed in the boom's frame rather than on the world axes.
     * With the frame left at world up this is identical arithmetic: right is X, up is Y, forward
     * is Z, and each term lands on the axis it used to be written against.
     */
    const alongRight = -Math.sin(cam.yaw) * cosPitch * options.boomDistance;
    const alongUp = -Math.sin(cam.pitch) * options.boomDistance;
    const alongForward = Math.cos(cam.yaw) * cosPitch * options.boomDistance;
    const boomX =
      this.boomRightX * alongRight + this.boomUpX * alongUp + this.boomForwardX * alongForward;
    const boomY =
      this.boomRightY * alongRight + this.boomUpY * alongUp + this.boomForwardY * alongForward;
    const boomZ =
      this.boomRightZ * alongRight + this.boomUpZ * alongUp + this.boomForwardZ * alongForward;
    const blocked = this.blockedFraction(boomX, boomY, boomZ);
    const minFraction = options.boomMinDistance / options.boomDistance;
    /*
     * The ground blocks the arm as surely as a wall does, and it is not in `colliders`.
     * Stepped rather than solved: the surface is an arbitrary query, not a plane, so the
     * arm is sampled along its length and cut at the first station that would put the eye
     * under the deck. A step function is all `segmentHit` returns either, and `Boom`
     * already exists to smooth exactly that.
     */
    const clearOfGround = this.groundClear(boomX, boomY, boomZ, minFraction);
    const clear = Math.max(Math.min(blocked, clearOfGround), minFraction);
    if (placing) this.boom.reset(clear);
    else this.boom.step(clear, options.boomDistance, frameDt);
    const fraction = this.boom.fraction;

    cam.position[0] = this.smoothX + boomX * fraction;
    cam.position[1] = this.smoothY + boomY * fraction;
    cam.position[2] = this.smoothZ + boomZ * fraction;
    this.aimAlongArm(boomX, boomY, boomZ);
  }

  /**
   * Point the camera back down the arm, in the frame the arm was built in.
   *
   * **The arm moved into the boom's basis and the aim did not, and that half-migration is what this
   * closes.** `update` placed the eye using `boomRight`/`boomUp`/`boomForward` and then set
   * `cam.yaw`, `cam.pitch` and `cam.roll` — which `Camera.updateMatrices` reads against the *world*
   * axes. The two agree only while up is world Y. With up at +X, an arm built at yaw 0 lies along
   * the frame's forward while a camera at yaw 0 looks down world −Z: a right angle apart, so the
   * rig put the eye in the right place and rendered the scene beside the subject, with no error
   * anywhere. Reported from outside, where recovering the aim meant inverting this rig's own boom
   * formula from outside it, against a sign convention nothing stated.
   *
   * **Derived rather than taken, so `update`'s signature is unchanged** — the same property R2 held
   * to when it added `setBoomUp` rather than a `basis` parameter.
   *
   * The decomposition is exact and is the inverse of `updateMatrices`' own construction: forward
   * fixes yaw and pitch, and the roll is the angle from the basis that construction would build at
   * those two onto the up the arm was built against. **At the world basis every line here returns
   * what was passed in**, which is asserted rather than assumed — `up` is world Y orthogonalised
   * against forward, which is precisely the up `updateMatrices` derives, so the base roll is zero
   * and the caller's damped roll is all that is left.
   */
  private aimAlongArm(boomX: number, boomY: number, boomZ: number): void {
    const cam = this.camera;
    /* From the eye toward the subject, which is the arm reversed. The eye sits on that ray at any
       boom fraction, so shortening the arm cannot change where the camera looks. */
    const length = Math.sqrt(boomX * boomX + boomY * boomY + boomZ * boomZ);
    if (length <= 1e-6) return;
    const forwardX = -boomX / length;
    const forwardY = -boomY / length;
    const forwardZ = -boomZ / length;

    /* `updateMatrices` reads exactly these two out of the direction it is given. */
    const flat = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ);
    if (flat > 1e-6) cam.yaw = Math.atan2(forwardX, -forwardZ);
    cam.pitch = Math.atan2(forwardY, flat);

    /*
     * The roll that carries the camera's own up onto the arm's.
     *
     * `updateMatrices` builds an unrolled pair from yaw and pitch and then turns it by `roll`,
     * with `up' = up·cos(roll) − right·sin(roll)`. So the roll wanted here is the angle from that
     * unrolled up onto the boom's up, and the caller's damped roll is added on top of it — a lean
     * about the view, which is what a caller means by roll whatever frame it is standing in.
     */
    const cosPitch = Math.cos(cam.pitch);
    const sinPitch = Math.sin(cam.pitch);
    const cosYaw = Math.cos(cam.yaw);
    const sinYaw = Math.sin(cam.yaw);
    const lean = cosPitch < 0 ? -1 : 1;
    const rightX = lean * cosYaw;
    const rightZ = lean * sinYaw;
    const upX = -lean * sinYaw * sinPitch;
    const upY = lean * cosPitch;
    const upZ = lean * cosYaw * sinPitch;

    /* The boom's up, with any component along the view removed: a roll is measured in the plane
       across the view, and the two are not perpendicular for an arm that is pitched. */
    const into = this.boomUpX * forwardX + this.boomUpY * forwardY + this.boomUpZ * forwardZ;
    const wantX = this.boomUpX - forwardX * into;
    const wantY = this.boomUpY - forwardY * into;
    const wantZ = this.boomUpZ - forwardZ * into;
    const wantLength = Math.sqrt(wantX * wantX + wantY * wantY + wantZ * wantZ);
    if (wantLength <= 1e-6) {
      /* Looking straight along the frame's own up: there is no plane to measure a roll in, so the
         caller's is all there is, and the arm is at a pole where yaw is already arbitrary. */
      cam.roll = this.roll;
      return;
    }
    const nx = wantX / wantLength;
    const ny = wantY / wantLength;
    const nz = wantZ / wantLength;
    const alongUp = nx * upX + ny * upY + nz * upZ;
    const alongRight = nx * rightX + nz * rightZ;
    cam.roll = Math.atan2(-alongRight, alongUp) + this.roll;
  }
}

function validateOptions(options: Readonly<ThirdPersonCameraOptions>): void {
  if (options.boomDistance <= 0) {
    throw new Error(`ThirdPersonCamera.boomDistance must be positive, got ${options.boomDistance}`);
  }
  if (options.boomRadius < 0) {
    throw new Error(`ThirdPersonCamera.boomRadius must be non-negative, got ${options.boomRadius}`);
  }
  if (options.boomMinDistance < 0 || options.boomMinDistance > options.boomDistance) {
    throw new Error(
      `ThirdPersonCamera.boomMinDistance must be between 0 and boomDistance, got ${options.boomMinDistance}`,
    );
  }
  if (options.pitchMin > options.pitchMax) {
    throw new Error('ThirdPersonCamera.pitchMin must not exceed pitchMax');
  }
}

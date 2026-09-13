import { BODY_DYNAMIC } from './bodies.ts';
import { createRayHit } from './query.ts';
import type { QueryFilter, RayHit } from './query.ts';
import { capsuleShape, sphereShape } from './shape.ts';
import type { ConvexShape } from './shape.ts';
import type { ShapePose } from './manifold.ts';
import type { PhysicsWorld } from './world.ts';

/**
 * A kinematic capsule character: the mechanism, and the feel that rides on it.
 *
 * **Kinematic and not a dynamic body.** A dynamic character falls over, cannot be steered crisply,
 * and turns every design question about movement into a question about torque. Every shipping
 * engine ships a kinematic controller for exactly that reason, and this one sweeps the same
 * `PhysicsWorld` everything else queries, so it sees moving bodies as well as scenery.
 *
 * **Feel is here too, and that is a decision `AGENTS.md` records.** That file's worked example for
 * the engine/game boundary once said a controller was game because "friction, coyote time and slide
 * boost are one game's feel". The same file's *audio* rule draws the line correctly: the DSP graph
 * is engine and which sounds play is game. A controller that takes a friction curve and a
 * coyote-time duration takes numbers and time, which is what that file says engine APIs take; what
 * stays game is which numbers. **What would make this wrong** is a parameter that only means
 * something in one game.
 *
 * **Coyote time and jump buffering are counted in ticks**, never accumulated in a float of seconds.
 * That is the determinism contract reaching into the feel layer, and the difference between a
 * replay that matches and one that drifts by a frame after an hour of uptime.
 */

export const GROUNDED = 0;
export const AIRBORNE = 1;
export const SLIDING = 2;
export type ControllerState = 0 | 1 | 2;

export interface ControllerOptions {
  radius?: number;
  /** Half the cylindrical section, so total height is `2 * (halfHeight + radius)`. */
  halfHeight?: number;
  /** How high a lip may be and still be walked over. */
  stepHeight?: number;
  /** Cosine of the steepest walkable slope. Above it the character slides. */
  slopeCos?: number;
  maxSpeed?: number;
  acceleration?: number;
  deceleration?: number;
  airControl?: number;
  jumpSpeed?: number;
  /** Upward velocity is cut to this fraction when the jump is released early. */
  jumpCutoff?: number;
  gravity?: number;
  /** Ticks after leaving the ground during which a jump still counts. */
  coyoteTicks?: number;
  /** Ticks a jump press is remembered for, so pressing just before landing still fires. */
  jumpBufferTicks?: number;
  /** Extra downhill acceleration while sliding on too steep a surface. */
  slideBoost?: number;
  /** Impulse scale applied to dynamic bodies the character walks into. */
  pushStrength?: number;
  filter?: QueryFilter;
  /**
   * A surface to stand on beside the bodies, where the world has one.
   *
   * Consulted *after* the bodies and only when they found nothing walkable, so a consumer with
   * both keeps whatever a collider said — a body is a thing that is there, and a surface is a
   * description of where the ground is. Absent means bodies alone, which is every consumer that
   * has not asked.
   */
  ground?: GroundProbe;
}

/**
 * A surface the controller can stand on that is not a body.
 *
 * **Declared structurally, so nothing is imported in either direction.** `@driftengine/core`'s
 * `GroundSurface` satisfies this exactly and neither package names the other — the same shape
 * `ragdollFromBones` uses for a pose, and for the same reason: this package imports no other
 * engine package, and a surface that knew about splines and ribbon meshes could not live here.
 *
 * **Why a character needs one at all.** An analytic surface answers *where the ground is in this
 * column*; a collider answers *what is solid*. They are different questions and a banked deck is
 * where they diverge — a world-axis box over a banked strip has a flat top at the strip's highest
 * corner, so a character standing on the box hovers above the track through every corner. A
 * consumer with such a deck could sweep bodies or stand on the deck, and never both.
 *
 * `atY` is the height of whatever is asking, so a route that passes over itself answers with the
 * deck *under* the asker rather than the highest one in the column.
 *
 * **The field names were `nx`, `ny`, `nz` until 2026-08-28 and that was a defect**, because the
 * paragraph above was not true: `SurfaceHit` spells them `normalX`, `normalY`, `normalZ`, so a real
 * `GroundSurface` handed to a controller wrote three fields nothing read and left three fields
 * nothing wrote. TypeScript allows the assignment — method parameters are bivariant — so it
 * compiled, and a *flat* surface still behaved, because the scratch it was handed happens to start
 * at `(0, 1, 0)`. Only a banked one showed it, by giving the character the normal of whatever body
 * it last touched. Renamed rather than aliased: nothing in three consumers implements this
 * interface, and a compile error naming the field is a one-line fix where a stale normal is a week.
 */
export interface GroundProbeHit {
  /** Height of the surface in this column. */
  y: number;
  normalX: number;
  normalY: number;
  normalZ: number;
}

export interface GroundProbe {
  sample(x: number, z: number, out: GroundProbeHit, atY?: number): boolean;
}

export interface ControllerInput {
  /** Desired direction, in world units per second. Length above `maxSpeed` is clamped. */
  moveX: number;
  moveZ: number;
  /**
   * The third component, for a body whose up is not world Y. Absent means zero, which is what
   * every caller with a level floor means and is arithmetically what they got before this existed.
   *
   * **Two components span the tangent plane only while up is world Y**, and `setUp` made up a
   * parameter without making the input one. On a wall whose normal is +Z, up the wall is +Y and no
   * pair of `moveX` and `moveZ` describes it: the input plane collapses onto a line, so a body that
   * could stand on the wall could not be steered along it. Reported from outside by a consumer that
   * gave up on the acceleration curves, the air control and the speed clamp entirely — writing
   * `velX`/`velY`/`velZ` directly each tick with `acceleration: 0, deceleration: 0` so that
   * `applyFeel` would leave the velocity alone — which is the whole of the feel this class exists
   * to provide, bypassed to get one axis back.
   *
   * Read as a world direction and flattened onto the surface, exactly as the other two are. A
   * caller supplying all three describes "forward" in whatever frame it is standing in.
   */
  moveY?: number;
  /**
   * Whether to flatten the move vector onto the plane the body is standing on. Absent means yes,
   * which is what every caller before this got and what a body moving on one surface wants.
   *
   * **False is for a body between two surfaces, which is the one case the projection cannot
   * serve.** Steering normally holds the along-up component out, steers the rest and puts it back,
   * because that component is gravity and the jump rather than the stick. A body crossing a convex
   * edge has a third thing there: while its frame rotates from the old face to the new, the correct
   * direction of travel is neither face's tangent but a blend of them, held by the contacts already
   * on the far side. Flattened onto the frame's current plane that command is turned aside — by
   * **8.5 degrees early in a 90-degree crossing and more later** — and the body crawls the transfer
   * instead of crossing it. Measured from outside on a sprint across a 90-degree convex edge:
   * contacts decaying from four to none by tick 46, slipping at 46, falling by 51, **21 ticks of 90
   * with nothing under it** against none when the velocity was written directly.
   *
   * **It is the projection and not the acceleration**, which the reporter separated before asking:
   * the same crossing at acceleration times 15, 60, 240 and 2000 of `maxSpeed` gave 21 ticks every
   * time. A lag would have improved.
   *
   * With this false the move vector is the velocity the body is steered toward *whole* — the
   * along-up component included, because a caller that has taken responsibility for the direction
   * has taken responsibility for all of it. Everything else still applies: the speed clamp, the
   * acceleration and deceleration curves, `airControl` when off the ground, and gravity afterwards.
   * That is the difference between this and the direct velocity write it exists to retire, which
   * bypasses all four.
   */
  projectMove?: boolean;
  /** Held, not edge-triggered: the controller does its own edge detection and buffering. */
  jump: boolean;
}

/** How many sweep-and-slide passes one move takes. Fixed, because a tolerance loop is banned. */
const SLIDE_PASSES = 4;
/**
 * How far below the feet a snap looks. Not a skin.
 *
 * There was a skin here, subtracted from the sweep as `fraction − SKIN / travel`, and it made the
 * controller **stop moving entirely** whenever a move was shorter than the skin: a character
 * sliding downhill at a tenth of a metre per second travels 0.0017 m a tick, the term came to ten,
 * the fraction clamped to zero, and it stood still on a slope it should have slid down. The sweep's
 * own stop margin already leaves a tenth of a millimetre of clearance, which is what a skin was for.
 */
const SNAP_EPS = 0.001;

export class CharacterController {
  x = 0;
  y = 0;
  z = 0;
  velX = 0;
  velY = 0;
  velZ = 0;
  state: ControllerState = AIRBORNE;
  /** The surface normal under the feet, meaningful when grounded or sliding. */
  groundX = 0;
  groundY = 1;
  groundZ = 0;

  /**
   * Which way is up for this body, as a unit vector. World up unless a caller says otherwise.
   *
   * **The whole of this class used to assume one axis, and none of it was wrong for doing so.**
   * `velY` was the only representation of vertical velocity, `gravity` was a scalar applied to it,
   * `slopeCos` was measured against world Y, `stepHeight` was a height only because up was fixed,
   * and the three states were decided by a downward probe. That is a complete and correct
   * controller for a body on a floor, and it cannot represent one on a wall at all.
   *
   * A consumer needing one had to reimplement the sweep, the step-over, the slope test and the
   * ground probe — roughly nine hundred lines that would not share this file's contact code, so
   * the two would drift. It is not a gecko's problem: it is every wall-crawler, every
   * arbitrary-gravity level and every walker on the inside of a rotating station.
   *
   * Settable per tick, because a body walking around a corner changes frame continuously and the
   * alternative is rebuilding the controller. Read through `setUp`, which normalises, so the dot
   * products below can assume unit length.
   */
  upX = 0;
  upY = 1;
  upZ = 0;

  /**
   * Which way this body falls, which is not always the way it stands.
   *
   * Tracks `up` until a caller sets it, and that default is the one that keeps every existing
   * consumer unchanged. Kept separate because a support normal and a fall direction are different
   * questions: a body clinging to a wall stands in the wall's frame and may still fall the way the
   * world falls the moment it lets go.
   */
  private gravityX = 0;
  private gravityY = 1;
  private gravityZ = 0;
  /** Whether `setUp` should carry the fall direction with it. Cleared by `setGravityDirection`. */
  private gravityFollowsUp = true;
  /** Which body is being stood on, or −1. */
  groundBody = -1;

  readonly shape: ConvexShape;
  /**
   * A ball the size of the capsule's foot, swept down to find ground.
   *
   * **A single ray from the capsule's axis is not enough**, and the failure is specific: a character
   * balanced on the lip of a step has its axis over open air, the ray misses, it is reported
   * airborne, and stepping is disabled — so it stalls on the edge of the very step it was climbing.
   * A ball finds ground under any part of the foot. It is slightly smaller than the capsule so a
   * wall pressed against the side cannot be mistaken for a floor.
   */
  readonly foot: ConvexShape;
  readonly radius: number;
  readonly halfHeight: number;
  readonly stepHeight: number;
  readonly slopeCos: number;
  readonly maxSpeed: number;
  readonly acceleration: number;
  readonly deceleration: number;
  readonly airControl: number;
  readonly jumpSpeed: number;
  readonly jumpCutoff: number;
  readonly gravity: number;
  readonly coyoteTicks: number;
  readonly jumpBufferTicks: number;
  readonly slideBoost: number;
  readonly pushStrength: number;
  readonly filter: QueryFilter | undefined;

  /** Ticks since the character last had ground under it. */
  private airTicks = 0;
  /** Ticks since a jump was pressed and not yet used. */
  private bufferTicks = -1;
  private jumpHeld = false;
  private rising = false;
  private pose: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private hit: RayHit = createRayHit();
  /** `tryStep` needs its own, because it sweeps twice and `hit` is still being read afterwards. */
  private stepHit: RayHit = createRayHit();
  private ground: RayHit = createRayHit();
  /** The analytic surface, where a consumer supplied one. See `GroundProbe`. */
  private readonly probe: GroundProbe | null;
  /** Scratch for the probe, claimed once: `senseGround` runs every tick. */
  private readonly probed: GroundProbeHit = {
    y: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
  };

  constructor(options: ControllerOptions = {}) {
    this.radius = options.radius ?? 0.35;
    this.halfHeight = options.halfHeight ?? 0.6;
    this.shape = capsuleShape(this.radius, this.halfHeight);
    this.foot = sphereShape(this.radius * 0.95);
    this.stepHeight = options.stepHeight ?? 0.35;
    this.slopeCos = options.slopeCos ?? 0.7;
    this.maxSpeed = options.maxSpeed ?? 5;
    this.acceleration = options.acceleration ?? 40;
    this.deceleration = options.deceleration ?? 30;
    this.airControl = options.airControl ?? 0.3;
    this.jumpSpeed = options.jumpSpeed ?? 6;
    this.jumpCutoff = options.jumpCutoff ?? 0.4;
    this.gravity = options.gravity ?? -20;
    this.coyoteTicks = options.coyoteTicks ?? 6;
    this.jumpBufferTicks = options.jumpBufferTicks ?? 6;
    this.slideBoost = options.slideBoost ?? 8;
    this.pushStrength = options.pushStrength ?? 1;
    this.filter = options.filter;
    this.probe = options.ground ?? null;
  }

  /**
   * Point this body's up at a direction, normalising it.
   *
   * A zero-length vector is refused rather than normalised into a NaN frame, because every dot
   * product below would then answer NaN and the states would read as a body that is nowhere. It
   * keeps the frame it had, which is the defined state the two-backends rule asks for in the
   * renderer and is the right answer here for the same reason.
   */
  setUp(x: number, y: number, z: number): void {
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length < 1e-6) return;
    this.upX = x / length;
    this.upY = y / length;
    this.upZ = z / length;
    if (this.gravityFollowsUp) {
      this.gravityX = this.upX;
      this.gravityY = this.upY;
      this.gravityZ = this.upZ;
    }
  }

  /**
   * Point the fall direction somewhere other than up, and stop it following.
   *
   * The sign convention is `up`'s: `gravity` is negative, so this is the direction a *rise* goes
   * and gravity is applied against it. That is the same arithmetic as before — `velY += gravity *
   * dt` with a gravity of −20 is an acceleration along −Y — generalised rather than reversed.
   */
  setGravityDirection(x: number, y: number, z: number): void {
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length < 1e-6) return;
    this.gravityX = x / length;
    this.gravityY = y / length;
    this.gravityZ = z / length;
    this.gravityFollowsUp = false;
  }

  /** This body's speed along its own up. What `velY` was when up was always world Y. */
  get speedAlongUp(): number {
    return this.velX * this.upX + this.velY * this.upY + this.velZ * this.upZ;
  }

  /** Set that component, leaving the tangent velocity exactly as it was. */
  private setSpeedAlongUp(speed: number): void {
    const delta = speed - this.speedAlongUp;
    this.velX += this.upX * delta;
    this.velY += this.upY * delta;
    this.velZ += this.upZ * delta;
  }

  /** Place the character, clearing whatever it was doing. */
  teleport(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.velX = 0;
    this.velY = 0;
    this.velZ = 0;
    this.state = AIRBORNE;
    this.airTicks = this.coyoteTicks + 1;
  }

  /** Advance one fixed tick. */
  move(world: PhysicsWorld, dt: number, input: ControllerInput): void {
    this.senseGround(world);
    this.applyFeel(dt, input);
    this.sweep(world, dt);
    this.standOnSurface(dt);
    this.senseGround(world);
  }

  /**
   * Let the analytic surface stop a descent, the way a body would have.
   *
   * **Without this a probe is a sensor and not a floor, and that was the shape of it until
   * 2026-08-28.** `senseGround` read the surface and set `GROUNDED`, and nothing anywhere put the
   * feet back on it: the sweep resolves bodies, the surface is not a body, so a character over a
   * purely analytic world sank through it at gravity. It reported `GROUNDED` for three ticks while
   * the gap stayed inside the six-centimetre tolerance, then went airborne and fell for ever —
   * measured at ten metres under the floor after one second. Every test the seam had ran a single
   * tick from feet already exactly on the surface, which is the one arrangement that cannot see it.
   *
   * A consumer with terrain therefore had to hold their own character up, which is the hundred
   * lines they reported writing, and to write them again for anything else that stands on ground.
   *
   * **Only a descent this tick could have caused, which is what keeps it a floor rather than a
   * magnet.** A character that is under the surface by more than this tick's fall is under it for
   * some other reason — spawned in a cellar, walked into a tunnel, thrown through by an impulse —
   * and hoisting them would be teleporting them through whatever is over their head. Rising is left
   * alone entirely, so a jump leaves.
   */
  private standOnSurface(dt: number): void {
    /*
     * **A `GroundProbe` answers a height for an (x, z), so it describes a world-Y surface and
     * nothing else.** There is no reading of it in a tilted frame: `sample(x, z)` has already
     * chosen which axis is vertical. So this holds a body up only in the frame the probe is
     * written in, and a consumer standing on a wall is standing on a collider rather than on an
     * analytic surface. Skipped rather than approximated, because an approximation here is a body
     * hoisted along the wrong axis, which is worse than not being hoisted.
     */
    if (this.upY < 0.999) return;
    if (this.probe === null || this.velY > 0) return;
    const feet = this.y - this.halfHeight - this.radius;
    if (!this.probe.sample(this.x, this.z, this.probed, this.y)) return;
    const sunk = this.probed.y - feet;
    if (sunk < 0) return;
    /* This tick's fall, plus the same tolerance `senseGround` calls standing on something. */
    if (sunk > -this.velY * dt + 0.06) return;
    this.y = this.probed.y + this.halfHeight + this.radius;
    this.velY = 0;
  }

  /* ---------- feel ---------- */

  private applyFeel(dt: number, input: ControllerInput): void {
    const grounded = this.state === GROUNDED;
    if (grounded) this.airTicks = 0;
    else this.airTicks++;

    // Edge detection and buffering, both in ticks.
    if (input.jump && !this.jumpHeld) this.bufferTicks = 0;
    else if (this.bufferTicks >= 0) this.bufferTicks++;
    if (this.bufferTicks > this.jumpBufferTicks) this.bufferTicks = -1;
    this.jumpHeld = input.jump;

    // Steering, with less authority in the air.
    let wantX = input.moveX;
    let wantY = input.moveY ?? 0;
    let wantZ = input.moveZ;
    const want = Math.sqrt(wantX * wantX + wantY * wantY + wantZ * wantZ);
    if (want > this.maxSpeed) {
      wantX = (wantX / want) * this.maxSpeed;
      wantY = (wantY / want) * this.maxSpeed;
      wantZ = (wantZ / want) * this.maxSpeed;
    }
    const authority = grounded ? 1 : this.airControl;
    const rate = want > 0 ? this.acceleration : this.deceleration;
    const step = rate * authority * dt;

    /*
     * **Steering happens in the tangent plane, and the input is read as a world direction.**
     *
     * With up at world Y and no `moveY`, this is exactly what it was: the wanted vector has no Y
     * component, the projection removes nothing, and approaching the three components approaches
     * `velX` and `velZ` while leaving `velY` alone. With up anywhere else, the same input describes
     * a direction in the world that is flattened onto the surface the body is standing on, which is
     * what a caller means by "forward" when forward is along a wall — and `moveY` is what lets that
     * direction leave the world XZ plane at all. See `ControllerInput.moveY`.
     *
     * The speed along up is held out and put back rather than being steered, because it belongs to
     * gravity and the jump and not to the stick.
     *
     * **Unless the caller says the command is already the velocity it wants**, which is a body
     * between two surfaces and is the one case this plane is the wrong one to read in. See
     * `ControllerInput.projectMove`. The whole vector is steered then, at the same rate and under
     * the same clamp and air control — only the plane is given up, not the feel.
     */
    if (input.projectMove === false) {
      this.velX = approach(this.velX, wantX, step);
      this.velY = approach(this.velY, wantY, step);
      this.velZ = approach(this.velZ, wantZ, step);
    } else {
      const alongUp = this.speedAlongUp;
      let tangentX = this.velX - this.upX * alongUp;
      let tangentY = this.velY - this.upY * alongUp;
      let tangentZ = this.velZ - this.upZ * alongUp;
      const wantIntoUp = wantX * this.upX + wantY * this.upY + wantZ * this.upZ;
      const wantTangentX = wantX - this.upX * wantIntoUp;
      const wantTangentY = wantY - this.upY * wantIntoUp;
      const wantTangentZ = wantZ - this.upZ * wantIntoUp;
      tangentX = approach(tangentX, wantTangentX, step);
      tangentY = approach(tangentY, wantTangentY, step);
      tangentZ = approach(tangentZ, wantTangentZ, step);
      this.velX = tangentX + this.upX * alongUp;
      this.velY = tangentY + this.upY * alongUp;
      this.velZ = tangentZ + this.upZ * alongUp;
    }

    if (this.state === SLIDING) {
      /*
       * Downhill along the surface: the gravity direction projected onto the plane. A slide that
       * simply disabled control would leave a character stuck on a slope it cannot climb, which
       * reads as being caught on geometry rather than as sliding.
       */
      const n = this.groundX * this.upX + this.groundY * this.upY + this.groundZ * this.upZ;
      const downX = -(this.groundX - this.upX * n) * n;
      const downY = -(this.groundY - this.upY * n) * n;
      const downZ = -(this.groundZ - this.upZ * n) * n;
      this.velX += downX * this.slideBoost * dt;
      this.velY += downY * this.slideBoost * dt;
      this.velZ += downZ * this.slideBoost * dt;
    }

    this.velX += this.gravityX * this.gravity * dt;
    this.velY += this.gravityY * this.gravity * dt;
    this.velZ += this.gravityZ * this.gravity * dt;
    if (this.speedAlongUp <= 0) this.rising = false;

    // A jump is allowed while grounded, or within coyote ticks of having been.
    const mayJump = this.airTicks <= this.coyoteTicks && this.state !== SLIDING;
    if (this.bufferTicks >= 0 && mayJump) {
      this.setSpeedAlongUp(this.jumpSpeed);
      this.bufferTicks = -1;
      this.airTicks = this.coyoteTicks + 1;
      this.rising = true;
      this.state = AIRBORNE;
    } else if (this.rising && !input.jump) {
      // Released early: cut the rise, which is what makes a tap shorter than a hold.
      this.setSpeedAlongUp(this.speedAlongUp * this.jumpCutoff);
      this.rising = false;
    }
  }

  /* ---------- mechanism ---------- */

  /**
   * Sweep, slide along whatever was hit, and try again — a fixed number of times.
   *
   * A step is attempted before sliding: lift by the step height, sweep forward, and drop. A
   * character that slid off every lip would catch on kerbs and stair nosings, which reads as the
   * world being sticky rather than as the character being short.
   */
  private sweep(world: PhysicsWorld, dt: number): void {
    let dx = this.velX * dt;
    let dy = this.velY * dt;
    let dz = this.velZ * dt;

    for (let pass = 0; pass < SLIDE_PASSES; pass++) {
      const travel = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (travel < 1e-6) return;
      this.readPose();
      if (!world.shapecast(this.shape, this.pose, dx, dy, dz, this.hit, this.filter)) {
        this.x += dx;
        this.y += dy;
        this.z += dz;
        return;
      }

      const t = this.hit.fraction;
      this.x += dx * t;
      this.y += dy * t;
      this.z += dz * t;
      this.push(world, this.hit.body, this.hit.nx, this.hit.ny, this.hit.nz);

      let remainX = dx * (1 - t);
      let remainY = dy * (1 - t);
      let remainZ = dz * (1 - t);

      /*
       * Try to step over the lip before sliding along it. The normal is read out first, because
       * `tryStep` sweeps twice and the projection below still needs it — sharing one `RayHit`
       * between them left the slide projecting against whatever the step's own sweep last found,
       * which stopped the character dead at every kerb.
       */
      const hx = this.hit.nx;
      const hy = this.hit.ny;
      const hz = this.hit.nz;
      const intoUp = hx * this.upX + hy * this.upY + hz * this.upZ;
      if (
        intoUp < this.slopeCos &&
        this.state === GROUNDED &&
        this.tryStep(world, remainX, remainY, remainZ)
      ) {
        return;
      }

      // Project what is left onto the surface, which is what turns a stop into a slide.
      const into = remainX * hx + remainY * hy + remainZ * hz;
      remainX -= hx * into;
      remainY -= hy * into;
      remainZ -= hz * into;
      const vInto = this.velX * hx + this.velY * hy + this.velZ * hz;
      if (vInto < 0) {
        this.velX -= hx * vInto;
        this.velY -= hy * vInto;
        this.velZ -= hz * vInto;
      }
      dx = remainX;
      dy = remainY;
      dz = remainZ;
    }
  }

  /**
   * Lift, sweep forward, drop. Returns whether the whole step was taken.
   *
   * **The lift and the drop are along this body's up rather than along world Y**, which is what
   * makes `stepHeight` a height rather than a Y offset. The forward part is the remainder of the
   * move flattened into the tangent plane, for the same reason: what is left of a blocked move
   * includes whatever of it was along up, and lifting by the step height and then also moving up
   * would climb twice.
   */
  private tryStep(world: PhysicsWorld, dx: number, dy: number, dz: number): boolean {
    const startX = this.x;
    const startY = this.y;
    const startZ = this.z;
    const liftX = this.upX * this.stepHeight;
    const liftY = this.upY * this.stepHeight;
    const liftZ = this.upZ * this.stepHeight;

    const intoUp = dx * this.upX + dy * this.upY + dz * this.upZ;
    const flatX = dx - this.upX * intoUp;
    const flatY = dy - this.upY * intoUp;
    const flatZ = dz - this.upZ * intoUp;

    this.x += liftX;
    this.y += liftY;
    this.z += liftZ;
    this.readPose();
    if (world.shapecast(this.shape, this.pose, flatX, flatY, flatZ, this.stepHit, this.filter)) {
      this.x = startX;
      this.y = startY;
      this.z = startZ;
      return false;
    }
    this.x += flatX;
    this.y += flatY;
    this.z += flatZ;
    this.readPose();
    if (world.shapecast(this.shape, this.pose, -liftX, -liftY, -liftZ, this.stepHit, this.filter)) {
      const drop = this.stepHeight * this.stepHit.fraction - SNAP_EPS;
      this.x -= this.upX * drop;
      this.y -= this.upY * drop;
      this.z -= this.upZ * drop;
      return true;
    }
    // Nothing beneath the lifted position, so this was a gap rather than a step.
    this.x = startX;
    this.y = startY;
    this.z = startZ;
    return false;
  }

  /**
   * Sweep the foot ball down, and fall back to a ray when what it finds is not walkable.
   *
   * The ball is what lets a character stand on the lip of a step: a ray from the capsule's axis has
   * open air beneath it there, reports airborne, and disables the stepping that was carrying it up.
   *
   * **But a ball also brushes the side of the ledge it is walking off**, and a wall's normal is
   * horizontal, so the ball alone reported *sliding* — which refused the coyote-time jump the
   * character had every right to. So a non-walkable ball result is not trusted on its own: a ray
   * down the axis decides whether there is genuinely a steep surface underfoot, or merely a wall
   * beside it. Two cheap queries, and each covers the other's blind spot.
   */
  private senseGround(world: PhysicsWorld): void {
    this.readPose();
    this.pose.x = this.x - this.upX * this.halfHeight;
    this.pose.y = this.y - this.upY * this.halfHeight;
    this.pose.z = this.z - this.upZ * this.halfHeight;
    const reach = this.radius * 0.05 + 0.06;
    if (
      world.shapecast(
        this.foot,
        this.pose,
        -this.upX * reach,
        -this.upY * reach,
        -this.upZ * reach,
        this.ground,
        this.filter,
      )
    ) {
      const intoUp =
        this.ground.nx * this.upX + this.ground.ny * this.upY + this.ground.nz * this.upZ;
      if (intoUp >= this.slopeCos) {
        this.groundX = this.ground.nx;
        this.groundY = this.ground.ny;
        this.groundZ = this.ground.nz;
        this.groundBody = this.ground.body;
        this.state = GROUNDED;
        return;
      }
    }
    const axis = this.halfHeight + this.radius + 0.06;
    if (
      !world.raycast(
        this.x,
        this.y,
        this.z,
        -this.upX,
        -this.upY,
        -this.upZ,
        axis,
        this.ground,
        this.filter,
      )
    ) {
      /*
       * Nothing solid under the feet. Ask the surface, where there is one — a banked deck is
       * exactly the case a collider answers badly, and a consumer with one would otherwise be
       * reported airborne while standing on it.
       *
       * Asked last rather than first, and that ordering is the decision: a body is a thing that
       * is *there* and a surface is a description of where the ground *is*, so anything solid
       * wins. A consumer with no probe reaches none of this.
       */
      if (this.probe !== null) {
        const feet = this.y - this.halfHeight - this.radius;
        if (
          this.probe.sample(this.x, this.z, this.probed, this.y) &&
          this.probed.y <= feet + 0.06
        ) {
          if (feet - this.probed.y <= 0.06) {
            this.groundX = this.probed.normalX;
            this.groundY = this.probed.normalY;
            this.groundZ = this.probed.normalZ;
            /* No body holds this character up, and −1 is what that has always meant. */
            this.groundBody = -1;
            this.state = this.probed.normalY >= this.slopeCos ? GROUNDED : SLIDING;
            return;
          }
        }
      }
      this.state = AIRBORNE;
      this.groundBody = -1;
      return;
    }
    this.groundX = this.ground.nx;
    this.groundY = this.ground.ny;
    this.groundZ = this.ground.nz;
    this.groundBody = this.ground.body;
    this.state = this.ground.ny >= this.slopeCos ? GROUNDED : SLIDING;
  }

  /*
   * **There was a `snapToGround` here and it is gone, because it was measured and did nothing.**
   *
   * The idea is standard: horizontal speed can carry the feet past a crest faster than gravity
   * pulls them down, so a controller pulls them back onto a surface just below. This one never
   * fired at all at first — it ran only while still grounded, and at a crest the ground sense has
   * already said airborne — and once that ordering was fixed it made the result *worse*. Descending
   * a sharp forty-degree crest at six metres a second, the largest gap between the feet and the
   * surface was **0.490 metres with it and 0.457 without**, over 120 ticks.
   *
   * The sweep-and-slide already follows a surface closely enough that there is nothing left for a
   * snap to correct, because the slide projection puts the remaining motion *along* the surface
   * rather than through it. **What would bring it back** is a measurement showing a visible hop at
   * a crest that the slide does not absorb — at which point the instrument to build first is the
   * foot-gap probe above, not the airborne-tick count, which reports a state rather than a distance
   * and called this feature useful when it was inert.
   */

  /**
   * Push a dynamic body the character walked into, so a crate is not a wall.
   *
   * **The push carries the character's speed, not its per-tick step.** Adding the displacement —
   * four metres a second comes to 0.067 of a metre in a tick — is less than the impulse ground
   * friction takes off a crate in the same tick, so the crate is pushed and immediately stopped and
   * never moves at all. Measured: a 30 kg crate under 0.5 friction shed 0.082 a tick against 0.067
   * put in.
   *
   * So it sets a *target* rather than accumulating: the body is brought up to the character's own
   * speed into the surface, scaled by `pushStrength`, and never slowed if it is already faster.
   * **What this gives up** is momentum transfer — a heavy crate moves as readily as a light one,
   * because a kinematic character has no mass to trade. **What would make it wrong** is a consumer
   * wanting mass to matter, and the answer then is a dynamic character, which §12 refuses for
   * reasons that have nothing to do with this.
   */
  private push(world: PhysicsWorld, body: number, nx: number, ny: number, nz: number): void {
    if (body < 0 || this.pushStrength === 0) return;
    if (world.bodies.type[body] !== BODY_DYNAMIC) return;
    if ((world.bodies.invMass[body] ?? 0) === 0) return;
    // The surface normal points at the character, so the push goes the other way.
    const into = -(this.velX * nx + this.velY * ny + this.velZ * nz);
    if (into <= 0) return;
    const want = into * this.pushStrength;
    const already = -(
      (world.bodies.velX[body] ?? 0) * nx +
      (world.bodies.velY[body] ?? 0) * ny +
      (world.bodies.velZ[body] ?? 0) * nz
    );
    if (already >= want) return;
    const add = want - already;
    world.bodies.velX[body] = (world.bodies.velX[body] ?? 0) - nx * add;
    world.bodies.velY[body] = (world.bodies.velY[body] ?? 0) - ny * add;
    world.bodies.velZ[body] = (world.bodies.velZ[body] ?? 0) - nz * add;
    world.wakeIsland(body);
  }

  /**
   * The capsule at this body's position, standing along this body's up.
   *
   * **The quaternion used to be left at identity**, which was right while up was always world Y
   * and is the one thing that cannot be left out once it is not: a body on a wall whose capsule is
   * still world-vertical is swept against the wall by its side rather than its foot, so it rests a
   * radius away instead of standing on it.
   *
   * The shortest arc from world Y to `up`, built directly rather than through an axis-angle,
   * because the half-angle form is one square root. **The half turn is the case that has to be
   * written out**: an up of exactly −Y makes the cross product zero and `w` zero with it, which
   * normalises to NaN, and there is no shortest arc to pick because every arc is the same length.
   * A turn about X is chosen, which is as good as any and is stable.
   */
  private readPose(): void {
    this.pose.x = this.x;
    this.pose.y = this.y;
    this.pose.z = this.z;
    const w = 1 + this.upY;
    if (w < 1e-6) {
      this.pose.qx = 1;
      this.pose.qy = 0;
      this.pose.qz = 0;
      this.pose.qw = 0;
      return;
    }
    const qx = this.upZ;
    const qz = -this.upX;
    const inverse = 1 / Math.sqrt(qx * qx + qz * qz + w * w);
    this.pose.qx = qx * inverse;
    this.pose.qy = 0;
    this.pose.qz = qz * inverse;
    this.pose.qw = w * inverse;
  }
}

/** Move `from` toward `to` by at most `step`. */
function approach(from: number, to: number, step: number): number {
  const d = to - from;
  if (d > step) return from + step;
  if (d < -step) return from - step;
  return to;
}

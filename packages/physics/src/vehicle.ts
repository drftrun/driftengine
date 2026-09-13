import { createRayHit } from './query.ts';
import type { QueryFilter, RayHit } from './query.ts';
import type { PhysicsWorld } from './world.ts';
import type { GroundProbe, GroundProbeHit } from './controller.ts';

/**
 * A raycast vehicle: a chassis body, and wheels that are rays rather than bodies.
 *
 * **Rigid wheels on joints are the obvious alternative and are unstable in practice.** They need
 * joint stiffness and substep counts that nobody wants to pay, which is why Bullet, Godot and Unity
 * all raycast. *What that costs, said where the decision is:* a raycast wheel cannot wedge in
 * geometry, cannot collide with another wheel, and a vehicle on its side behaves as a box rather
 * than as a car. *What would reverse it* is a game about vehicles interlocking with terrain.
 *
 * **The tyre curve is a table the caller supplies.** Pacejka's magic formula is `sin(atan(…))` and
 * both are banned from the tick, so grip is sampled from a curve and linearly interpolated. This is
 * the one place in Track B where the arithmetic contract produced a *better* API than the closed
 * form it replaced: a curve is edited by moving a point, and a magic formula is edited by guessing
 * at a coefficient nobody can picture.
 *
 * Everything here is applied as an impulse at a point on the chassis, so the vehicle's roll, pitch
 * and weight transfer fall out of the solver rather than being modelled separately.
 */

/**
 * Grip against slip, as a lookup table.
 *
 * `force[i]` is the fraction of the load available as lateral or longitudinal force at
 * `slip[i]`. Both arrays are the same length and `slip` must ascend. Beyond the last entry the
 * final value is held, which is what a tyre past its peak does.
 */
export interface TyreCurve {
  readonly slip: Float32Array;
  readonly force: Float32Array;
}

/** A curve that rises to a peak and falls away, which is what a tyre does. */
export function defaultTyreCurve(peak = 1): TyreCurve {
  return {
    slip: new Float32Array([0, 0.1, 0.2, 0.4, 0.8, 1.5]),
    force: new Float32Array([0, peak * 0.75, peak, peak * 0.9, peak * 0.75, peak * 0.7]),
  };
}

export interface WheelOptions {
  /** Where the suspension is anchored, in the chassis's local frame. */
  x: number;
  y: number;
  z: number;
  radius?: number;
  /** How far the wheel may travel below its anchor. */
  suspensionTravel?: number;
  /** Spring rate, in newtons per metre of compression. */
  stiffness?: number;
  /** Damping, in newtons per metre per second. */
  damping?: number;
  /** Whether steering input turns this wheel. */
  steers?: boolean;
  /** Whether engine and brake force reach it. */
  driven?: boolean;
}

export interface VehicleOptions {
  wheels: readonly WheelOptions[];
  /** Maximum steering angle, as the tangent of the angle rather than the angle. */
  maxSteerTangent?: number;
  /** Newtons at full throttle, shared across driven wheels. */
  engineForce?: number;
  /** Newtons at full brake. */
  brakeForce?: number;
  longitudinal?: TyreCurve;
  lateral?: TyreCurve;
  filter?: QueryFilter;
  /**
   * A surface the wheels can rest on that is not a body.
   *
   * The same seam `CharacterController` takes, and here for the same reason plus one: a consumer
   * whose ground is a height function had a character that stood on it and a car that fell through
   * it, so the world's floor was two things that had to be kept in step by hand. It was reported
   * that way — a hundred lines of ground query written consumer-side, and then written again for
   * everything else that stands on it.
   *
   * Consulted only where the wheel's ray found no body, on the same ruling the controller carries:
   * a body is a thing that is there and a surface is a description of where the ground is.
   */
  ground?: GroundProbe;
}

export interface VehicleInput {
  /** −1 to 1. */
  throttle: number;
  /** 0 to 1. */
  brake: number;
  /** −1 to 1, scaled by `maxSteerTangent`. */
  steer: number;
}

export class Vehicle {
  readonly chassis: number;
  readonly wheelCount: number;
  /** Whether each wheel found ground on the last update. */
  readonly grounded: Uint8Array;
  /** How far each wheel's suspension is compressed, in metres. */
  readonly compression: Float32Array;
  /** Where each wheel's contact is, xyz-packed. Meaningful where `grounded`. */
  readonly contact: Float32Array;

  private readonly local: Float32Array;
  private readonly radius: Float32Array;
  private readonly travel: Float32Array;
  private readonly stiffness: Float32Array;
  private readonly damping: Float32Array;
  private readonly steers: Uint8Array;
  private readonly driven: Uint8Array;
  private readonly maxSteerTangent: number;
  private readonly engineForce: number;
  private readonly brakeForce: number;
  private readonly longitudinal: TyreCurve;
  private readonly lateral: TyreCurve;
  /**
   * The suspension ray must ignore the car it holds up.
   *
   * A wheel anchor sits *inside* the chassis by construction — that is what a suspension mount is —
   * and a ray starting inside a body reports that body at fraction zero, which is the right answer
   * to the question a line-of-sight test asks and the wrong one here. Left unfiltered, every wheel
   * found the chassis at zero distance, read the suspension as fully compressed, and pushed the car
   * against itself: it sank onto its own chassis and sat there.
   */
  private readonly filter: QueryFilter;
  private readonly hit: RayHit = createRayHit();
  private readonly probe: GroundProbe | null;
  /** Scratch for the probe, claimed once: every wheel asks it every tick. */
  private readonly probed: GroundProbeHit = { y: 0, normalX: 0, normalY: 1, normalZ: 0 };
  /**
   * Every wheel's impulse, gathered before any is applied: `rx ry rz px py pz` per wheel.
   *
   * **Applying them one at a time makes the car curve.** Each wheel then sees a velocity the
   * previous wheel has already changed, so the left front's lateral impulse biases what the right
   * front computes, and the asymmetry accumulates into a yaw rather than cancelling. Measured on a
   * symmetric car under straight throttle: 0.011 metres of drift after 2 metres, 0.64 after 39, and
   * **5.49 after 155** — a curve, not a wobble. Forces at an instant are simultaneous, and gathering
   * them is both the correct physics and the cheaper fix.
   */
  private readonly pending: Float64Array;

  constructor(chassis: number, options: VehicleOptions) {
    this.chassis = chassis;
    this.wheelCount = options.wheels.length;
    const n = this.wheelCount;
    this.local = new Float32Array(n * 3);
    this.radius = new Float32Array(n);
    this.travel = new Float32Array(n);
    this.stiffness = new Float32Array(n);
    this.damping = new Float32Array(n);
    this.steers = new Uint8Array(n);
    this.driven = new Uint8Array(n);
    this.grounded = new Uint8Array(n);
    this.compression = new Float32Array(n);
    this.contact = new Float32Array(n * 3);
    options.wheels.forEach((w, i) => {
      this.local[i * 3] = w.x;
      this.local[i * 3 + 1] = w.y;
      this.local[i * 3 + 2] = w.z;
      this.radius[i] = w.radius ?? 0.35;
      this.travel[i] = w.suspensionTravel ?? 0.3;
      this.stiffness[i] = w.stiffness ?? 40000;
      this.damping[i] = w.damping ?? 4000;
      this.steers[i] = w.steers ? 1 : 0;
      this.driven[i] = w.driven ? 1 : 0;
    });
    this.maxSteerTangent = options.maxSteerTangent ?? 0.6;
    this.engineForce = options.engineForce ?? 6000;
    this.brakeForce = options.brakeForce ?? 9000;
    this.longitudinal = options.longitudinal ?? defaultTyreCurve(1.2);
    this.lateral = options.lateral ?? defaultTyreCurve(1.4);
    this.filter = { ...options.filter, ignore: chassis };
    this.probe = options.ground ?? null;
    this.pending = new Float64Array(n * 6);
  }

  /** Advance the vehicle one fixed tick. Call before `world.step`. */
  update(world: PhysicsWorld, dt: number, input: VehicleInput): void {
    const body = this.chassis;
    const bodies = world.bodies;
    this.pending.fill(0);
    let drivenCount = 0;
    for (let i = 0; i < this.wheelCount; i++) if (this.driven[i]) drivenCount++;
    const perWheelDrive = drivenCount > 0 ? (input.throttle * this.engineForce) / drivenCount : 0;

    for (let i = 0; i < this.wheelCount; i++) {
      rotate(bodies, body, this.local, i * 3, ANCHOR);
      const ax = (bodies.posX[body] ?? 0) + ANCHOR[0];
      const ay = (bodies.posY[body] ?? 0) + ANCHOR[1];
      const az = (bodies.posZ[body] ?? 0) + ANCHOR[2];

      // The suspension looks along the chassis's own down, not world down.
      axis(bodies, body, 0, -1, 0, DOWN);
      const reach = (this.travel[i] ?? 0) + (this.radius[i] ?? 0);
      if (
        !world.raycast(ax, ay, az, DOWN[0], DOWN[1], DOWN[2], reach, this.hit, this.filter) &&
        !this.probeUnder(ax, ay, az, reach)
      ) {
        this.grounded[i] = 0;
        this.compression[i] = 0;
        continue;
      }
      this.grounded[i] = 1;
      this.contact[i * 3] = this.hit.x;
      this.contact[i * 3 + 1] = this.hit.y;
      this.contact[i * 3 + 2] = this.hit.z;

      const distance = this.hit.fraction * reach;
      /*
       * Compression is capped at the travel. Past that the wheel is bottomed out and the *chassis*
       * takes the load through its own collider, which is what a bump stop is.
       *
       * **No test here reaches it, and that is worth saying rather than leaving somebody to look.**
       * With wheels mounted inside the chassis — the ordinary arrangement — the chassis collider
       * meets the ground before the suspension can bottom out, so removing this line changes a drop
       * from six metres by a centimetre and nothing else. It stays because a vehicle with outboard
       * mounts *can* reach it, and an uncapped spring then answers a hard landing with several
       * times the car's weight.
       */
      let compression = reach - distance;
      const bumpStop = this.travel[i] ?? 0;
      if (compression > bumpStop) compression = bumpStop;
      this.compression[i] = compression;

      // The anchor's velocity, which is what the damper answers to.
      pointVelocity(bodies, body, ANCHOR, VEL);
      const alongDown = VEL[0] * DOWN[0] + VEL[1] * DOWN[1] + VEL[2] * DOWN[2];
      /*
       * **The damper adds to the load while the spring is compressing.** `alongDown` is positive
       * when the anchor is moving toward the ground, which is exactly when compression is
       * increasing, so a damper opposing that motion pushes *up*. Subtracting it instead — which is
       * what `k·x − c·v` reads like if `v` is taken as the wrong sign — leaves the spring undamped
       * and clamps the load to zero on the way down: the car fell, bounced on a pure spring, and
       * launched itself upside down.
       */
      let load = (this.stiffness[i] ?? 0) * compression + (this.damping[i] ?? 0) * alongDown;
      if (load < 0) load = 0;
      // Along the surface normal rather than along the ray, so a slope pushes sideways too.
      this.gather(
        i,
        ANCHOR,
        this.hit.nx * load * dt,
        this.hit.ny * load * dt,
        this.hit.nz * load * dt,
      );

      // The wheel's own frame: forward turned by steering, and lateral across it.
      const steer = this.steers[i] ? input.steer * this.maxSteerTangent : 0;
      axis(bodies, body, steer, 0, 1, FORWARD);
      normalise(FORWARD);
      axis(bodies, body, 1, 0, -steer, SIDE);
      normalise(SIDE);
      // Flattened onto the surface, so grip acts along the ground rather than into it.
      project(FORWARD, this.hit.nx, this.hit.ny, this.hit.nz);
      project(SIDE, this.hit.nx, this.hit.ny, this.hit.nz);
      normalise(FORWARD);
      normalise(SIDE);

      pointVelocity(bodies, body, ANCHOR, VEL);
      const vForward = VEL[0] * FORWARD[0] + VEL[1] * FORWARD[1] + VEL[2] * FORWARD[2];
      const vSide = VEL[0] * SIDE[0] + VEL[1] * SIDE[1] + VEL[2] * SIDE[2];
      const speed = Math.sqrt(vForward * vForward + vSide * vSide);

      /*
       * Slip is the sideways or braking velocity against the speed the wheel is going, which is what
       * a tyre curve is indexed by. At a standstill the ratio is undefined, so the slip is taken as
       * the velocity itself — a stationary car with a sideways nudge should still resist it.
       */
      const denom = speed > 1 ? speed : 1;
      const lateralGrip = sampleTyreCurve(this.lateral, Math.abs(vSide) / denom) * load;
      const sideImpulse = clampMagnitude(-vSide * massAt(bodies, body), lateralGrip * dt);
      this.gather(i, ANCHOR, SIDE[0] * sideImpulse, SIDE[1] * sideImpulse, SIDE[2] * sideImpulse);

      let forwardForce = this.driven[i] ? perWheelDrive : 0;
      if (input.brake > 0) {
        const brake = input.brake * this.brakeForce;
        forwardForce += vForward > 0 ? -brake : brake;
      }
      const traction = sampleTyreCurve(this.longitudinal, Math.abs(vForward) / denom) * load;
      const limit = traction > 0 ? traction : load;
      const drive = clampMagnitude(forwardForce, limit);
      this.gather(
        i,
        ANCHOR,
        FORWARD[0] * drive * dt,
        FORWARD[1] * drive * dt,
        FORWARD[2] * drive * dt,
      );
    }

    // Now apply, all from the state every wheel was measured against.
    for (let i = 0; i < this.wheelCount; i++) {
      const at = i * 6;
      ANCHOR[0] = this.pending[at];
      ANCHOR[1] = this.pending[at + 1];
      ANCHOR[2] = this.pending[at + 2];
      applyImpulse(
        bodies,
        body,
        ANCHOR,
        this.pending[at + 3],
        this.pending[at + 4],
        this.pending[at + 5],
      );
    }
    world.wakeIsland(body);
  }

  /** Add an impulse at a wheel's anchor to what will be applied at the end of the pass. */
  /**
   * Rest a wheel on the analytic surface, filling `hit` as a ray against a body would have.
   *
   * Everything downstream — the spring, the damper, the tyre frame flattened onto the ground —
   * reads `hit`, so filling it is the whole of the wiring and no grip code learns that a surface
   * exists.
   *
   * **The column is the anchor's own and the drop is measured along the chassis's down**, which is
   * exact while the chassis is upright and off by its tilt when it is not: the true contact sits a
   * little to the side of the column that was sampled, and on a slope that column is a little
   * higher or lower than the contact. At the lean angles a car spends its life at the error is
   * millimetres, and the alternative is solving a ray against an arbitrary height function, which
   * is an iteration this package does not allow itself. A vehicle on its roof finds no ground here
   * at all, because there is no downward intersection to find, which is the honest answer.
   */
  private probeUnder(ax: number, ay: number, az: number, reach: number): boolean {
    if (this.probe === null || DOWN[1] >= 0) return false;
    if (!this.probe.sample(ax, az, this.probed, ay)) return false;
    const distance = (this.probed.y - ay) / DOWN[1];
    if (!(distance >= 0) || distance > reach) return false;
    this.hit.body = -1;
    this.hit.fraction = distance / reach;
    this.hit.x = ax + DOWN[0] * distance;
    this.hit.y = ay + DOWN[1] * distance;
    this.hit.z = az + DOWN[2] * distance;
    this.hit.nx = this.probed.normalX;
    this.hit.ny = this.probed.normalY;
    this.hit.nz = this.probed.normalZ;
    return true;
  }

  private gather(i: number, r: Float64Array, px: number, py: number, pz: number): void {
    const at = i * 6;
    this.pending[at] = r[0];
    this.pending[at + 1] = r[1];
    this.pending[at + 2] = r[2];
    this.pending[at + 3] += px;
    this.pending[at + 4] += py;
    this.pending[at + 5] += pz;
  }
}

/** Sample a curve at `at`, holding the last value beyond its end. */
export function sampleTyreCurve(curve: TyreCurve, at: number): number {
  const n = curve.slip.length;
  if (n === 0) return 0;
  if (at <= (curve.slip[0] ?? 0)) return curve.force[0] ?? 0;
  for (let i = 1; i < n; i++) {
    const s1 = curve.slip[i] ?? 0;
    if (at <= s1) {
      const s0 = curve.slip[i - 1] ?? 0;
      const span = s1 - s0;
      const t = span > 0 ? (at - s0) / span : 0;
      const f0 = curve.force[i - 1] ?? 0;
      return f0 + ((curve.force[i] ?? 0) - f0) * t;
    }
  }
  return curve.force[n - 1] ?? 0;
}

const ANCHOR = new Float64Array(3);
const DOWN = new Float64Array(3);
const FORWARD = new Float64Array(3);
const SIDE = new Float64Array(3);
const VEL = new Float64Array(3);
const INV_I = new Float32Array(6);

function clampMagnitude(v: number, limit: number): number {
  if (v > limit) return limit;
  if (v < -limit) return -limit;
  return v;
}

/** A representative mass at the anchor, for turning a wanted velocity change into an impulse. */
function massAt(bodies: PhysicsWorld['bodies'], body: number): number {
  const im = bodies.invMass[body] ?? 0;
  return im > 0 ? 1 / im : 0;
}

function normalise(v: Float64Array): void {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return;
  v[0] /= len;
  v[1] /= len;
  v[2] /= len;
}

/** Remove the component of `v` along a normal, leaving it in the surface. */
function project(v: Float64Array, nx: number, ny: number, nz: number): void {
  const d = v[0] * nx + v[1] * ny + v[2] * nz;
  v[0] -= nx * d;
  v[1] -= ny * d;
  v[2] -= nz * d;
}

function rotate(
  bodies: PhysicsWorld['bodies'],
  i: number,
  src: Float32Array,
  at: number,
  out: Float64Array,
): void {
  const x = src[at] ?? 0;
  const y = src[at + 1] ?? 0;
  const z = src[at + 2] ?? 0;
  const qx = bodies.rotX[i] ?? 0;
  const qy = bodies.rotY[i] ?? 0;
  const qz = bodies.rotZ[i] ?? 0;
  const qw = bodies.rotW[i] ?? 1;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/** A direction in the body's frame, rotated into world. */
function axis(
  bodies: PhysicsWorld['bodies'],
  i: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const qx = bodies.rotX[i] ?? 0;
  const qy = bodies.rotY[i] ?? 0;
  const qz = bodies.rotZ[i] ?? 0;
  const qw = bodies.rotW[i] ?? 1;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

function pointVelocity(
  bodies: PhysicsWorld['bodies'],
  i: number,
  r: Float64Array,
  out: Float64Array,
): void {
  const wx = bodies.angX[i] ?? 0;
  const wy = bodies.angY[i] ?? 0;
  const wz = bodies.angZ[i] ?? 0;
  out[0] = (bodies.velX[i] ?? 0) + (wy * r[2] - wz * r[1]);
  out[1] = (bodies.velY[i] ?? 0) + (wz * r[0] - wx * r[2]);
  out[2] = (bodies.velZ[i] ?? 0) + (wx * r[1] - wy * r[0]);
}

function applyImpulse(
  bodies: PhysicsWorld['bodies'],
  i: number,
  r: Float64Array,
  px: number,
  py: number,
  pz: number,
): void {
  const im = bodies.invMass[i] ?? 0;
  if (im === 0) return;
  bodies.velX[i] = (bodies.velX[i] ?? 0) + px * im;
  bodies.velY[i] = (bodies.velY[i] ?? 0) + py * im;
  bodies.velZ[i] = (bodies.velZ[i] ?? 0) + pz * im;
  bodies.worldInverseInertia(i, INV_I);
  const tx = r[1] * pz - r[2] * py;
  const ty = r[2] * px - r[0] * pz;
  const tz = r[0] * py - r[1] * px;
  bodies.angX[i] =
    (bodies.angX[i] ?? 0) + (INV_I[0] ?? 0) * tx + (INV_I[3] ?? 0) * ty + (INV_I[4] ?? 0) * tz;
  bodies.angY[i] =
    (bodies.angY[i] ?? 0) + (INV_I[3] ?? 0) * tx + (INV_I[1] ?? 0) * ty + (INV_I[5] ?? 0) * tz;
  bodies.angZ[i] =
    (bodies.angZ[i] ?? 0) + (INV_I[4] ?? 0) * tx + (INV_I[5] ?? 0) * ty + (INV_I[2] ?? 0) * tz;
}

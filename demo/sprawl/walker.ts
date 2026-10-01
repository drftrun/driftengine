/**
 * The walker: a character on the city's collision, at the reference's numbers, or a free eye.
 *
 * **Each region collides as the one mesh body the bake made of its coarse level**, admitted as the
 * region arrives (`StaticRegions`) and kept: a city's collision is small beside its geometry, and a
 * body removed as the walker leaves would have to be rebuilt when they turn back.
 *
 * **Stepped at a fixed rate, seen between steps**: `step` advances the character one tick and
 * `eye` interpolates the last two ticks on `alpha`, so the view does not judder at a refresh rate
 * that is not a multiple of the step. **F** leaves the ground for free flight — no collision, the
 * eye where it looks — and back, the character set down where the eye was.
 *
 * Keys: W A S D or the arrows to walk, Shift to run, Space to jump, F to fly; the mouse looks, the
 * pointer locked on the first click.
 */
import {
  BODY_STATIC,
  CharacterController,
  PhysicsWorld,
  StaticRegions,
  meshShape,
} from '../../packages/core/src/index';
import type { InputSource } from '../../packages/core/src/index';

/** Metres a second walking; running is `RUN` times it. */
const WALK = 4.4;
const RUN = 2.3;
const JUMP = 6.9;
/** The eye above the feet, the body's radius, and the tallest lip a step takes. */
const EYE = 1.7;
const RADIUS = 0.42;
const STEP = 0.45;
/** The body from the soles to the crown: its eye a hand under the top of it. */
const HEIGHT = 1.8;
/** How far the eye stands above the body's centre. */
const EYE_ABOVE_CENTRE = EYE - HEIGHT / 2;
/** Metres a second in flight, and how much faster running. */
const FLY = 24;
const FLY_RUN = 4;
/** Radians a pixel of mouse travel turns the view. */
const LOOK = 0.0025;
const PITCH_LIMIT = 1.5;

export class Walker {
  readonly physics = new PhysicsWorld();
  private readonly regions = new StaticRegions(this.physics);
  private readonly body = new CharacterController({
    radius: RADIUS,
    halfHeight: HEIGHT / 2 - RADIUS,
    stepHeight: STEP,
    maxSpeed: WALK * RUN,
    jumpSpeed: JUMP,
  });
  yaw = 0;
  pitch = 0;
  flying = false;
  private readonly now = new Float64Array(3);
  private readonly before = new Float64Array(3);
  private readonly mouse = { dx: 0, dy: 0 };
  private readonly move = { moveX: 0, moveZ: 0, jump: false };

  constructor(private readonly input: InputSource | null) {}

  /** Stand at (x, y, z) — y the ground — facing `yaw`. */
  place(x: number, y: number, z: number, yaw: number): void {
    this.body.teleport(x, y + HEIGHT / 2, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.now[0] = x;
    this.now[1] = y + EYE;
    this.now[2] = z;
    this.before.set(this.now);
  }

  /** Take to the air at `height` metres over where the walker stands. */
  fly(height: number): void {
    this.flying = true;
    this.now[1] = height;
    this.before.set(this.now);
  }

  /** A region's collision, once, as it arrives. */
  admit(id: number, collision: { positions: Float32Array; indices: Uint32Array } | null): void {
    if (collision === null || this.regions.has(id)) return;
    this.regions.add(id, {
      type: BODY_STATIC,
      shape: meshShape(collision.positions, collision.indices),
    });
  }

  /** One fixed tick of `dt` seconds. */
  step(dt: number): void {
    this.before.set(this.now);
    const input = this.input;
    let forward = 0;
    let side = 0;
    let running = false;
    let jump = false;
    if (input !== null) {
      input.consumeMouseDelta(this.mouse);
      this.yaw -= this.mouse.dx * LOOK;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - this.mouse.dy * LOOK));
      forward =
        (input.isDown('KeyW') || input.isDown('ArrowUp') ? 1 : 0) -
        (input.isDown('KeyS') || input.isDown('ArrowDown') ? 1 : 0);
      side =
        (input.isDown('KeyD') || input.isDown('ArrowRight') ? 1 : 0) -
        (input.isDown('KeyA') || input.isDown('ArrowLeft') ? 1 : 0);
      running = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      jump = input.isDown('Space');
      if (input.consumeKeyPress('KeyF')) this.toggleFlight();
    }
    /* Forward along the yaw, and right of it: forward × up. */
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const rx = -fz;
    const rz = fx;
    const length = Math.hypot(forward, side) || 1;
    if (this.flying) {
      const speed = FLY * (running ? FLY_RUN : 1);
      const up = Math.sin(this.pitch);
      const level = Math.cos(this.pitch);
      this.now[0] =
        (this.now[0] as number) + ((fx * level * forward + rx * side) / length) * speed * dt;
      this.now[1] = (this.now[1] as number) + ((up * forward) / length) * speed * dt;
      this.now[2] =
        (this.now[2] as number) + ((fz * level * forward + rz * side) / length) * speed * dt;
      return;
    }
    const speed = WALK * (running ? RUN : 1);
    this.move.moveX = ((fx * forward + rx * side) / length) * speed;
    this.move.moveZ = ((fz * forward + rz * side) / length) * speed;
    this.move.jump = jump;
    this.body.move(this.physics, dt, this.move);
    this.now[0] = this.body.x;
    this.now[1] = this.body.y + EYE_ABOVE_CENTRE;
    this.now[2] = this.body.z;
  }

  /** Where the eye is, between the last two ticks. */
  eye(alpha: number, out: Float32Array): void {
    for (let a = 0; a < 3; a++) {
      out[a] =
        (this.before[a] as number) + ((this.now[a] as number) - (this.before[a] as number)) * alpha;
    }
  }

  private toggleFlight(): void {
    this.flying = !this.flying;
    /* Set down where the eye was, to fall to whatever is under it. */
    if (!this.flying)
      this.body.teleport(
        this.now[0] as number,
        (this.now[1] as number) - EYE_ABOVE_CENTRE,
        this.now[2] as number,
      );
  }
}

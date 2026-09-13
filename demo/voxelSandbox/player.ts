/**
 * A body that walks, swims, jumps and does not clip through the grid.
 *
 * **Split out of the reference's `PlayerController`, which was 374 lines doing four jobs**: it
 * read the browser, moved a body, collided it, and edited the world on click. Input lives in
 * `playerInput.ts` and edits with it; what is here takes an intent and moves. That split is also
 * what makes this testable at all — the reference's version cannot run without a canvas.
 *
 * The angles follow `Camera`'s convention exactly, because the camera is driven from them:
 * forward is `(sinYaw·cosPitch, sinPitch, −cosYaw·cosPitch)`. Getting the sign wrong here makes
 * `W` walk somewhere other than where you are looking, which reads as broken input rather than as
 * broken arithmetic.
 */
import type { Vec3 } from '../../packages/core/src/index';

import { Block, blockDef } from './blocks';
import { WORLD_H } from './constants';
import type { BlockSource } from './world';

/* The reference's numbers, unchanged: they are what the movement feels like. */
const WALK_SPEED = 5.6;
const SPRINT = 1.6;
const FLY_SPEED = 12;
const GRAVITY = 30;
const JUMP_VELOCITY = 9.2;
const MAX_FALL = 55;
const SWIM_UP_SPEED = 4.6;
const SWIM_SINK_SPEED = 1.7;
const WATER_DRAG = 9;
const PLAYER_HALF_W = 0.3;
const PLAYER_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;

/** What the body is being asked to do this frame. Rebuilt in place by the caller. */
export interface PlayerIntent {
  /** Forward is +1, back is −1. */
  forward: number;
  /** Right is +1, left is −1. */
  strafe: number;
  jump: boolean;
  sprint: boolean;
  /** Held, not toggled: the caller owns the toggle so a key repeat cannot flap it. */
  flying: boolean;
}

export class Player {
  readonly position: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  vy = 0;
  onGround = false;

  /** Rewritten each `step`, so a caller can aim a ray without recomputing the angles. */
  readonly forward: Vec3 = [0, 0, -1];

  private readonly blocks: BlockSource;

  constructor(blocks: BlockSource, spawn: { x: number; y: number; z: number }) {
    this.blocks = blocks;
    this.position[0] = spawn.x;
    this.position[1] = spawn.y;
    this.position[2] = spawn.z;
    this.freeFromSolids();
  }

  /**
   * Put the body somewhere and free it, as construction does.
   *
   * The spawn is asked for twice: once against a world that generates on demand, and again once
   * the region around it is real, because a tree stamped from a neighbouring chunk's margin can
   * land on the column the first answer chose. This is how the second answer is applied.
   */
  placeAt(spawn: { x: number; y: number; z: number }): void {
    this.position[0] = spawn.x;
    this.position[1] = spawn.y;
    this.position[2] = spawn.z;
    /* A body that has just been put somewhere is not falling yet. */
    this.vy = 0;
    this.onGround = false;
    this.freeFromSolids();
  }

  /**
   * Lift the body out of anything solid it starts inside.
   *
   * **A last resort, and it exists because the first line of defence is not enough.** `findSpawn`
   * checks two clear cells above the ground, which is correct for the column it examines — and a
   * tree stamped from a neighbouring chunk's margin, or a block the player placed before saving,
   * can occupy that space anyway. Being stuck inside terrain is unrecoverable without it: the
   * axis-by-axis resolve refuses every direction at once, so the body cannot walk out of a wall
   * it began in.
   *
   * Upward, because up is the direction with a guaranteed exit: the world is open above.
   */
  private freeFromSolids(): void {
    for (let lift = 0; lift < WORLD_H; lift++) {
      if (!this.collides(this.position[0], this.position[1], this.position[2])) return;
      this.position[1] += 1;
    }
  }

  /** Where the eye sits, which is what the camera and the reach ray both use. */
  eyeY(): number {
    return this.position[1] + EYE_HEIGHT;
  }

  get inWater(): boolean {
    const x = Math.floor(this.position[0]);
    const z = Math.floor(this.position[2]);
    const feet = this.position[1];
    return (
      this.blocks.getBlock(x, Math.floor(feet), z) === Block.WATER ||
      this.blocks.getBlock(x, Math.floor(feet + 0.9), z) === Block.WATER
    );
  }

  step(dtSec: number, intent: PlayerIntent): void {
    const cosPitch = Math.cos(this.pitch);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    this.forward[0] = sinYaw * cosPitch;
    this.forward[1] = Math.sin(this.pitch);
    this.forward[2] = -cosYaw * cosPitch;

    /* Movement uses the look direction flattened to the ground, so looking at your feet does not
       slow you down. Right is forward rotated a quarter turn: (cosYaw, 0, sinYaw). */
    let mx = intent.forward * sinYaw + intent.strafe * cosYaw;
    let mz = intent.forward * -cosYaw + intent.strafe * sinYaw;

    const len = Math.hypot(mx, mz);
    let dx = 0;
    let dz = 0;
    if (len > 0) {
      const base = intent.flying ? FLY_SPEED : WALK_SPEED * (intent.sprint ? SPRINT : 1);
      const scale = (base * dtSec) / len;
      dx = mx * scale;
      dz = mz * scale;
    }

    if (intent.flying) {
      /* No gravity and no collision cost while flying, but still no walking through walls: the
         horizontal resolve below runs either way. */
      this.vy = 0;
      const lift = (intent.jump ? 1 : 0) - (intent.sprint ? 1 : 0);
      this.moveHorizontal(dx, dz);
      this.position[1] += lift * FLY_SPEED * dtSec;
      this.onGround = false;
    } else if (this.inWater) {
      /* Heavy drag toward a target speed rather than a jump: holding the ascend key climbs, and
         releasing sinks gently, so you can dive in and get back out. */
      const target = intent.jump ? SWIM_UP_SPEED : -SWIM_SINK_SPEED;
      this.vy += (target - this.vy) * Math.min(1, WATER_DRAG * dtSec);
      this.onGround = false;
      this.moveHorizontal(dx, dz);
      this.moveVertical(this.vy * dtSec);
    } else {
      if (intent.jump && this.onGround) {
        this.vy = JUMP_VELOCITY;
        this.onGround = false;
      }
      this.vy = Math.max(this.vy - GRAVITY * dtSec, -MAX_FALL);
      this.moveHorizontal(dx, dz);
      this.moveVertical(this.vy * dtSec);
    }

    this.position[1] = Math.max(1, Math.min(WORLD_H - PLAYER_HEIGHT, this.position[1]));
  }

  /** Whether a block at this cell would be inside the body. Placement checks it. */
  intersectsBlock(bx: number, by: number, bz: number): boolean {
    const [x, feet, z] = this.position;
    return (
      bx >= Math.floor(x! - PLAYER_HALF_W) &&
      bx <= Math.floor(x! + PLAYER_HALF_W) &&
      by >= Math.floor(feet!) &&
      by <= Math.floor(feet! + PLAYER_HEIGHT - 1e-4) &&
      bz >= Math.floor(z! - PLAYER_HALF_W) &&
      bz <= Math.floor(z! + PLAYER_HALF_W)
    );
  }

  getState(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    return {
      x: this.position[0],
      y: this.position[1],
      z: this.position[2],
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  setState(s: { x: number; y: number; z: number; yaw: number; pitch: number }): void {
    this.position[0] = s.x;
    this.position[1] = s.y;
    this.position[2] = s.z;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.vy = 0;
    this.onGround = false;
    /* A saved position can land inside a block the world no longer agrees about. */
    this.freeFromSolids();
  }

  /** The void floor counts as solid, so a fall through the world bottom stops rather than never
      ending. Above the world is open sky. */
  private solidAt(bx: number, by: number, bz: number): boolean {
    if (by < 0) return true;
    if (by >= WORLD_H) return false;
    return blockDef(this.blocks.getBlock(bx, by, bz))?.collidable === true;
  }

  /** Whether the body's box at this position overlaps anything solid. */
  private collides(x: number, feetY: number, z: number): boolean {
    const minX = Math.floor(x - PLAYER_HALF_W);
    const maxX = Math.floor(x + PLAYER_HALF_W);
    const minY = Math.floor(feetY);
    const maxY = Math.floor(feetY + PLAYER_HEIGHT - 1e-4);
    const minZ = Math.floor(z - PLAYER_HALF_W);
    const maxZ = Math.floor(z + PLAYER_HALF_W);
    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          if (this.solidAt(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /**
   * One axis at a time, which is what makes a body slide along a wall instead of stopping dead
   * against it. Resolving both together would refuse the whole move whenever either was blocked.
   */
  private moveHorizontal(dx: number, dz: number): void {
    const [x, feetY, z] = this.position as [number, number, number];
    if (dx !== 0 && !this.collides(x + dx, feetY, z)) this.position[0] = x + dx;
    if (dz !== 0 && !this.collides(this.position[0], feetY, z + dz)) this.position[2] = z + dz;
  }

  /** Vertical move, snapping to contact so a landing sits exactly on the surface. */
  private moveVertical(dy: number): void {
    const next = this.position[1] + dy;
    if (!this.collides(this.position[0], next, this.position[2])) {
      this.position[1] = next;
      this.onGround = false;
      return;
    }
    if (dy < 0) {
      this.position[1] = Math.floor(next) + 1;
      this.onGround = true;
    } else if (dy > 0) {
      /* Bumped the ceiling: sit the head just under it rather than an arbitrary fraction into it. */
      this.position[1] = Math.floor(next + PLAYER_HEIGHT) - PLAYER_HEIGHT;
    }
    this.vy = 0;
  }
}

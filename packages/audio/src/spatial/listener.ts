import type { MixConsole } from '../mix/console.ts';
import { resolveZones, type ReverbZone } from './zones.ts';

/**
 * Where the ears are, how they are pointed, and how fast they are moving.
 *
 * One per console. Everything placed in the world reads this: a panner needs the facing, doppler
 * needs the velocity, and a reverb zone needs the position. Holding it here rather than passing it
 * to each source is what keeps those three from disagreeing about where the listener is within one
 * frame — a disagreement that is inaudible as a cause and reads as sources drifting.
 *
 * **The engine never asks a consumer for the world.** Position and facing arrive as numbers, and
 * the one thing that needs geometry — whether something is in the way — arrives as a function the
 * consumer closes over its own colliders. This package depends on nothing and this is where that
 * would have been spent if it were going to be.
 */

/**
 * How blocked the straight line between two points is: 0 clear, 1 solid.
 *
 * A consumer closes this over whatever it already has — a collider set, a tile map, a navmesh —
 * and the engine never learns what a wall is. Intermediate values are honest and useful: a railing
 * is not a wall, and returning 0.3 for one is better than choosing between two lies.
 */
export type OcclusionProbe = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) => number;

/**
 * The largest speed a listener is allowed to be moving, metres per second.
 *
 * Not a physical limit — it is a guard against a position that jumped. Roughly Mach 1, so anything
 * a game moves a camera at is under it and a teleport that slipped past `warp` is clamped to
 * something that merely sounds wrong rather than dividing by zero in the doppler ratio.
 */
const MAX_SPEED = 340;

export class AudioListenerGraph {
  /** Set by the consumer; called by whatever wants to know if something is in the way. */
  probe: OcclusionProbe | null = null;

  private posX = 0;
  private posY = 0;
  private posZ = 0;
  private velX = 0;
  private velY = 0;
  private velZ = 0;
  private placed = false;
  private elapsed = 0;
  private readonly zones: ReverbZone[] = [];
  /**
   * What each zone is being sent, owned here rather than read back off the send.
   *
   * Reused across frames rather than rebuilt: this is written every time the listener moves, and a
   * map per frame is an allocation in a per-frame path.
   */
  private readonly zoneAmounts = new Map<ReverbZone, number>();
  /** How many sources are placed against this listener, for spreading their probes apart. */
  private sourceCount = 0;

  constructor(private readonly mix: MixConsole) {}

  /** The mix this listener belongs to. A source needs it for a bus and for the context. */
  get console(): MixConsole {
    return this.mix;
  }

  /**
   * Seconds of listener time, accumulated from the frame steps it is given.
   *
   * Accumulated rather than read off a clock, because nothing under this package may reach for
   * `performance.now` on a path a consumer might simulate, and because an offline render has no
   * wall time at all — a mix rendered faster than real time still has to stagger its probes the
   * same way the live one does.
   */
  get elapsedSec(): number {
    return this.elapsed;
  }

  /** Register a space this listener can be inside. See `addReverbZone`. */
  addZone(zone: ReverbZone): void {
    this.zones.push(zone);
  }

  /** What that zone is currently being sent, from where the listener is standing. */
  zoneSend(zone: ReverbZone): number {
    return this.zoneAmounts.get(zone) ?? 0;
  }

  /** Claim a probe slot. The index is what spreads one source's turn away from its neighbours'. */
  claimProbeSlot(): number {
    return this.sourceCount++;
  }

  get probeSlots(): number {
    return this.sourceCount;
  }

  get x(): number {
    return this.posX;
  }
  get y(): number {
    return this.posY;
  }
  get z(): number {
    return this.posZ;
  }
  get velocityX(): number {
    return this.velX;
  }
  get velocityY(): number {
    return this.velY;
  }
  get velocityZ(): number {
    return this.velZ;
  }

  /**
   * Place and point the listener for this frame.
   *
   * `yaw` 0 faces −Z and `pitch` is positive looking up, which is the convention every camera in
   * this engine uses and the one `stereoPan` already documents. The two agree by construction here
   * rather than by coincidence, so a source panned the cheap way and a source panned through a
   * panner land on the same side of the head.
   *
   * **Velocity is derived rather than taken.** A caller passing both a position and a velocity can
   * make them disagree, and doppler needs only the component along the line to a source. Cost: a
   * position that jumps reads as enormous speed, which is what `warp` and `MAX_SPEED` are between.
   */
  set(x: number, y: number, z: number, yaw: number, pitch: number, dtSec: number): void {
    if (dtSec > 0) this.elapsed += dtSec;
    if (this.placed && dtSec > 0) {
      this.velX = clampSpeed((x - this.posX) / dtSec);
      this.velY = clampSpeed((y - this.posY) / dtSec);
      this.velZ = clampSpeed((z - this.posZ) / dtSec);
    }
    this.posX = x;
    this.posY = y;
    this.posZ = z;
    this.placed = true;

    const cosPitch = Math.cos(pitch);
    const forwardX = Math.sin(yaw) * cosPitch;
    const forwardY = Math.sin(pitch);
    const forwardZ = -Math.cos(yaw) * cosPitch;
    const sinPitch = Math.sin(pitch);
    const upX = -Math.sin(yaw) * sinPitch;
    const upY = cosPitch;
    const upZ = Math.cos(yaw) * sinPitch;

    this.write(x, y, z, forwardX, forwardY, forwardZ, upX, upY, upZ);

    if (this.zones.length > 0) {
      resolveZones(this.zones, x, y, z, this.zoneAmounts);
      for (const [zone, amount] of this.zoneAmounts) zone.from.send(zone.bus, amount);
    }
  }

  /**
   * Move the listener without it having travelled.
   *
   * A teleport, a respawn, a camera cut. The next frame is measured from here, not from where the
   * listener was, so nothing derives a speed from a jump that never happened.
   */
  warp(x: number, y: number, z: number): void {
    this.posX = x;
    this.posY = y;
    this.posZ = z;
    this.velX = 0;
    this.velY = 0;
    this.velZ = 0;
    this.placed = true;
  }

  /**
   * Write the listener, through whichever surface this browser has.
   *
   * `positionX` and the parameters beside it are the modern form and can be ramped; `setPosition`
   * and `setOrientation` are deprecated and step. Both are present in Chromium here, measured
   * 2026-08-24; **WebKit is the reason the second branch exists and it cannot be verified from this
   * machine.** Cost: on the legacy path a fast listener steps rather than glides, which is audible
   * as a faint zipper on a hard turn. What would make this wrong is WebKit gaining the parameters,
   * at which point the branch is dead code and should be deleted rather than kept for symmetry.
   *
   * Values are assigned rather than ramped even on the modern path. A ramp per component per frame
   * is nine scheduled events sixty times a second for a value that is already being sampled every
   * block, and the smoothing that matters — the one a listener can hear — is the panner's own
   * interpolation between blocks.
   */
  private write(
    x: number,
    y: number,
    z: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void {
    const listener = this.mix.context.listener;
    if (listener === undefined || listener === null) return;
    const modern = listener as unknown as Record<string, { value: number } | undefined>;
    if (modern.positionX !== undefined && modern.forwardX !== undefined) {
      setValue(modern.positionX, x);
      setValue(modern.positionY, y);
      setValue(modern.positionZ, z);
      setValue(modern.forwardX, fx);
      setValue(modern.forwardY, fy);
      setValue(modern.forwardZ, fz);
      setValue(modern.upX, ux);
      setValue(modern.upY, uy);
      setValue(modern.upZ, uz);
      return;
    }
    const legacy = listener as unknown as {
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (
        fx: number,
        fy: number,
        fz: number,
        ux: number,
        uy: number,
        uz: number,
      ) => void;
    };
    legacy.setPosition?.(x, y, z);
    legacy.setOrientation?.(fx, fy, fz, ux, uy, uz);
  }
}

function setValue(param: { value: number } | undefined, value: number): void {
  if (param !== undefined) param.value = value;
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, -MAX_SPEED), MAX_SPEED);
}

/** The listener for a console. One per mix; everything placed in the world reads it. */
export function createListener(mix: MixConsole): AudioListenerGraph {
  return new AudioListenerGraph(mix);
}

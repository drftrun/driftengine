import { createInstanceData, writeInstance } from './instancedMesh.ts';
import type { InstanceData } from './instancedMesh.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * A pool's per-particle stream, as a particle material reads it.
 *
 * Separate from `InstanceData` — which is a *scatter* stream, built for placing
 * thousands of static plants — because the two want different things and sharing
 * one of them cost this engine its whole particle look. A blade of grass needs a
 * yaw and a wind response and is opaque; a puff of smoke needs an **age**, a
 * **seed** and an **opacity**, and has no wind of its own because its velocity
 * already carries it.
 *
 * Lacking those three, the scatter path had to fake the one that matters: a
 * particle "faded" by having its colour multiplied toward black, which is a real
 * fade only if the material is additive. Drawn through the opaque foliage shader
 * it is not a fade at all — it is a grain turning into a black cube — and that,
 * rather than any tuning, is why every effect built on this read as raw.
 */
export interface ParticleInstances {
  /** World position, three floats each. */
  positions: Float32Array;
  /**
   * Metres from the centre to an edge, a half-width: the quad spans twice this. Then radians of
   * roll about the particle's own axis. This said metres across until 4.8.3, and a caller who took
   * it at its word drew every particle twice as wide as meant.
   */
  sizes: Float32Array;
  spins: Float32Array;
  /** Linear colour, three floats each. */
  colors: Float32Array;
  /** Opacity, 0 to 1 — a real one, not a colour standing in for it. */
  alphas: Float32Array;
  /** Age as a share of this particle's own life, for anything that evolves. */
  ages: Float32Array;
  /** Per-particle randomness, so neighbours never animate together. */
  seeds: Float32Array;
  /** Current velocity, three floats each: what a streak is stretched along. */
  velocities: Float32Array;
  /**
   * A sprite's flipbook frame, one float each: its whole part names a cell of the image, counted
   * across then down from the top-left, and its fraction is how far toward the next a batch that
   * blends cells has come. Read by the `'sprite'` material alone. Absent is frame 0.
   */
  frames?: Float32Array;
  /**
   * A sprite's half-height in metres, one float each, beside `sizes`' half-width — a sprite need
   * not be square. Read by the `'sprite'` material alone; absent or 0 is as tall as it is wide.
   */
  heights?: Float32Array;
  count: number;
  capacity: number;
}

/**
 * Floats one particle takes in a buffer a caller's own compute writes (`DeviceParticles`), in this
 * order: position 3, half-width 1, roll 1, colour 3, opacity 1, age 1, seed 1, velocity 3, a
 * sprite's frame 1 and its half-height 1 — `ParticleInstances`' streams, interleaved as the pool's
 * own upload interleaves them. 64 bytes a particle.
 */
export const DEVICE_PARTICLE_FLOATS = 16;

/**
 * Particles a caller's own compute shader wrote into a buffer of its own (`registerCompute`), drawn
 * where they lie by `drawDeviceParticles` rather than read back and uploaded again. WebGPU only.
 *
 * **Not sorted**, as a pool's are where its batch asks: the device holds them, so an alpha-blended
 * set that must be drawn far to near sorts itself. A slot with a half-width of 0 draws nothing, which
 * is how a fixed-size buffer holds fewer live particles than it has room for.
 */
export interface DeviceParticles {
  /** A buffer with `VERTEX` usage, `DEVICE_PARTICLE_FLOATS` floats a particle. */
  readonly buffer: GPUBuffer;
  /** How many particles from its start to draw; no more than the buffer holds. */
  readonly count: number;
}

function createParticleInstances(capacity: number): ParticleInstances {
  return {
    positions: new Float32Array(capacity * 3),
    sizes: new Float32Array(capacity),
    spins: new Float32Array(capacity),
    colors: new Float32Array(capacity * 3),
    alphas: new Float32Array(capacity),
    ages: new Float32Array(capacity),
    seeds: new Float32Array(capacity),
    velocities: new Float32Array(capacity * 3),
    frames: new Float32Array(capacity),
    heights: new Float32Array(capacity),
    count: 0,
    capacity,
  };
}

/**
 * A pool of short-lived particles, simulated on the CPU and drawn as instances.
 *
 * Deliberately not a new GPU path: `InstancedMesh` already uploads instance
 * data per frame and already knows how to draw thousands of copies of one mesh
 * in a single call, so a particle system is *only* the simulation. That keeps
 * the whole thing testable — none of what follows needs a GL context — and
 * keeps WebGL where the standing rule says it lives.
 *
 * A ring buffer, not a free list. Emission is continuous and the oldest
 * particle is always the right one to reuse, so the bookkeeping a free list
 * exists for is bookkeeping nobody needs; and overrunning it degrades by
 * dropping the oldest, which is invisible, rather than by refusing to emit,
 * which is visible exactly when the effect matters most.
 */
export interface ParticlePoolOptions {
  capacity: number;
  /** Seconds a particle lives. */
  lifeSec: number;
  /** Size at birth and at death: metres from the centre to an edge, so the quad is twice as wide. */
  sizeStart: number;
  sizeEnd: number;
  /** Colour at birth and at death. */
  colorStart: Vec3;
  colorEnd: Vec3;
  /** Downward acceleration. Smoke wants a little; grit wants a lot. */
  gravity: number;
  /** How fast motion decays, per second. */
  drag: number;
  /** Constant upward push, for anything that behaves like smoke. */
  rise: number;
  /**
   * Opacity at birth and at death. Omitted means the old behaviour exactly —
   * fully opaque, fading by colour — so no existing pool changes by a bit.
   */
  alphaStart?: number;
  alphaEnd?: number;
}

export class ParticlePool {
  readonly instances: InstanceData;
  /** The same particles, as a particle material wants them. See `ParticleInstances`. */
  readonly particles: ParticleInstances;

  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly z: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly spin: Float32Array;
  private readonly scale: Float32Array;
  /**
   * The seed the caller emitted with, kept as well as hashed into `spin`.
   *
   * A material that animates — noise-eroded smoke, a stuttering spark — needs a
   * per-particle constant to offset its own animation by, and a rotation is the
   * wrong number for it: two particles a radian apart are visually unrelated but
   * arithmetically adjacent, so noise sampled at the spin makes neighbours ripple
   * together.
   */
  private readonly seedOf: Float32Array;
  /**
   * Where each slot's particle sits in the drawn streams, or -1 where it sits nowhere.
   *
   * **What lets `emit` draw a particle the frame it is born.** The streams are compacted, so a
   * slot's entry is wherever `update` last put it; an emit into a slot that has one overwrites
   * that entry, and an emit into one that has none appends. Without it a new particle waited for
   * the next `update` to be drawn at all.
   */
  private readonly drawnAt: Int32Array;
  private next = 0;

  constructor(private readonly options: ParticlePoolOptions) {
    const { capacity } = options;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('A particle pool needs a positive integer capacity.');
    }
    if (options.lifeSec <= 0) throw new Error('Particles need a positive lifetime.');
    this.instances = createInstanceData(capacity);
    this.particles = createParticleInstances(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(Infinity);
    this.life = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.scale = new Float32Array(capacity).fill(1);
    this.seedOf = new Float32Array(capacity);
    this.drawnAt = new Int32Array(capacity).fill(-1);
  }

  /** How many particles are alive. */
  get live(): number {
    let count = 0;
    for (let i = 0; i < this.age.length; i++) {
      if (this.age[i] !== Infinity && (this.age[i] as number) < (this.life[i] as number)) count++;
    }
    return count;
  }

  /**
   * Add one particle.
   *
   * `seed` drives the per-particle variation instead of `Math.random`, so a
   * caller inside a deterministic system can pass a tick count and get the same
   * plume twice — which a replay needs, since the same run has to look the same
   * on the way to being a clip.
   */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    seed: number,
    sizeScale = 1,
    lifeScale = 1,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.instances.capacity;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = this.options.lifeSec * lifeScale;
    // Hashed rather than sequential: neighbouring particles must not share a
    // rotation, or a plume reads as a single object turning.
    const hash = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    this.spin[i] = (hash - Math.floor(hash)) * Math.PI * 2;
    this.scale[i] = sizeScale;
    this.seedOf[i] = seed;
    /*
     * Drawn now, at birth, rather than at the next `update`: into the entry this slot already
     * has when it is taking over a particle that was drawn, and onto the end otherwise.
     */
    const held = this.drawnAt[i] as number;
    const at = held >= 0 ? held : this.particles.count;
    this.writeDrawn(i, at, 0, x, y, z, vx, vy, vz);
    if (held < 0) {
      this.drawnAt[i] = at;
      this.instances.count = at + 1;
      this.particles.count = at + 1;
    }
  }

  /**
   * Advance every particle and rebuild the instance buffer.
   *
   * Compacting as it goes: live particles are written to the front of the
   * instance data, so the draw call submits exactly the live count and dead
   * particles cost nothing but the loop iteration.
   */
  update(dt: number): void {
    const o = this.options;
    let count = 0;
    for (let i = 0; i < this.age.length; i++) {
      const age = this.age[i] as number;
      if (age === Infinity) {
        this.drawnAt[i] = -1;
        continue;
      }
      const life = this.life[i] as number;
      const next = age + dt;
      if (next >= life) {
        this.age[i] = Infinity;
        this.drawnAt[i] = -1;
        continue;
      }
      this.age[i] = next;

      const decay = Math.max(0, 1 - o.drag * dt);
      let vx = (this.vx[i] as number) * decay;
      let vy = (this.vy[i] as number) * decay;
      let vz = (this.vz[i] as number) * decay;
      vy += (o.rise - o.gravity) * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      const px = (this.x[i] as number) + vx * dt;
      const py = (this.y[i] as number) + vy * dt;
      const pz = (this.z[i] as number) + vz * dt;
      this.x[i] = px;
      this.y[i] = py;
      this.z[i] = pz;

      this.drawnAt[i] = count;
      this.writeDrawn(i, count, next / life, px, py, pz, vx, vy, vz);
      count++;
    }
    this.instances.count = count;
    this.particles.count = count;
  }

  /**
   * One particle's entry in both drawn streams, at `t` of its life: what `update` writes for every
   * live particle and `emit` for a new one, so the two cannot disagree about what a particle looks
   * like.
   */
  private writeDrawn(
    i: number,
    count: number,
    t: number,
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
  ): void {
    const o = this.options;
    const size = (o.sizeStart + (o.sizeEnd - o.sizeStart) * t) * (this.scale[i] as number);
    const r =
      (o.colorStart[0] as number) + ((o.colorEnd[0] as number) - (o.colorStart[0] as number)) * t;
    const g =
      (o.colorStart[1] as number) + ((o.colorEnd[1] as number) - (o.colorStart[1] as number)) * t;
    const b =
      (o.colorStart[2] as number) + ((o.colorEnd[2] as number) - (o.colorStart[2] as number)) * t;
    /*
     * Colour carries the fade rather than an alpha channel: the instanced
     * path multiplies a tint into the base mesh and has no per-instance
     * opacity, and for an additive puff darkening to nothing *is* fading out.
     * It also means the effect needs no blend-state change.
     */
    const fade = 1 - t * t;
    writeInstance(
      this.instances,
      count,
      px,
      py,
      pz,
      size,
      this.spin[i] as number,
      r * fade,
      g * fade,
      b * fade,
      0,
      0,
      0,
    );
    /*
     * The same particle for a material that has a real opacity channel. Colour
     * is written *unfaded* here, because dimming it is the scatter path's
     * workaround and doing both would fade twice — a puff that vanished at half
     * its life while still occluding what was behind it.
     */
    const p = this.particles;
    const alphaStart = o.alphaStart ?? 1;
    const alphaEnd = o.alphaEnd ?? 0;
    p.positions[count * 3] = px;
    p.positions[count * 3 + 1] = py;
    p.positions[count * 3 + 2] = pz;
    p.sizes[count] = size;
    p.spins[count] = this.spin[i] as number;
    p.colors[count * 3] = r;
    p.colors[count * 3 + 1] = g;
    p.colors[count * 3 + 2] = b;
    p.alphas[count] = alphaStart + (alphaEnd - alphaStart) * t;
    p.ages[count] = t;
    p.seeds[count] = this.seedOf[i] as number;
    p.velocities[count * 3] = vx;
    p.velocities[count * 3 + 1] = vy;
    p.velocities[count * 3 + 2] = vz;
  }

  /** Drop everything, for a respawn or a scene change. */
  clear(): void {
    this.age.fill(Infinity);
    this.drawnAt.fill(-1);
    this.instances.count = 0;
    this.particles.count = 0;
    this.next = 0;
  }
}

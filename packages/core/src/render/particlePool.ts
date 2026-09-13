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
  /** Metres across, and radians of roll about the particle's own axis. */
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
  count: number;
  capacity: number;
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
  /** Size at birth and at death, metres. */
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
      if (age === Infinity) continue;
      const life = this.life[i] as number;
      const next = age + dt;
      if (next >= life) {
        this.age[i] = Infinity;
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

      const t = next / life;
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
      count++;
    }
    this.instances.count = count;
    this.particles.count = count;
  }

  /** Drop everything, for a respawn or a scene change. */
  clear(): void {
    this.age.fill(Infinity);
    this.instances.count = 0;
    this.particles.count = 0;
    this.next = 0;
  }
}

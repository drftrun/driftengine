/**
 * The debris a broken block throws.
 *
 * **Spec §6 put this in DriftScript and the engine census overruled it.** `ParticlePool` already
 * takes a capacity, a lifetime, size and colour ramps, gravity, drag and rise, and integrates all
 * of it into instances a `ParticleBatch` draws. A script module would have been a worse
 * reimplementation of a solved thing, so this file configures a pool instead of simulating one —
 * which is the whole of the reference's 132-line `particles.ts`.
 *
 * The colour ramp is rebuilt per burst, because a pool has one ramp and each block breaks in its
 * own colour. That is the one thing this shape costs.
 */
import {
  ParticlePool,
  type Camera,
  type Environment,
  type RendererApi,
  type Vec3,
} from '../../packages/core/src/index';

import { blockColor } from './blocks';

type ParticleHandle = ReturnType<RendererApi['createParticles']>;

const CAPACITY = 512;
/** The reference's: ten shards a break, thrown at about three blocks a second. */
const PER_BURST = 10;
const THROW_SPEED = 3;
const GRAVITY = 16;

export class Particles {
  private readonly renderer: RendererApi;
  private readonly batch: ParticleHandle;
  private readonly pool: ParticlePool;
  /** Written in place: `burst` runs on every break and must not allocate. */
  private readonly tint: Vec3 = [1, 1, 1];
  private seed = 1;
  private elapsed = 0;
  private disposed = false;

  constructor(renderer: RendererApi) {
    this.renderer = renderer;
    this.pool = new ParticlePool({
      capacity: CAPACITY,
      lifeSec: 0.85,
      /* Shrinking to nothing rather than vanishing at full size. */
      sizeStart: 0.16,
      sizeEnd: 0.02,
      colorStart: this.tint,
      colorEnd: this.tint,
      gravity: GRAVITY,
      /* Enough drag that shards settle rather than skating away. */
      drag: 1.4,
      rise: 0,
    });
    /* `mote` of the three materials: a shard of a broken block is a small opaque speck, not
       smoke and not a spark. */
    this.batch = renderer.createParticles(CAPACITY, {
      material: 'mote',
      blend: 'alpha',
      facing: 'camera',
    });
  }

  /**
   * Throw debris from a broken block, tinted like it was.
   *
   * The velocities are a cheap deterministic spread rather than `Math.random`: engine RNG is
   * allowed here — it is not terrain, so nothing about the world's reproducibility depends on it —
   * but a counter is smaller than reaching for one.
   */
  burst(x: number, y: number, z: number, blockId: number): void {
    const colour = blockColor(blockId);
    this.tint[0] = colour[0];
    this.tint[1] = colour[1];
    this.tint[2] = colour[2];

    for (let i = 0; i < PER_BURST; i++) {
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
      const a = ((this.seed >>> 8) & 1023) / 1023;
      const b = ((this.seed >>> 18) & 1023) / 1023;
      const theta = a * Math.PI * 2;
      const speed = THROW_SPEED * (0.4 + b * 0.6);
      this.pool.emit(
        x + 0.5,
        y + 0.5,
        z + 0.5,
        Math.cos(theta) * speed * 0.6,
        speed,
        Math.sin(theta) * speed * 0.6,
        this.seed,
      );
    }
  }

  update(dtSec: number): void {
    this.elapsed += dtSec;
    this.pool.update(dtSec);
  }

  /** After the opaque scene, which is what the batch expects. */
  draw(camera: Camera, env: Environment): void {
    this.renderer.drawParticles(this.batch, this.pool.particles, camera, env, this.elapsed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeParticles(this.batch);
  }
}

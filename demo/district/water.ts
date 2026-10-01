/**
 * The district's river and canals as the engine's water: the bodies the bake cut from the source's
 * flat sheet (`bake/water.ts`), drawn with waves, Fresnel and the mirror of the street above.
 *
 * **One handle, a body a rectangle, the nearest `MAX_DRAWN` drawn.** A body is a draw of the same
 * grid placed where the rectangle is, and a frame holds sixteen bodies on WebGPU (its uniform
 * ring), so the ones nearest the eye are drawn and the rest of a three-kilometre river is left to
 * the fog it is in by then.
 *
 * **What the weather does to it**: rain roughens it, which breaks the mirror into streaks, and the
 * night darkens what it shows of itself so the lit street is most of what it shows. A city river is
 * murky — what it hides of its bed is near all of it — and reflects by Fresnel and a little more,
 * since a canal at night is looked at for its reflections and physics alone leaves it black from
 * the bank.
 *
 * Nothing here allocates per frame.
 */
import { sphereInFrustum } from '../../packages/core/src/index';
import type {
  Camera,
  Environment,
  FrustumPlanes,
  RendererApi,
  WaterBody,
  WaterHandle,
} from '../../packages/core/src/index';

import type { DistrictWater } from './bake/water';

const MAX_DRAWN = 12;
/** Past this a body is fog and is not drawn, metres. */
const DRAWN_M = 1400;

export class DistrictWaters {
  readonly level: number;
  private readonly handle: WaterHandle;
  private readonly bodies: WaterBody[];
  private readonly distance: Float32Array;
  private readonly chosen: Int32Array;
  private readonly deep: readonly [number, number, number];
  /** How far the nearest body is from the eye, for whether the mirror is worth drawing. */
  nearest = Infinity;

  constructor(
    private readonly renderer: RendererApi,
    water: DistrictWater,
  ) {
    this.level = water.level;
    this.deep = water.color;
    this.handle = renderer.createWater(96);
    this.bodies = water.bodies.map((b) => ({
      level: water.level,
      deepColor: [water.color[0], water.color[1], water.color[2]],
      shallowColor: [water.color[0] * 2.2, water.color[1] * 2.2, water.color[2] * 2.2],
      density: 0.94,
      visibility: 1,
      mirror: 0.2,
      waveScale: 0.12,
      bounds: {
        centreX: b.x,
        centreZ: b.z,
        halfX: b.halfX,
        halfZ: b.halfZ,
        forwardX: b.forwardX,
        forwardZ: b.forwardZ,
      },
    }));
    this.distance = new Float32Array(this.bodies.length);
    this.chosen = new Int32Array(MAX_DRAWN);
  }

  /** The water under this weather and light: `rain` 0 to 1, `night` 0 by day to 1 by night. */
  weather(rain: number, night: number): void {
    const self = 1 - 0.55 * night;
    for (const body of this.bodies) {
      body.waveScale = 0.12 + 0.3 * rain;
      /* A canal at night is mostly what it reflects; rain breaks the mirror into streaks. */
      body.mirror = 0.3 + 0.4 * night - 0.25 * rain;
      for (let c = 0; c < 3; c++) {
        (body.deepColor as number[])[c] = (this.deep[c] as number) * self;
        (body.shallowColor as number[])[c] = (this.deep[c] as number) * 2.2 * self;
      }
    }
  }

  /** Choose the bodies near (x, z), nearest first; how far the nearest is. */
  choose(x: number, z: number): number {
    let nearest = Infinity;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = (this.bodies[i] as WaterBody).bounds;
      if (b === undefined) continue;
      const fx = b.forwardX ?? 0;
      const fz = b.forwardZ ?? 1;
      const dx = x - b.centreX;
      const dz = z - b.centreZ;
      const along = Math.abs(dx * fx + dz * fz) - (b.halfZ ?? 0);
      const across = Math.abs(dx * fz - dz * fx) - (b.halfX ?? 0);
      const d = Math.hypot(Math.max(along, 0), Math.max(across, 0));
      this.distance[i] = d;
      if (d < nearest) nearest = d;
    }
    /* The nearest few, by repeated selection: a dozen out of a few dozen. */
    const chosen = this.chosen;
    chosen.fill(-1);
    for (let k = 0; k < MAX_DRAWN; k++) {
      let best = -1;
      let bestD = DRAWN_M;
      for (let i = 0; i < this.bodies.length; i++) {
        const d = this.distance[i] as number;
        if (d >= bestD) continue;
        let taken = false;
        for (let j = 0; j < k; j++) if (chosen[j] === i) taken = true;
        if (taken) continue;
        best = i;
        bestD = d;
      }
      if (best < 0) break;
      chosen[k] = best;
    }
    this.nearest = nearest;
    return nearest;
  }

  /**
   * Whether a chosen body within `withinM` of the eye is in `frustum`: the mirror is a second frame
   * of the street, and worth drawing only when some water in front of the eye will show it.
   */
  seen(frustum: FrustumPlanes, withinM: number): boolean {
    for (let k = 0; k < MAX_DRAWN; k++) {
      const i = this.chosen[k] as number;
      if (i < 0) break;
      if ((this.distance[i] as number) > withinM) continue;
      const b = (this.bodies[i] as WaterBody).bounds;
      if (b === undefined) continue;
      if (
        sphereInFrustum(
          frustum,
          b.centreX,
          this.level,
          b.centreZ,
          Math.hypot(b.halfX ?? 0, b.halfZ ?? 0),
        )
      )
        return true;
    }
    return false;
  }

  /** Draw the chosen bodies, after the opaque world and the sky. */
  draw(camera: Camera, seconds: number, env: Environment, windX: number, windZ: number): number {
    let drawn = 0;
    for (let k = 0; k < MAX_DRAWN; k++) {
      const i = this.chosen[k] as number;
      if (i < 0) break;
      this.renderer.drawWater(
        this.handle,
        camera,
        seconds,
        this.bodies[i] as WaterBody,
        env,
        windX,
        windZ,
      );
      drawn++;
    }
    return drawn;
  }

  dispose(): void {
    this.renderer.disposeWater(this.handle);
  }
}

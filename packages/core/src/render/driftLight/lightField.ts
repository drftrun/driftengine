/**
 * DriftLight: a scene's many fixed lights summed into one volume, which stands in for them wherever
 * they are not shaded one by one.
 *
 * **The problem it answers.** A frame shades a few hundred lights at most, chosen nearest the
 * camera, and a scene of thousands of candles left every one past that choice dark: a wall with a
 * dozen candles beside it lit nothing until the camera walked up to it. This sums every fixed light
 * once, occluded by the scene's distance field, into sparse bricks of light and direction; the lit
 * shader shades exactly where the frame's choice is complete (`PointLightBuffer.complete`) and reads
 * the volume past it, crossfading across a band so nothing pops. A light is never counted twice:
 * the split is per pixel, and the field's own lights carry a mark (`inLightField`) the selection
 * turns into the sign of their weight.
 *
 * **Baked a few bricks a step, by the scene.** `bake(bricks)` does the number asked, so a scene paces
 * it as it paces anything else it builds behind a loading screen, and the build is deterministic:
 * the engine reads no clock. The volume is not summed into the frame until every brick has landed,
 * then fades in over `fadeSec`, so a field completing in view does not pop; a field baked behind a
 * loading screen asks for no fade.
 *
 * **The lights are summed as they stood when the field was made**, from a copy: a scene dimming its
 * lamps at dawn rewrites the very objects it gave the field, and a bake paced into the morning
 * would otherwise sum lamps already out. `scale` dims what was summed.
 *
 * What it gives up is stated where each part does it: specular from summed lights (`bake.ts`),
 * flicker past the choice (the volume holds each light's steady colour), and occlusion by anything
 * that moves (only the fields given at construction shadow it).
 */

import type { GlobalFieldInstance } from '../gi/globalField.ts';
import { distanceToInstances } from '../gi/globalField.ts';
import { halfBits } from '../halfFloat.ts';
import { BRICK_TEXELS, bakeBrick } from './bake.ts';
import type { FieldLight } from './bake.ts';
import type { PointLightFalloff } from './falloff.ts';
import { BRICK_SAMPLES, layoutLightField } from './layout.ts';
import type { LightFieldLayout } from './layout.ts';

/** Seconds the summed light takes to fade in once the field is whole. */
export const FIELD_FADE_SEC = 0.5;
/** How fast the shading radius grows back, per second, when the choice reaches further again. */
const RADIUS_GROWTH_PER_SEC = 2;
/** Bricks along each axis of the atlas: 256 texels a side, the least 3D texture WebGL2 promises. */
const ATLAS_BRICKS: readonly [number, number, number] = [32, 64, 64];
/** A brick's footprint in the atlas: its light block and its direction block side by side. */
const BRICK_WIDTH = BRICK_SAMPLES * 2;

/** A light a field sums: a `PointLightSource`, whose `inLightField` the field sets. */
export interface LightFieldSource extends FieldLight {
  inLightField?: boolean;
}

export interface LightFieldOptions {
  /** How the renderer shades a point light, which the sum has to match. */
  readonly falloff: PointLightFalloff;
  /** Metres between samples; a third of a metre by default, so a brick spans a metre. */
  readonly spacing?: number;
  /** The scene's placed distance fields, which occlude the light. None leaves it unoccluded. */
  readonly fields?: readonly GlobalFieldInstance[];
  /** Metres over which exact and summed light crossfade at the shading radius. Two by default. */
  readonly band?: number;
  /**
   * Seconds the summed light fades in over once the field is whole, `FIELD_FADE_SEC` by default.
   * Zero for a field baked behind a loading screen, which has nothing on screen to pop and may be
   * stepped by a clock that has stopped.
   */
  readonly fadeSec?: number;
}

export class LightField {
  readonly layout: LightFieldLayout;
  /** Texels on each axis of the atlas. */
  readonly atlasSize: readonly [number, number, number];
  /** Bricks on each axis of the atlas, which the shader needs to find a brick's corner. */
  readonly atlasBricks: readonly [number, number, number];
  /** The atlas as half floats, four channels a texel, x fastest. */
  readonly atlas: Uint16Array;
  /** Metres over which exact and summed light crossfade. */
  readonly band: number;
  /** Whether a distance field occludes this field's light. */
  readonly occluded: boolean;
  /** Seconds the summed light fades in over once whole; zero is at once. */
  readonly fadeSec: number;
  /** The summed light's brightness, for a scene that dims all its lamps at once: dawn, a switch. */
  scale = 1;
  /** Where the frame's choice was centred, which the shader measures the radius from. */
  readonly centre = new Float32Array(3);

  private readonly lights: readonly FieldLight[];
  private readonly falloff: PointLightFalloff;
  private readonly distance: ((x: number, y: number, z: number) => number) | null;
  private readonly lightBlock = new Float32Array(BRICK_TEXELS * 4);
  private readonly directionBlock = new Float32Array(BRICK_TEXELS * 4);
  private baked = 0;
  private taken = 0;
  private eased = 0;
  private shown = 0;

  constructor(lights: readonly LightFieldSource[], options: LightFieldOptions) {
    for (const light of lights) light.inLightField = true;
    this.lights = lights.map(({ x, y, z, radius, r, g, b, sourceRadius }) => ({
      x,
      y,
      z,
      radius,
      r,
      g,
      b,
      sourceRadius,
    }));
    this.falloff = options.falloff;
    this.band = options.band ?? 2;
    this.fadeSec = Math.max(0, options.fadeSec ?? FIELD_FADE_SEC);
    const fields = options.fields ?? [];
    this.occluded = fields.length > 0;
    this.distance = this.occluded ? distanceToInstances(fields) : null;
    this.layout = layoutLightField(lights, options.spacing ?? 1 / 3);

    const count = this.layout.count;
    const capacity = ATLAS_BRICKS[0] * ATLAS_BRICKS[1] * ATLAS_BRICKS[2];
    if (count > capacity) {
      throw new Error(
        `LightField: these lights reach ${count} bricks and one field holds ${capacity}. ` +
          'Give each region of the world a field of its own, or a coarser spacing.',
      );
    }
    const ax = Math.max(1, Math.min(count, ATLAS_BRICKS[0]));
    const ay = Math.max(1, Math.min(Math.ceil(count / ax), ATLAS_BRICKS[1]));
    const az = Math.max(1, Math.ceil(count / (ax * ay)));
    this.atlasBricks = [ax, ay, az];
    this.atlasSize = [ax * BRICK_WIDTH, ay * BRICK_SAMPLES, az * BRICK_SAMPLES];
    this.atlas = new Uint16Array(this.atlasSize[0] * this.atlasSize[1] * this.atlasSize[2] * 4);
  }

  /** Whether every brick has been baked. */
  get ready(): boolean {
    return this.baked >= this.layout.count;
  }

  /** How much of the bake is done, 0 to 1, for a loading screen. */
  get progress(): number {
    return this.layout.count === 0 ? 1 : this.baked / this.layout.count;
  }

  /** The radius, in metres from `centre`, inside which lights are shaded exactly. */
  get radius(): number {
    return this.eased;
  }

  /** How much of the summed light is in the frame, 0 until the field is whole, then up to 1. */
  get presence(): number {
    return this.shown;
  }

  /** The texel at which brick `brick`'s light block starts; its direction block is 4 along x. */
  atlasCorner(brick: number): [number, number, number] {
    const [ax, ay] = this.atlasBricks;
    return [
      (brick % ax) * BRICK_WIDTH,
      (Math.floor(brick / ax) % ay) * BRICK_SAMPLES,
      Math.floor(brick / (ax * ay)) * BRICK_SAMPLES,
    ];
  }

  /** Bake up to `bricks` more bricks into the atlas, and answer how many were baked. */
  bake(bricks: number): number {
    const end = Math.min(this.layout.count, this.baked + Math.max(0, Math.floor(bricks)));
    const done = end - this.baked;
    for (let brick = this.baked; brick < end; brick++) {
      bakeBrick(
        this.layout,
        brick,
        this.lights,
        this.falloff,
        this.distance,
        this.lightBlock,
        this.directionBlock,
      );
      this.place(brick);
    }
    this.baked = end;
    return done;
  }

  /** The bricks baked since the last call, for a backend to upload. */
  takeBaked(): { from: number; to: number } {
    const range = { from: this.taken, to: this.baked };
    this.taken = this.baked;
    return range;
  }

  /**
   * Follow the frame's choice: `complete` from the selection, centred at (x, y, z). The radius
   * shrinks at once, because a pixel inside it that a left-out light reaches would be shaded
   * short, and grows back slowly, because a pixel it has not reached yet takes the summed light,
   * which is only less exact. While nothing is summed the radius simply follows.
   */
  follow(complete: number, x: number, y: number, z: number, dtSec: number): void {
    this.centre[0] = x;
    this.centre[1] = y;
    this.centre[2] = z;
    const showing = this.shown > 0;
    if (!showing || complete < this.eased) this.eased = complete;
    else this.eased += (complete - this.eased) * (1 - Math.exp(-RADIUS_GROWTH_PER_SEC * dtSec));
    if (this.ready) {
      this.shown = this.fadeSec > 0 ? Math.min(1, this.shown + dtSec / this.fadeSec) : 1;
    }
  }

  /** Write the brick just baked into its place in the atlas, as half floats. */
  private place(brick: number): void {
    const [x0, y0, z0] = this.atlasCorner(brick);
    const [w, h] = this.atlasSize;
    for (let k = 0; k < BRICK_SAMPLES; k++) {
      for (let j = 0; j < BRICK_SAMPLES; j++) {
        for (let i = 0; i < BRICK_SAMPLES; i++) {
          const from = (i + BRICK_SAMPLES * (j + BRICK_SAMPLES * k)) * 4;
          const light = (((z0 + k) * h + (y0 + j)) * w + (x0 + i)) * 4;
          const direction = light + BRICK_SAMPLES * 4;
          for (let c = 0; c < 4; c++) {
            this.atlas[light + c] = halfBits(this.lightBlock[from + c] as number);
            this.atlas[direction + c] = halfBits(this.directionBlock[from + c] as number);
          }
        }
      }
    }
  }
}

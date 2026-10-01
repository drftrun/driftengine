/**
 * A world's DriftLight: a dense volume baked offline (`bakeDenseField`), handed to the renderer
 * whole, standing in for every fixed light past the frame's exact choice.
 *
 * **Whole from the start**, because nothing is baked in the page: `ready` is true on construction
 * and the volume fades in over `fadeSec` from the first `follow`. The lights it summed are the
 * scene's to mark `inLightField`, so the selection knows not to count them twice — a volume carries
 * no list of the lights it came from.
 *
 * **Light and direction side by side along y**, the short axis: a city is 256 samples across and a
 * few dozen up, and a 3D texture promises 256 on every axis, so stacking the two there keeps both
 * inside one texture and one sampler. The shader keeps each lookup inside its own half.
 */

import { halfBits } from '../halfFloat.ts';
import type { DenseLightVolume } from './denseField.ts';
import { FieldPresence } from './presence.ts';
import type { DriftLightVolumes } from './presence.ts';

export interface WorldLightFieldOptions {
  /** Metres over which exact and summed light crossfade at the shading radius. Two by default. */
  readonly band?: number;
  /** Seconds the volume fades in over; zero behind a loading screen, whose clock may be held. */
  readonly fadeSec?: number;
}

/** The index a dense volume binds in the sparse one's place: one cell, no brick. */
const NO_INDEX = new Uint32Array(1);

export class WorldLightField implements DriftLightVolumes {
  readonly ready = true;
  readonly empty = false;
  readonly indexDims: readonly [number, number, number] = [1, 1, 1];
  readonly index = NO_INDEX;
  readonly atlasSize: readonly [number, number, number];
  readonly atlas: Uint16Array;
  readonly band: number;
  readonly sampleOrigin: readonly [number, number, number];
  readonly signedSpacing: number;
  /** The summed light's brightness, for a scene that dims all its lamps at once. */
  scale = 1;
  private readonly showing: FieldPresence;

  constructor(volume: DenseLightVolume, options: WorldLightFieldOptions = {}) {
    const [x, y, z] = volume.dims;
    this.atlasSize = [x, y * 2, z];
    this.atlas = new Uint16Array(x * y * 2 * z * 4);
    for (let k = 0; k < z; k++) {
      for (let j = 0; j < y; j++) {
        for (let i = 0; i < x; i++) {
          const from = (i + x * (j + y * k)) * 4;
          const light = (i + x * (j + 2 * y * k)) * 4;
          const direction = (i + x * (j + y + 2 * y * k)) * 4;
          for (let c = 0; c < 4; c++) {
            this.atlas[light + c] = halfBits(volume.light[from + c] as number);
            this.atlas[direction + c] = halfBits(volume.direction[from + c] as number);
          }
        }
      }
    }
    this.band = options.band ?? 2;
    this.sampleOrigin = volume.origin;
    this.signedSpacing = -volume.spacing;
    this.showing = new FieldPresence(Math.max(0, options.fadeSec ?? 0.5));
  }

  get radius(): number {
    return this.showing.radius;
  }

  get presence(): number {
    return this.showing.presence;
  }

  get centre(): Float32Array {
    return this.showing.centre;
  }

  /** Follow the frame's choice, as `LightField.follow` does. */
  follow(complete: number, x: number, y: number, z: number, dtSec: number): void {
    this.showing.follow(true, complete, x, y, z, dtSec);
  }
}

/**
 * The medium between the camera and everything it can see, as arithmetic.
 *
 * **`shaders/fog.ts` was the only copy and it is GLSL**, which two things now make a problem. The
 * GPU-driven pipeline is written in WGSL and cannot include it, so the second pipeline drew no fog
 * at all; and a term that exists only as a shader is a term nothing can disagree with, which is the
 * argument `gpudriven/lit.ts` and `gpudriven/alphaTest.ts` were both written under.
 *
 * So this is the expression in TypeScript, and both shaders are checked against it:
 * `scripts/gpu-parity.mjs` runs the WGSL over generated cases, and `shaders/fog.ts` stays exactly
 * as it is. **This is a second reader of one decision rather than a second decision** — every
 * guard, every constant and the order of the two mixes are the GLSL's, and where a line looks odd
 * that file's header is the long version of why.
 *
 * **What it does not carry** is the uniform block. `shaders/fog.ts` declares ten uniforms because a
 * block that declares everything it uses can be pasted into any program; a function takes them as
 * one argument instead, and the backends keep their own packing.
 */

import { resolveAtmosphere, type Atmosphere, type ResolvedAtmosphere } from './atmosphere.ts';

/** A colour as three numbers, matching `render/orderIndependent.ts`'s own `Rgb`. */
export type Rgb = readonly [number, number, number];

/** Beer-Lambert through a haze layer that thins with height. `uFogMode` 0. */
export const MEDIUM_FOG = 0;
/** A ramp between two distances, which is a look rather than a medium. `uFogMode` 1. */
export const LINEAR_FOG = 1;

export interface FogOptions {
  readonly colour: Rgb;
  /** Extinction per metre **at the camera's own height**, not at the base. */
  readonly density: number;
  /** Reciprocal scale height of the haze, per metre. 0 is a uniform medium. */
  readonly heightFalloff: number;
  /** The camera's height, so a fragment's own height is one subtraction away. */
  readonly eyeY: number;
  readonly underwaterColour: Rgb;
  readonly underwaterDensity: number;
  readonly underwaterFactor: number;
  /** `MEDIUM_FOG` integrates a medium; `LINEAR_FOG` ramps between near and far. */
  readonly mode: number;
  /** Linear mode only: where haze begins, and where it is total. */
  readonly near: number;
  readonly far: number;
}

/**
 * Linear interpolation **written the way `mix` is defined**, which is not the same arithmetic as
 * the fused form.
 *
 * GLSL and WGSL both define `mix(x, y, a)` as `x * (1 - a) + y * a`. Written `x + (y - x) * a` the
 * two agree to within rounding everywhere except the endpoints, where the fused form is off by an
 * ulp — `0.82 + (0.2 - 0.82) * 1` is 0.20000000000000007 rather than 0.2. That is invisible in a
 * picture and fatal in a parity check, and it is what the first run of this file's tests found: the
 * reference and the device have to be the same *expression*, not the same function.
 */
function mix(x: number, y: number, a: number): number {
  return x * (1 - a) + y * a;
}

/** What distance converges toward: the day's haze, or the water column. */
export function mediumColour(fog: FogOptions): [number, number, number] {
  const t = fog.underwaterFactor;
  return [
    mix(fog.colour[0], fog.underwaterColour[0], t),
    mix(fog.colour[1], fog.underwaterColour[1], t),
    mix(fog.colour[2], fog.underwaterColour[2], t),
  ];
}

/**
 * How much of a surface standing at `pointY`, `dist` metres away, is lost to the medium between.
 * 0 is perfectly clear, 1 is the medium's own colour.
 */
export function mediumFog(fog: FogOptions, dist: number, pointY: number): number {
  /*
   * **A depth ramp rather than a medium, for worlds authored against one.** Before `near` the air
   * is perfectly clear, which Beer-Lambert can never be, and height falloff has no meaning here
   * because a ramp is defined on distance alone. `shaders/fog.ts` argues the whole of it.
   */
  if (fog.mode === LINEAR_FOG) {
    /* A consumer asking for a hard cut writes `far === near`; the guard is why that is a cut. */
    const span = Math.max(fog.far - fog.near, 1e-4);
    const ramp = Math.min(1, Math.max(0, (dist - fog.near) / span));
    if (fog.underwaterFactor <= 0) return ramp;
    const wetLinear = fog.underwaterDensity * dist;
    return mix(ramp, 1 - Math.pow(2, -wetLinear * wetLinear * 1.442695), fog.underwaterFactor);
  }

  const t = (pointY - fog.eyeY) * fog.heightFalloff;
  /*
   * `(1 - e^-t)/t`, which tends to 1 as the ray levels out. **Guarded rather than branched**: at
   * `t = 0` the quotient is 0/0, and 1e-4 of a scale height is 8 mm.
   */
  const denom = Math.abs(t) < 1e-4 ? 1e-4 : t;
  const air = 1 - Math.exp((-fog.density * dist * (1 - Math.exp(-denom))) / denom);
  if (fog.underwaterFactor <= 0) return air;
  /* Water is its own medium and keeps its own curve, so crossing the surface changes nothing
     about how the water column reads. */
  const wet = fog.underwaterDensity * dist;
  return mix(air, 1 - Math.pow(2, -wet * wet * 1.442695), fog.underwaterFactor);
}

/** `FogOptions` with its fields writable, which is what a caller holds and refills a frame at a time. */
export interface FogTarget {
  colour: [number, number, number];
  density: number;
  heightFalloff: number;
  eyeY: number;
  underwaterColour: [number, number, number];
  underwaterDensity: number;
  underwaterFactor: number;
  mode: number;
  near: number;
  far: number;
}

/** A target for `atmosphereFog`, allocated once, outside the frame loop. */
export function createFogTarget(): FogTarget {
  return {
    colour: [0, 0, 0],
    density: 0,
    heightFalloff: 0,
    eyeY: 0,
    underwaterColour: [0, 0, 0],
    underwaterDensity: 0,
    underwaterFactor: 0,
    mode: MEDIUM_FOG,
    near: 0,
    far: 1,
  };
}

/** `resolveAtmosphere`'s own target, reused, because this runs a frame at a time. */
const RESOLVED: ResolvedAtmosphere = {
  fogColor: new Float32Array(3),
  underwaterColor: new Float32Array(3),
  fogDensity: 0,
  fogHeightFalloff: 0,
  fogEyeY: 0,
  fogMode: 0,
  fogNear: 0,
  fogFar: 1,
  underwaterFogDensity: 0,
  underwaterFactor: 0,
};

/**
 * The haze an `Environment` makes at a camera's height, as `GpuDrivenView.fog` takes it.
 *
 * **The forward path's own decision, handed over rather than made again.** A consumer drawing
 * both pipelines in one frame has one environment and needs one haze from it, and
 * `resolveAtmosphere` is where the forward path decides which medium the camera is in and what it
 * looks like — the density at the eye, the linear ramp's two radii, how far under water the eye
 * is. This calls it and copies the answer across field for field, so the two pipelines cannot
 * disagree about where the fog begins or whether the camera is submerged. Both mode numbers are
 * the shaders' `uFogMode`, which is why no mapping stands between them.
 *
 * @param underwater The renderer's `underwaterAtmosphere` quality, which gates the second medium
 * on the forward path; pass the same.
 */
export function atmosphereFog(
  atmosphere: Atmosphere,
  eyeY: number,
  underwater: boolean,
  out: FogTarget,
): FogTarget {
  const medium = resolveAtmosphere(atmosphere, eyeY, underwater, RESOLVED);
  out.colour[0] = medium.fogColor[0] as number;
  out.colour[1] = medium.fogColor[1] as number;
  out.colour[2] = medium.fogColor[2] as number;
  out.density = medium.fogDensity;
  out.heightFalloff = medium.fogHeightFalloff;
  out.eyeY = medium.fogEyeY;
  out.underwaterColour[0] = medium.underwaterColor[0] as number;
  out.underwaterColour[1] = medium.underwaterColor[1] as number;
  out.underwaterColour[2] = medium.underwaterColor[2] as number;
  out.underwaterDensity = medium.underwaterFogDensity;
  out.underwaterFactor = medium.underwaterFactor;
  out.mode = medium.fogMode;
  out.near = medium.fogNear;
  out.far = medium.fogFar;
  return out;
}

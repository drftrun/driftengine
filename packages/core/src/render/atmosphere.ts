import type { Vec3 } from '../math/color.ts';

/** Optional camera medium layered over an environment's ordinary air fog. */
export interface UnderwaterAtmosphere {
  /** Resting water-surface height in world metres. */
  surfaceY: number;
  /** Colour distant light converges toward inside the water column. */
  color: Vec3;
  /** Squared-exponential density inside the water column. */
  fogDensity: number;
  /** Half-width of the smooth air↔water transition around the surface. */
  transitionDepth: number;
}

/** Atmosphere fields shared by every visible render pass. */
export interface Atmosphere {
  fogColor: Vec3;
  /**
   * Extinction per metre **at `fogBaseY`**, not at the camera. Air thins with
   * height (see `fogHeightFalloff`), so the authored number describes the haze
   * where it is thickest and the camera's altitude does the rest.
   */
  fogDensity: number;
  /**
   * Reciprocal scale height of the haze, per metre: density at height `y` is
   * `fogDensity · exp(−(y − fogBaseY) · fogHeightFalloff)`. **0 is a uniform
   * medium**, which is what an authored vista or an indoor scene wants.
   *
   * Real aerial perspective thins with altitude because there is less air above
   * you, and that is the whole difference between looking along a valley and
   * looking down a mountain. A world with no vertical extent cannot tell the two
   * apart and does not need this; one with 232 m of band very much does.
   */
  fogHeightFalloff: number;
  /** The height the haze is thickest at — the sea, usually. */
  fogBaseY: number;
  /**
   * Which curve the haze follows. Absent means `exponential`, which is the physical one
   * and what every existing world is authored against.
   *
   * `linear` swaps the medium for a depth ramp between `fogNear` and `fogFar`: nothing at
   * all closer than `fogNear`, the fog colour entirely at `fogFar`. It exists because that
   * is a distinct *look* rather than an approximation of this one — a hard clear near
   * field is not something an extinction curve can produce at any density.
   */
  fogMode?: 'exponential' | 'linear';
  /** Linear mode only: where haze begins, and where it is total. */
  fogNear?: number;
  fogFar?: number;
  underwater: UnderwaterAtmosphere | null;
}

/**
 * The extinction the camera is actually standing in.
 *
 * Precomputed here rather than in seven shaders: the exponential is the same for
 * every fragment of the frame, and a fragment only needs its *own* height relative
 * to the eye to finish the ray integral.
 */
export function fogDensityAtEye(atmosphere: Atmosphere, cameraY: number): number {
  if (atmosphere.fogHeightFalloff === 0) return atmosphere.fogDensity;
  return (
    atmosphere.fogDensity * Math.exp(-(cameraY - atmosphere.fogBaseY) * atmosphere.fogHeightFalloff)
  );
}

/**
 * The medium as a shader reads it: ten numbers, no graphics API in sight.
 *
 * **Separated from the binding so a second backend can reach the same decision.**
 * `bindAtmosphere` below exists so that mesh, sky, water and plume programs cannot drift into
 * separate medium-selection rules — and a backend that cannot call it, having no
 * `WebGL2RenderingContext`, is exactly the drift that argument was written against. WebGPU
 * writes these into a uniform block; WebGL2 hands them to `uniform3fv`. One decision, two
 * bindings.
 */
export interface ResolvedAtmosphere {
  readonly fogColor: Float32Array;
  fogDensity: number;
  fogHeightFalloff: number;
  fogEyeY: number;
  /** 1 for `linear`, 0 for the exponential medium. An `int` uniform on both backends. */
  fogMode: number;
  fogNear: number;
  fogFar: number;
  readonly underwaterColor: Float32Array;
  underwaterFogDensity: number;
  underwaterFactor: number;
}

/**
 * Select the camera's medium, into a target the caller owns.
 *
 * **Filled rather than returned, because both callers are per-frame paths** and `AGENTS.md`
 * allows no allocation in one. Each backend keeps a single `ResolvedAtmosphere` and refills
 * it; nothing here allocates and nothing is shared between them.
 */
export function resolveAtmosphere(
  atmosphere: Atmosphere,
  cameraY: number,
  underwaterEnabled: boolean,
  out: ResolvedAtmosphere,
): ResolvedAtmosphere {
  /*
   * `?? null`, because a field a caller left off is `undefined` rather than `null` and the
   * test below only excluded one of the two.
   *
   * The type says `UnderwaterAtmosphere | null` and a TypeScript consumer cannot omit it, but
   * this runs inside the frame loop, where `AGENTS.md` allows no throw at all — and the callers
   * are plain objects that a JavaScript consumer, a partially-built world or a fixture is free
   * to hand over incomplete. Reading `.transitionDepth` off `undefined` throws, and one throw
   * in a `requestAnimationFrame` loop is sixty a second in somebody's error reporting. Found by
   * a renderer test whose stub environment omitted the field, on the frame `drawSky` started
   * asking for the medium at all.
   */
  const underwater = atmosphere.underwater ?? null;
  let factor = 0;
  if (underwaterEnabled && underwater !== null) {
    const transition = underwater.transitionDepth;
    if (transition > 0) {
      factor = Math.min(
        Math.max((underwater.surfaceY + transition - cameraY) / (transition * 2), 0),
        1,
      );
    } else {
      factor = cameraY < underwater.surfaceY ? 1 : 0;
    }
  }

  out.fogColor.set(atmosphere.fogColor);
  out.fogDensity = fogDensityAtEye(atmosphere, cameraY);
  out.fogHeightFalloff = atmosphere.fogHeightFalloff;
  out.fogEyeY = cameraY;
  out.fogMode = atmosphere.fogMode === 'linear' ? 1 : 0;
  out.fogNear = atmosphere.fogNear ?? 0;
  out.fogFar = atmosphere.fogFar ?? 1;
  /*
   * The air medium stands in when nothing is submerged. The shaders multiply by the factor
   * rather than branching on it, so these slots are read at factor zero and cannot be left
   * holding whatever was there before.
   */
  out.underwaterColor.set(underwater === null ? atmosphere.fogColor : underwater.color);
  out.underwaterFogDensity = underwater === null ? atmosphere.fogDensity : underwater.fogDensity;
  out.underwaterFactor = factor;
  return out;
}

/** One per GL binder, refilled per call. See `resolveAtmosphere` on why it is not allocated. */
const glResolved: ResolvedAtmosphere = {
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
 * Bind the same camera medium to any shader that declares atmosphere uniforms.
 * Missing optional uniforms are harmless WebGL null locations, so mesh, sky,
 * water and plume programs cannot drift into separate medium-selection rules.
 */
export function bindAtmosphere(
  gl: WebGL2RenderingContext,
  uniforms: Record<string, WebGLUniformLocation>,
  atmosphere: Atmosphere,
  cameraY: number,
  underwaterEnabled: boolean,
): void {
  const m = resolveAtmosphere(atmosphere, cameraY, underwaterEnabled, glResolved);

  gl.uniform3fv(uniforms['uFogColor'] ?? null, m.fogColor);
  gl.uniform1f(uniforms['uFogDensity'] ?? null, m.fogDensity);
  gl.uniform1f(uniforms['uFogHeightFalloff'] ?? null, m.fogHeightFalloff);
  gl.uniform1f(uniforms['uFogEyeY'] ?? null, m.fogEyeY);
  gl.uniform1i(uniforms['uFogMode'] ?? null, m.fogMode);
  gl.uniform1f(uniforms['uFogNear'] ?? null, m.fogNear);
  gl.uniform1f(uniforms['uFogFar'] ?? null, m.fogFar);
  gl.uniform3fv(uniforms['uUnderwaterColor'] ?? null, m.underwaterColor);
  gl.uniform1f(uniforms['uUnderwaterFogDensity'] ?? null, m.underwaterFogDensity);
  gl.uniform1f(uniforms['uUnderwaterFactor'] ?? null, m.underwaterFactor);
}

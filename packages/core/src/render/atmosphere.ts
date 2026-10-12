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

/**
 * A layer of haze: how thick it is where it is thickest, and how fast it thins above that.
 *
 * In natural units, as `fogDensity` is: a haze authored in base two, its surviving light
 * `2^(−∫ρ)` and its density falling as `2^(−f·Δy)`, is the layer `density: ρ · (ln 2)²`,
 * `heightFalloff: f · ln 2` here — the integral of base two's exponential carries one `ln 2` of its
 * own, and the transmittance's base the other.
 */
export interface FogLayer {
  /** Extinction per metre at `baseY`. */
  density: number;
  /** Reciprocal scale height, per metre: 0 is a layer of even density. */
  heightFalloff: number;
  /** The height it is thickest at. */
  baseY: number;
}

/**
 * The sun's light scattered toward the eye by the haze: a glow in the sun's direction, as dust and
 * droplets throw forward what they catch.
 *
 * Added to what the haze returns rather than mixed with it, by as much of the ray past `start` as
 * the haze hides: a mountain range seen into a low sun burns gold at its distance, and the
 * figures a few metres off do not. **What it gives up** is the light's own shape: the glow is a
 * lobe about one direction, `cos^exponent` of the angle from it, not light scattered along the
 * ray through the shadows the sun's map knows of — the global medium is that one.
 */
export interface FogSunGlow {
  /** The glow looking straight along `direction` through haze that hides everything. */
  color: Vec3;
  /** How tight the glow is about the sun: the cosine of the angle from it, to this power. */
  exponent: number;
  /** Metres past the haze's own start before the glow begins. Default 0. */
  start?: number;
  /** Surface → the light the glow surrounds. Absent, the environment's `directionalDir`. */
  direction?: Vec3;
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
  /**
   * The medium only: how far along the view ray it begins, in metres. Absent or 0 is at the
   * camera, as every world before it was drawn.
   *
   * The air nearer than this is perfectly clear, and what lies beyond is fogged by the air past
   * this point alone — so a faint, bright haze can lie over a distant crowd while the figures a
   * few metres from the camera stay sharp, which no density can do when the medium starts at the
   * eye: there it veils the whole frame, lifting the shadows and draining the colour before it
   * reaches anything far enough to want it. Unlike `linear`'s `fogNear`, nothing past it is a
   * ramp: it is the same extinction, integrated from further out. **What it gives up** is the air
   * between the camera and the start, which a real medium has; that is the point of it.
   */
  fogStart?: number;
  /**
   * The medium only: a second layer of haze, summed with the first along every ray, each its own
   * density, height and falloff. Absent, one layer.
   *
   * Two layers are what a valley with a ground mist under a high summer haze is: one thin and
   * tall, one dense and hugging the floor. One layer must pick one of the two scale heights, and
   * either gets the other's half of the picture wrong.
   */
  fogLayer2?: FogLayer | null;
  /**
   * The most of a surface the haze may hide, 0 to 1. Absent or 1, all of it.
   *
   * Below 1 a far mountain keeps that much of itself however much air lies between, which is how a
   * scene keeps a skyline readable behind a haze that should hide everything nearer the ground.
   * **What it gives up** is physics: no medium has a floor on what survives it.
   */
  fogMaxOpacity?: number;
  /**
   * Metres from the camera past which the haze hides nothing: a surface further away, the sky
   * included, is drawn clear. Absent or 0, none. For a sky or a backdrop that brings its own
   * haze painted in, which the medium would otherwise lay a second time.
   */
  fogCutoff?: number;
  /** The medium only: the sun's light scattered toward the eye by the haze. Absent, none. */
  fogSunGlow?: FogSunGlow | null;
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
  /**
   * Four floats: the second layer's extinction per metre at the camera's height and its falloff,
   * then the least of a surface the haze must leave, `fogMaxOpacity`'s complement, and the cutoff
   * distance. **Every lane is none at zero**, so a pass that never wrote them draws as before.
   */
  readonly fogLayer2: Float32Array;
  /** Four floats: the sun glow's colour, black for none, and its exponent. */
  readonly fogGlow: Float32Array;
  /** Four floats: surface → the glow's light, and how far past the haze's start the glow begins. */
  readonly fogGlowDir: Float32Array;
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
  atmosphere: Atmosphere & { readonly directionalDir?: ArrayLike<number> },
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
  /*
   * **One slot, two meanings, and never both**: the ramp's near distance in linear mode, and in
   * the medium where it begins (`fogStart`), which the medium never read before — so a world that
   * left a `fogNear` on an exponential fog starts nothing, and draws exactly as it did.
   */
  out.fogNear =
    atmosphere.fogMode === 'linear'
      ? (atmosphere.fogNear ?? 0)
      : Math.max(0, Number.isFinite(atmosphere.fogStart) ? (atmosphere.fogStart ?? 0) : 0);
  out.fogFar = atmosphere.fogFar ?? 1;
  /*
   * The air medium stands in when nothing is submerged. The shaders multiply by the factor
   * rather than branching on it, so these slots are read at factor zero and cannot be left
   * holding whatever was there before.
   */
  out.underwaterColor.set(underwater === null ? atmosphere.fogColor : underwater.color);
  out.underwaterFogDensity = underwater === null ? atmosphere.fogDensity : underwater.fogDensity;
  out.underwaterFactor = factor;
  resolveHazeExtras(atmosphere, cameraY, out);
  return out;
}

/**
 * The second layer, the haze's limits and the sun's glow, into `out`: the layer and the glow only
 * in the medium, since a linear ramp has neither a density nor a ray to integrate, and every slot
 * written whatever is asked, so nothing a shader reads keeps what an earlier frame left in it.
 */
function resolveHazeExtras(
  atmosphere: Atmosphere & { readonly directionalDir?: ArrayLike<number> },
  cameraY: number,
  out: ResolvedAtmosphere,
): void {
  const medium = atmosphere.fogMode !== 'linear';
  const layer = medium ? (atmosphere.fogLayer2 ?? null) : null;
  const density = layer === null ? 0 : Math.max(0, layer.density);
  /* The second layer at the camera's height, as `fogDensityAtEye` puts the first. */
  out.fogLayer2[0] =
    density > 0 && layer !== null
      ? density * Math.exp(-(cameraY - layer.baseY) * layer.heightFalloff)
      : 0;
  out.fogLayer2[1] = density > 0 && layer !== null ? layer.heightFalloff : 0;
  const most = atmosphere.fogMaxOpacity;
  out.fogLayer2[2] =
    most !== undefined && Number.isFinite(most) ? 1 - Math.min(1, Math.max(0, most)) : 0;
  const cutoff = atmosphere.fogCutoff;
  out.fogLayer2[3] = cutoff !== undefined && Number.isFinite(cutoff) && cutoff > 0 ? cutoff : 0;

  const glow = medium ? (atmosphere.fogSunGlow ?? null) : null;
  const toward = glow?.direction ?? atmosphere.directionalDir;
  const x = (toward?.[0] as number | undefined) ?? 0;
  const y = (toward?.[1] as number | undefined) ?? 1;
  const z = (toward?.[2] as number | undefined) ?? 0;
  const length = Math.hypot(x, y, z);
  const lit = glow !== null && length > 1e-6;
  for (let c = 0; c < 3; c++) {
    out.fogGlow[c] = lit && glow !== null ? Math.max(0, glow.color[c] as number) : 0;
  }
  /* Above zero, so the shader's pow never meets 0 to the 0: a lobe that flat is the whole sky. */
  out.fogGlow[3] = lit && glow !== null ? Math.max(1e-3, glow.exponent) : 1;
  out.fogGlowDir[0] = lit ? x / length : 0;
  out.fogGlowDir[1] = lit ? y / length : 1;
  out.fogGlowDir[2] = lit ? z / length : 0;
  out.fogGlowDir[3] = lit && glow !== null ? Math.max(0, glow.start ?? 0) : 0;
}

/**
 * A target for `resolveAtmosphere`, made once outside the frame loop: one factory, so a field added
 * to the resolved medium is a field every holder of one gets rather than one each must remember.
 */
export function createResolvedAtmosphere(): ResolvedAtmosphere {
  return {
    fogColor: new Float32Array(3),
    fogLayer2: new Float32Array(4),
    fogGlow: new Float32Array(4),
    fogGlowDir: new Float32Array(4),
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
}

/** One per GL binder, refilled per call. See `resolveAtmosphere` on why it is not allocated. */
const glResolved: ResolvedAtmosphere = createResolvedAtmosphere();

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
  /* Packed as `shaders/fog.ts` declares them, four to a row: see `uFogMedium` there for why. */
  gl.uniform4f(
    uniforms['uFogMedium'] ?? null,
    m.fogDensity,
    m.fogHeightFalloff,
    m.fogEyeY,
    m.underwaterFogDensity,
  );
  gl.uniform4f(uniforms['uFogRange'] ?? null, m.fogNear, m.fogFar, m.fogMode, 0);
  gl.uniform3fv(uniforms['uUnderwaterColor'] ?? null, m.underwaterColor);
  gl.uniform1f(uniforms['uUnderwaterFactor'] ?? null, m.underwaterFactor);
  gl.uniform4fv(uniforms['uFogLayer2'] ?? null, m.fogLayer2);
  gl.uniform4fv(uniforms['uFogGlow'] ?? null, m.fogGlow);
  gl.uniform4fv(uniforms['uFogGlowDir'] ?? null, m.fogGlowDir);
}

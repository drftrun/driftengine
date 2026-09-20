/** The directional shadow lookup, in TypeScript, so the second pipeline's copy has a reference. */

import { DIRECTIONAL_SHADOW_FADE_START, POINT_SHADOW_FADE_START } from '../renderQuality.ts';

/**
 * **`flat/directionalShadow.ts` in TypeScript, for one depth layer.**
 *
 * The lesson of the lit expression was a week old when this was written: a term that exists only
 * as a shader is a term nothing can disagree with. So the lookup was written here first, tested
 * here, and `SHADE_SHADOW_WGSL` beside it is the same arithmetic for the device with
 * `gpu-parity.mjs` running both — which is the order the map itself then followed.
 *
 * **One layer, where the forward path has three.** That path keeps a static map, a peeled one
 * holding the second static occluder, and a dynamic one for movers, and multiplies their
 * transmissions — an arrangement its own comments argue for at length and which exists because its
 * shadow *pool* is shared between lights and rationed across frames. The second pipeline has no
 * such pool: it owns its geometry, and a pass owns whatever target it renders in `prepare`. When
 * there is one caster set there is one map, and stating that is better than pretending the shape
 * is the same.
 *
 * **Everything else is term for term**, because the two pipelines drawing one scene must not
 * disagree about where a shadow ends. Each fade below returns *fully lit*, which is the thing that
 * makes them dangerous: a guard that fires when it should not removes a shadow, and a missing
 * shadow reads as a scene that never had one.
 */

/** How much of a texel the filter reaches, which sets the softness of an edge. */
export const SHADOW_TEXEL_SCALE = 1.35;

/**
 * The most depth the receiver-plane compensation may carry a tap, in texels.
 *
 * **A product of an unbounded gradient and a bounded offset**, and `directionalShadow.ts` records
 * paying for the version where only the offset was bounded: a gradient that has blown up turns a
 * fraction of a texel into a depth swing of whole map units, the comparison flips on alternate
 * shadow texels, and what draws is hard straight stripes along the map's texel grid — oblique on
 * screen, because that grid is turned by the sun rather than by the camera.
 */
export const SHADOW_SLOPE_TEXELS = 9.1;

/** Subtracted from every comparison, in depth-span units. The contact bias. */
export const SHADOW_DEPTH_BIAS = 0.14;

/** The band of `n · l` over which the shadow modulation is given up. See `shadowFactor`. */
export const SHADOW_TERMINATOR_BAND: readonly [number, number] = [0.08, 0.2];

/**
 * The stretch of stored depth, 0 to 1, over which a shadow is given up at the map's far end.
 *
 * **A fit has to keep its receivers short of it**, and that is why it is a name rather than two
 * literals: in the scene fit the far end is the scene's own rim, where nothing lies beyond, and a
 * fit that followed the eye first put the whole of the eye's sphere inside it — `fitShadow` derives
 * its least depth reach from the first of these two numbers.
 */
export const SHADOW_DEPTH_FADE: readonly [number, number] = [0.9, 1];

/**
 * The twelve taps, transcribed from `flat/pointShadow.ts`.
 *
 * A Poisson set rather than a grid: a grid filters along its own axes and bands across them, and
 * the sun turns the map's grid relative to the screen, so the banding arrives at an angle nobody
 * can attribute to anything.
 */
export const SHADOW_PCF_OFFSETS: readonly (readonly [number, number])[] = [
  [-0.326, -0.406],
  [0.519, 0.767],
  [0.962, -0.195],
  [-0.696, 0.457],
  [-0.84, -0.074],
  [0.185, -0.893],
  [0.896, 0.412],
  [-0.203, 0.621],
  [0.473, -0.48],
  [0.507, 0.064],
  [-0.322, -0.933],
  [-0.792, -0.598],
];

export interface ShadowSettings {
  /** 0 turns the whole lookup off, and off is exact rather than nearly. */
  readonly strength: number;
  readonly mapSize: number;
  /** Metres the map's depth range spans, which turns a stored depth into a distance. */
  readonly depthSpan: number;
  /** Metres a shadow may travel along the ground before it has faded out. */
  readonly maxDistance: number;
  /** The steepest `|light.xz| / light.y` that still casts. */
  readonly maxSlope: number;
  readonly taps: number;
  /** Toward the light, unit length, as `Environment.directionalDir` is. */
  readonly lightDir: readonly [number, number, number];
}

/**
 * The receiver plane: how the light-space depth changes per unit of the light's own `u` and `v`.
 *
 * **A fragment shader gets `dFdx`/`dFdy` and a compute invocation has none**, having no neighbours
 * to difference against — the same fact `SHADE_SURFACE_WGSL` exists for. So this takes the two
 * derivatives rather than computing them: the forward path passes what the hardware gave it, and
 * the second pipeline passes what it derives from the barycentric gradients it already has. The
 * arithmetic between them is one function, which is the whole point.
 *
 * **It is a two-by-two solve and it is refused where the system is ill-conditioned.** A triangle
 * seen almost edge-on in the light's projection has a determinant near zero, and dividing by it
 * turns a fraction of a texel into a depth swing of whole map units — which the clamp downstream
 * then has to catch. Refusing here is cheaper and says what happened: a plane whose slope cannot be
 * measured gets no compensation rather than a wrong one.
 *
 * **Exact only where the light's projection is orthographic**, which a directional light's is: `w`
 * is one, so the light-space position is linear in the world position and a barycentric
 * interpolation of the three corners is the real thing rather than an approximation of it.
 */
export function receiverPlaneDepthGradient(
  dx: readonly [number, number, number],
  dy: readonly [number, number, number],
  out: Float32Array,
): Float32Array {
  const determinant = dx[0] * dy[1] - dx[1] * dy[0];
  const conditioning = Math.hypot(dx[0], dx[1]) * Math.hypot(dy[0], dy[1]);
  if (Math.abs(determinant) < 1e-4 * conditioning) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  out[0] = (dx[2] * dy[1] - dx[1] * dy[2]) / determinant;
  out[1] = (dx[0] * dy[2] - dx[2] * dy[0]) / determinant;
  return out;
}

/**
 * The receiver plane a shading invocation can actually get, from the two things it already has.
 *
 * **A compute invocation has no neighbours, so the derivative has to be built rather than taken.**
 * `SHADE_SURFACE_WGSL` already computes how each barycentric weight changes per pixel of screen —
 * that is what a visibility buffer's shading needs for texture gradients — and a light-space
 * position is a linear combination of the three corners with exactly those weights. So the
 * derivative of the light-space position is the same combination of the corners with the *weight
 * gradients*, which is what this assembles before handing it to the solve above.
 *
 * **Exact rather than approximate, because a directional light's projection is orthographic.** `w`
 * is one everywhere, so the light-space position is linear in the world position and no perspective
 * divide stands between the weights and the answer. A spot light would need the quotient rule here
 * and this function would be wrong for it, which is worth knowing before one arrives.
 *
 * **The halving is the remap.** The lookup addresses the map in 0-to-1 coordinates and clip `x` and
 * `y` run -1 to 1, so a slope stated per clip unit is twice the slope per map unit. Depth is not
 * halved: this pipeline's light matrix already emits `z` in 0..1, which is the same asymmetry
 * `shadowFactor` carries and for the same reason.
 *
 * Each corner is a light-space clip position, `x`, `y` and `z`, with `w` taken as one.
 */
export function receiverPlaneFromWeights(
  l0: readonly [number, number, number],
  l1: readonly [number, number, number],
  l2: readonly [number, number, number],
  gx: readonly [number, number, number],
  gy: readonly [number, number, number],
  out: Float32Array,
): Float32Array {
  const along = (g: readonly [number, number, number], axis: 0 | 1 | 2): number =>
    (g[0] as number) * (l0[axis] as number) +
    (g[1] as number) * (l1[axis] as number) +
    (g[2] as number) * (l2[axis] as number);
  return receiverPlaneDepthGradient(
    [along(gx, 0) * 0.5, along(gx, 1) * 0.5, along(gx, 2)],
    [along(gy, 0) * 0.5, along(gy, 1) * 0.5, along(gy, 2)],
    out,
  );
}

/** GLSL's `smoothstep`, which is not `Math`'s anything. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** How much of a shadow survives having been cast this far along the ground. */
export function shadowReach(distance: number, maxDistance: number): number {
  return 1 - smoothstep(maxDistance * POINT_SHADOW_FADE_START, maxDistance, distance);
}

/**
 * Whether one tap is lit, and by how much.
 *
 * **A tap behind an occluder is not simply dark**: how far the shadow has travelled along the
 * ground decides how much of it is left, which is what keeps one map's worth of geometry from
 * shadowing the whole world.
 */
export function directionalVisibility(
  receiverDepth: number,
  compareDepth: number,
  storedDepth: number,
  settings: ShadowSettings,
): number {
  if (compareDepth <= storedDepth) return 1;
  const rayDistance = Math.max(receiverDepth - storedDepth, 0) * settings.depthSpan;
  const ground =
    rayDistance * Math.hypot(settings.lightDir[0] as number, settings.lightDir[2] as number);
  return 1 - shadowReach(ground, settings.maxDistance);
}

/**
 * How much light reaches a receiver, from 0 in full shadow to 1 in full light.
 *
 * `lightPos` is the receiver in the light's clip space, before the divide. `depthGradient` is how
 * the light-space depth changes across a pixel of the map — the receiver plane — which a fragment
 * shader gets from `dFdx`/`dFdy` and a **compute invocation cannot**, having no neighbours. The
 * second pipeline derives it from the barycentric gradients `SHADE_SURFACE_WGSL` already computes,
 * which is the same reason that file computes them: a derivative has to come from somewhere.
 *
 * `depthAt` reads the map with nearest filtering, which is what the comparison assumes: the fetched
 * depth belongs to the centre of the containing texel, and following the continuous coordinate
 * instead leaves half a texel of uncompensated slope — the repeating ribs a grazing face shows.
 */
export function shadowFactor(
  lightPos: readonly [number, number, number, number],
  depthGradient: readonly [number, number],
  ndl: number,
  settings: ShadowSettings,
  depthAt: (u: number, v: number) => number,
): number {
  /*
   * **Four early-outs below, and every one of them is a cost rather than a correctness guard.**
   * The result is `1 + (lit - 1) * amount` and `amount` is the product of all four fades, so a fade
   * at zero returns exactly one whether or not the return fires — perturbing any of them changes
   * no answer, which is recorded here rather than papered over. They stay because each one skips a
   * loop of twelve texture reads, which on a full screen is the difference between a lookup and a
   * pass. The bounds check is the one with a second job: without it the taps read outside the map.
   */
  if (settings.strength <= 0) return 1;

  const w = lightPos[3];
  if (w === 0) return 1;
  /*
   * **`x` and `y` are remapped and `z` is not, and that is a convention rather than an asymmetry.**
   * WebGPU clips `z` to 0..1 already; OpenGL clips it to -1..1, which is why the GLSL this is
   * transcribed from remaps all three. This module is the second pipeline's and the second pipeline
   * is WebGPU only, so it takes WebGPU's convention — and a caller handing it a GL-style depth gets
   * a shadow that is half as deep as it should be and biased by half the map, which reads as
   * everything being lit. `CLIP_CORRECTION` records the same family of mistake one level up.
   */
  const px = (lightPos[0] / w) * 0.5 + 0.5;
  const py = (lightPos[1] / w) * 0.5 + 0.5;
  const pz = lightPos[2] / w;

  const receiverFade = smoothstep(SHADOW_TERMINATOR_BAND[0], SHADOW_TERMINATOR_BAND[1], ndl);
  if (receiverFade <= 0) return 1;
  if (pz > 1 || px < 0 || px > 1 || py < 0 || py > 1) return 1;

  const fromCentre = Math.max(Math.abs(px - 0.5) * 2, Math.abs(py - 0.5) * 2);
  const edgeFade =
    (1 - smoothstep(0.72, 0.98, fromCentre)) *
    (1 - smoothstep(SHADOW_DEPTH_FADE[0], SHADOW_DEPTH_FADE[1], pz));
  if (edgeFade <= 0) return 1;

  const slope =
    Math.hypot(settings.lightDir[0] as number, settings.lightDir[2] as number) /
    Math.max(settings.lightDir[1] as number, 0.001);
  const lowElevationFade =
    1 - smoothstep(settings.maxSlope * DIRECTIONAL_SHADOW_FADE_START, settings.maxSlope, slope);
  if (lowElevationFade <= 0) return 1;

  const texel = SHADOW_TEXEL_SCALE / settings.mapSize;
  const slopeLimit = SHADOW_SLOPE_TEXELS / settings.mapSize;
  const taps = Math.max(1, Math.min(Math.trunc(settings.taps), SHADOW_PCF_OFFSETS.length));

  let lit = 0;
  for (let tap = 0; tap < taps; tap += 1) {
    const offset = SHADOW_PCF_OFFSETS[tap] as readonly [number, number];
    const u = px + offset[0] * texel;
    const v = py + offset[1] * texel;
    const centreU = (Math.floor(u * settings.mapSize) + 0.5) / settings.mapSize;
    const centreV = (Math.floor(v * settings.mapSize) + 0.5) / settings.mapSize;
    const raw =
      (depthGradient[0] as number) * (centreU - px) + (depthGradient[1] as number) * (centreV - py);
    const slopeOffset = Math.min(Math.max(raw, -slopeLimit), slopeLimit);
    const receiverDepth = pz + slopeOffset;
    const compare = receiverDepth - SHADOW_DEPTH_BIAS / settings.depthSpan;
    lit += directionalVisibility(receiverDepth, compare, depthAt(u, v), settings);
  }
  lit /= taps;

  const amount = settings.strength * edgeFade * lowElevationFade * receiverFade;
  return 1 + (lit - 1) * amount;
}

import { REVERSED_DEPTH } from './depthConvention.ts';
import { mat4 } from 'gl-matrix';
import type { ReadonlyMat4 } from 'gl-matrix';

import { fogDensityAtEye } from './atmosphere.ts';
import type { Atmosphere } from './atmosphere.ts';

/**
 * Where the camera stands relative to a volume of light, decided once for both backends.
 *
 * **The interesting half of `drawLightVolume` is arithmetic, not binding.** The march runs
 * entirely in the volume's own space, so the camera has to arrive there rather than the other
 * way round — one inverse per draw against one transform per fragment — and whether it arrives
 * *inside* the cone decides which half of the hull is kept.
 *
 * Both answers are a rule rather than a binding, which is why they are here and not in either
 * renderer. A second copy of the inside test is a beam that vanishes when somebody walks into
 * it on one backend and not the other, and nothing would raise: the frame is a plausible one
 * either way. That is the 2026-08-13 rule in `AGENTS.md`, and `resolveAtmosphere`,
 * `resolvePointLights` and `resolveWater` are the same split applied to their own passes.
 */

/**
 * A stored depth in [0,1] back to the clip space `viewProjection` was built in, which is [-1,1].
 *
 * The march's scene-depth clamp feeds the shader `vec4(uv * 2 - 1, stored, 1)` and multiplies it
 * by `inverse(viewProjection * model)`, which is built from the **raw** matrix on both backends.
 * `uv` is `gl_FragCoord.xy * uInvViewport`, so what arrives is a screen position and a depth, and
 * this is what turns the depth half of it into the NDC z that inverse expects.
 *
 * Here rather than in either renderer for the reason at the top of this file: it is a rule, and
 * two copies of a rule is a beam that clamps differently depending on who drew it.
 *
 * Column major: (x, y, z, 1) -> (x, y, 2z - 1, 1) conventionally, and (x, y, 1 - 2z, 1) once
 * depth is reversed, because a reversed buffer stores `0.5 - 0.5z` and this is its inverse.
 *
 * **This one is for a backend whose framebuffer Y runs up. See `DEPTH_01_TO_CLIP_Y_DOWN`, which
 * is the same remap for one whose Y runs down, and read its derivation before touching either.**
 */
export const DEPTH_01_TO_CLIP: ReadonlyMat4 = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  REVERSED_DEPTH ? -2 : 2,
  0,
  0,
  0,
  REVERSED_DEPTH ? 1 : -1,
  1,
]);

/**
 * The same remap, **and a Y flip**, for a backend whose framebuffer Y runs down.
 *
 * **The two backends do not share one matrix here, and the argument that they could is the
 * defect this constant exists to close.** It ran like this: WebGPU's framebuffer `v` is top-down
 * so `2v - 1 = -ndc.y`, and the scene was drawn through a `CLIP_CORRECTION` that negates Y, so
 * the two negations cancel and the raw view-projection's own NDC comes back out. Every step of
 * that is true except the one it leaves out.
 *
 * **The generated shaders flip Y a second time.** `scripts/wgsl.ts` runs naga without
 * `--keep-coordinate-space`, so every WGSL vertex entry point this engine ships ends with
 * `gl_Position.y = -gl_Position.y` — check any file under `shaders/generated`, they all carry
 * it. That is what makes the frame land the right way up *despite* `CLIP_CORRECTION`, and it is
 * why `sky.ts` needs `INVERSE_CLIP_CORRECTION` to unproject the clip position it wrote itself.
 * So the Y the rasteriser actually used is the raw matrix's Y, not its negation, and `2v - 1`
 * is the negation of the value the clamp has to be handed.
 *
 * **What one missing negation does to a beam**: the depth fetched is the right pixel's, and the
 * screen position it is unprojected through is that pixel mirrored about the middle of the frame.
 * The reconstructed point sits at the true distance along the mirrored ray, so projecting it back
 * onto the true one shortens it by `cos(2t)`, where `t` is the vertical angle the pixel sits at
 * off the view axis. Exact along the frame's horizontal centre line, zero at 45 degrees off it,
 * and negative past that — which discards the fragment outright.
 *
 * **Measured before it was believed**, by writing the reconstructed distance out as colour and
 * photographing `demo/dev/volume.html` on both backends: against a scene the clamp could reach,
 * the ratio of the two ran 0.927, 0.941, 0.964, 0.968, 0.986, 0.987 down the beam where
 * `cos(2t)` is 0.911, 0.934, 0.954, 0.970, 0.983, 0.993. Five hypotheses formed by reading the
 * shader were wrong before this one was formed by reading a photograph.
 *
 * A landscape frame at a 48-degree vertical field of view never gets far enough off axis for
 * this to be more than a dim band on the floor, which is why the harness page agreed to within
 * a few thousand pixels for four capture rounds. A portrait one, which is what one consumer
 * composes, reaches the angles that take the top off a shaft.
 *
 * Column major: (x, y, z, 1) -> (x, -y, 2z - 1, 1).
 */
export const DEPTH_01_TO_CLIP_Y_DOWN: ReadonlyMat4 = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  -1,
  0,
  0,
  0,
  0,
  REVERSED_DEPTH ? -2 : 2,
  0,
  0,
  0,
  REVERSED_DEPTH ? 1 : -1,
  1,
]);

/** The two things a light-volume draw has to work out before it can bind anything. */
export interface ResolvedLightVolume {
  /** The camera in the volume's own space, which is the frame the whole march happens in. */
  readonly cameraLocal: Float32Array;
  /**
   * Whether the camera is inside the cone.
   *
   * From outside, the hull's front faces are where a view ray enters it. From inside they are
   * behind the viewer, so keeping them makes a beam disappear the moment somebody steps into
   * it — which the pass this replaced avoided by culling nothing at all, an option a closed
   * hull does not have: every pixel would then be marched twice and arrive at double
   * brightness.
   */
  inside: boolean;
}

export function createResolvedLightVolume(): ResolvedLightVolume {
  return { cameraLocal: new Float32Array(3), inside: false };
}

/**
 * Scratch for the inverse model matrix. Module scope because this is a per-frame path and
 * `AGENTS.md` allows no allocation in one.
 */
const scratchInverse = mat4.create();

/**
 * Put the camera in the volume's space and decide which half of the hull survives.
 *
 * `length` and `spread` are the *draw call's* numbers rather than the geometry's, which is the
 * same pair the shader fades against — so a hull built wider than the aperture it is drawn
 * with is culled by the aperture, exactly as it is shaded by it.
 *
 * **A singular model matrix leaves the previous answer in place rather than raising.** That is
 * `mat4.invert`'s own behaviour and it is kept: this runs in the frame loop, where `AGENTS.md`
 * forbids throwing, and a degenerate transform means the caller has already collapsed the hull
 * to nothing, so there are no pixels for a stale camera position to be wrong about.
 */
export function resolveLightVolume(
  model: ReadonlyMat4,
  cameraPosition: ArrayLike<number>,
  length: number,
  spread: number,
  out: ResolvedLightVolume,
): ResolvedLightVolume {
  mat4.invert(scratchInverse, model);
  const m = scratchInverse;
  const x = cameraPosition[0] ?? 0;
  const y = cameraPosition[1] ?? 0;
  const z = cameraPosition[2] ?? 0;
  const local = out.cameraLocal;
  local[0] = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
  local[1] = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
  local[2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);

  const axial = local[2] ?? 0;
  const radial = Math.hypot(local[0] ?? 0, local[1] ?? 0);
  out.inside = axial >= 0 && axial <= length && radial <= spread * axial;
  return out;
}

/**
 * How much of a beam the air is thick enough to show, from the medium it stands in.
 *
 * **The shader's own header says a beam is more visible in fog and nothing made it so.** Every
 * term in that program is deliberately unlit, unfogged and unscaled by night, for reasons that
 * file records at length and that are all correct: fog *dims* a surface, and dimming the thing
 * that is being lit by ninety metres of medium is what made the first two attempts vanish. What
 * was left out is the other direction. A headlight cone in clear air and the same cone in thick
 * fog were the same picture, because `strength` is a number the caller authored once and nothing
 * between it and the frame knew what the weather was.
 *
 * That was reported from outside as the largest gap in one of eight weather states, and the
 * criterion it fails is worth quoting: fog should change how the road is *perceived* rather than
 * filter the frame. At night in thick fog the beam **is** the road. Without it, driving in fog is
 * driving in a grey box.
 *
 * **A multiplier on the CPU rather than a uniform**, which is the reason this is four lines: the
 * shader clamps `uStrength` to 1, so a gain could only ever go downward anyway, and the whole
 * effect is one number per draw rather than one per fragment. Nothing recompiles, nothing is
 * bound, and both backends cannot disagree because there is only this function — which is what
 * this file is for.
 *
 * **Density is taken where the volume is, not where the camera is.** `fogDensityAtEye` reads a
 * height against the haze's own falloff, and a car in a valley of fog with the camera on the
 * ridge above it is exactly the case that distinction exists for. The height comes from the model
 * matrix's translation, so a beam attached to something moving carries its own weather.
 *
 * Returns 1 where the air is at least as thick as `fullAtDensity`, which keeps this incapable of
 * brightening a beam past what its author asked for.
 */
export function volumeMediumGain(
  atmosphere: Atmosphere,
  model: ReadonlyMat4,
  fullAtDensity: number,
): number {
  if (!(fullAtDensity > 0)) return 1;
  const density = fogDensityAtEye(atmosphere, model[13] ?? 0);
  if (!(density > 0)) return 0;
  const gain = density / fullAtDensity;
  return gain >= 1 ? 1 : gain;
}

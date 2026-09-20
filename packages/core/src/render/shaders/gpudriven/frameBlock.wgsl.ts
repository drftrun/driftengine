/**
 * What the frame tells every stage that lights something, declared once.
 *
 * **Two stages light a surface now**: the shading pass, which resolves the visibility buffer, and
 * the blended raster, which shades a transparent fragment where it stands. They read the same
 * block because they are given the same frame, and a second declaration of it would be twelve
 * `vec4`s whose *offsets* have to agree — a field inserted in one and not the other does not fail
 * to compile, it reads the neighbouring one, so a light direction becomes a sky colour.
 *
 * `gpuDrivenPass.ts` writes it through the `FRAME_*` offsets beside `FRAME_FLOATS`, which are the
 * other half of this contract.
 */
export const FRAME_BLOCK_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4<f32>,
  /*
   * The light's, corrected for the lookup rather than for the raster: x and y still in -1..1 and
   * z already in 0..1. gpudriven/shadowCamera.ts carries why those are two different matrices.
   */
  lightViewProj: mat4x4<f32>,
  eye: vec4<f32>,
  lightDir: vec4<f32>,
  lightColour: vec4<f32>,
  sky: vec4<f32>,
  ground: vec4<f32>,
  /** width, height, the simulation time, and the latent layer's edge in texels. */
  size: vec4<f32>,
  /** The shadow: strength, map size, depth span, the distance it fades over. */
  shadow: vec4<f32>,
  /** Its remaining limits: the steepest sun that still casts, the tap count, and two spare. */
  shadowLimits: vec4<f32>,
  /** The probe: texels across level 0, the coarsest GGX level, the cosine level, and 1 if bound. */
  environment: vec4<f32>,
  /**
   * How much of the hemispheric ambient the probe's irradiance replaces, the frame's emissive gain
   * times its night factor, and two spare.
   */
  environmentMix: vec4<f32>,
  /**
   * The medium, in four blocks, and render/fog.ts is what reads them.
   *
   * **A frame that asks for nothing draws nothing**: a density of zero and the medium mode make
   * mediumFog exactly zero at every distance, which is arithmetically the frame the pipeline drew
   * before it had a haze at all.
   */
  /** rgb is the haze's colour, w is the eye's height. */
  fogColour: vec4<f32>,
  /** rgb is the water's colour, w is how far under it the camera is. */
  fogUnderwater: vec4<f32>,
  /** Reciprocal scale height, extinction per metre at the eye, and two spare. */
  fogHeight: vec4<f32>,
  /** Linear near and far, the mode, and the water's own density. */
  fogRange: vec4<f32>,
  /**
   * The visibility buffer's row in texels — the width rounded up for the copy's row alignment —
   * and three spare. A pixel is found by this and placed by size.x, which is the width the raster
   * drew at; the two differ on every frame whose width is not a multiple of sixty-four. Not
   * "target", which WGSL reserves.
   */
  pitch: vec4<f32>,
}
`;

/** Every probe in a grid as one array texture, and the scratch a bake fills it through. */

import { ggxMaxLevelFor, irradianceLevelFor, roughnessForLevel } from './prefilterEnvMap.ts';

/**
 * What one level of one layer is for, since the chain carries two different integrals.
 *
 * Levels up to `ggxMaxLevel` are the reflection, convolved against the GGX lobe at the roughness
 * `roughnessForLevel` gives them. The level above that is the diffuse ambient, convolved against
 * the cosine. They are the same pass with a different weight, and telling them apart is a uniform.
 */
export type ProbeLevelKind = 'radiance' | 'irradiance';

/**
 * Every probe of a grid as one `TEXTURE_2D_ARRAY` of octahedral maps.
 *
 * **One binding for any number of probes, which is the whole design.** GLSL ES cannot index a
 * sampler array with a non-constant expression, so a grid of cubes would need a `samplerCube` each
 * and a branch chain over them — the shape twelve point-shadow cubemaps had before
 * `pointShadowArray.ts`, and the reason that file exists. A layer index has no such limit.
 *
 * **It replaces the `samplerCube` rather than joining it.** Fifteen of WebGL2's guaranteed sixteen
 * texture units are spent, and `REFRACT_SCENE_TEXTURE_UNIT`'s comment says what the next sampler
 * has to do about that: fold into an existing binding. This binds where the probe cube used to,
 * and the irradiance level folds the diffuse term in beside the reflection, so the grid costs no
 * units at all and unit 15 stays free.
 *
 * **The chain stops at the irradiance level.** `texStorage3D` may allocate fewer levels than a
 * full chain, so there is nothing above it — a 256 edge is six levels rather than nine, and the
 * levels that would have held one, four and sixteen texels are not allocated at all.
 */
export class EnvProbeArray {
  /** The array the lit pass samples. Octahedral, one layer a probe, gutter included. */
  readonly texture: WebGLTexture;
  /** Texels a side, including the one-texel gutter `octInsetUv` insets past. */
  readonly edge: number;
  readonly layers: number;
  /** The coarsest level the reflection reaches, which is `uEnvironmentMaxLod`. */
  readonly ggxMaxLevel: number;
  /** The level holding the cosine convolution, one above the reflection's coarsest. */
  readonly irradianceLevel: number;

  private readonly framebuffer: WebGLFramebuffer;
  /** One flag a layer, because a grid may be baked a probe at a time across frames. */
  private readonly baked: Uint8Array;
  private bakedCount = 0;
  /**
   * Set once if the allocation is refused, and never cleared.
   *
   * A grid is an improvement to an appearance rather than a requirement, exactly as one probe was:
   * a device that cannot afford the layers keeps the sky-and-ground gradient and loses nothing
   * else. Sixty-four layers at the default edge is 43.7 MB, which is affordable on the parts this
   * engine targets and is not affordable everywhere.
   */
  private unusable = false;

  constructor(gl: WebGL2RenderingContext, edge: number, layers: number, floatColor: boolean) {
    this.edge = edge;
    this.layers = Math.max(1, Math.trunc(layers));
    this.ggxMaxLevel = ggxMaxLevelFor(edge);
    this.irradianceLevel = irradianceLevelFor(edge);
    this.baked = new Uint8Array(this.layers);

    const texture = gl.createTexture();
    if (texture === null) throw new Error('EnvProbeArray: createTexture failed');
    this.texture = texture;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    /*
     * **Drained once before the allocation, because `getError` reports and clears.** Without this
     * the check below answers for whatever happened earlier in the frame, and a grid would stand
     * down over somebody else's mistake. One call rather than a loop: a context that answers an
     * error forever is a context this would never leave.
     */
    gl.getError();
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      /* Up to and including the irradiance level, and nothing above it. */
      this.irradianceLevel + 1,
      floatColor ? gl.RGBA16F : gl.RGBA8,
      edge,
      edge,
      this.layers,
    );
    /*
     * **`LINEAR_MIPMAP_NEAREST`, and the choice is a statement rather than a saving.** A level's
     * gutter is one texel wide, so its inset in normalised coordinates is `1 / edge` and differs
     * between levels; hardware trilinear applies one coordinate to both levels it blends, so one
     * of the two would be read at the wrong inset — by a thirty-second of the map at the top of
     * the chain. The shader fetches two levels at their own insets and mixes them, so the only
     * filtering asked of the hardware is bilinear inside one level.
     */
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    /*
     * Clamped, and the gutter is what makes that correct. An octahedral map's border is a fold
     * rather than an edge, so `CLAMP_TO_EDGE` repeating the last real texel would be wrong by
     * 4.6e-2 in direction; the gutter holds the folded texel and the inset keeps every sample
     * inside it, which is measured in `octahedral.test.ts`.
     */
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    if (gl.getError() !== gl.NO_ERROR) {
      this.unusable = true;
      console.warn(
        `[driftengine] this device would not allocate ${this.layers} environment probe layers at ` +
          `${edge}x${edge}. Reflective surfaces keep the sky-and-ground gradient and diffuse ` +
          'ambient stays whatever the scene set. Nothing else is affected.',
      );
    }

    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) throw new Error('EnvProbeArray: createFramebuffer failed');
    this.framebuffer = framebuffer;
  }

  /**
   * Convolve one probe's captured cube into one layer, every level of it.
   *
   * **The caller draws, and this owns the target**, which is the split `ReflectionProbe.prefilter`
   * already makes with the pass that convolves: a probe has no business knowing what a shader is,
   * and a pass has no business knowing which layer it is filling.
   *
   * **One draw a level rather than six.** A cube's convolution runs the triangle once per face per
   * level; an octahedral map has no faces, so a level is one draw and a probe's convolution is six
   * times fewer of them than the cube it replaces.
   *
   * **The source is a different texture object from the target and that is not tidiness.** WebGL2's
   * rendering-feedback-loop check is per texture object rather than per image, so a draw that
   * samples the array while any layer of it is attached is `INVALID_OPERATION` — on a layer it does
   * not even write. `pointShadowArray.ts` records paying for this on a probe before that file
   * existed. Here the source is the scratch cube and the target is the array, so it cannot arise.
   */
  convolve(
    gl: WebGL2RenderingContext,
    layer: number,
    run: (level: number, roughness: number, kind: ProbeLevelKind) => void,
  ): void {
    if (this.unusable) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    for (let level = 0; level <= this.irradianceLevel; level++) {
      /* A level is half the width of the one below it, and the viewport has to say so or the
         triangle covers a quarter of the target and leaves the rest at whatever was there. */
      const size = Math.max(1, this.edge >> level);
      gl.viewport(0, 0, size, size);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, level, layer);
      if (level === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.unusable = true;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        console.warn(
          '[driftengine] this driver will not render into an environment probe layer, so ' +
            'reflective surfaces keep the sky-and-ground approximation. Nothing else is affected.',
        );
        return;
      }
      const irradiance = level === this.irradianceLevel;
      run(
        level,
        irradiance ? 1 : roughnessForLevel(level, this.ggxMaxLevel),
        irradiance ? 'irradiance' : 'radiance',
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.baked[layer] !== 1) {
      this.baked[layer] = 1;
      this.bakedCount++;
    }
  }

  /**
   * Whether the shader may sample this, which needs **every** layer filled.
   *
   * A grid baked a probe a frame passes through a state where some layers hold whatever the driver
   * left in them, and a fragment blending eight corners reads four of those. The gate is therefore
   * the whole grid rather than any part of it — the same rule one probe already had, where
   * `uEnvironmentEnabled` stayed at zero until a bake finished, for the same reason: a car
   * mirroring uninitialised memory is worse than a car mirroring a gradient.
   */
  get ready(): boolean {
    return !this.unusable && this.bakedCount === this.layers;
  }

  /** How many layers have been convolved, for a caller pacing a bake across frames. */
  get filled(): number {
    return this.bakedCount;
  }

  /** Whether this allocated at all. False means the scene renders without a grid. */
  get usable(): boolean {
    return !this.unusable;
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.texture);
    this.baked.fill(0);
    this.bakedCount = 0;
  }
}

/** WebGL2's half of the environment prefilter: the program, and the draw for one level of a layer. */

import { compileProgram, uniformLocations } from './shader.ts';
import { PREFILTER_FRAG } from './shaders/prefilter.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import type { EnvProbeArray } from './envProbeArray.ts';
import type { ReflectionProbe } from './reflectionProbe.ts';

/**
 * Convolves a captured probe's box chain into one layer of the grid's array, once per bake.
 *
 * **Its own module rather than more of the renderer**, following `ambientOcclusionPass.ts` and
 * `bloomPass.ts`: a program, its uniforms, a vertex array and one draw. The renderer owns when
 * this happens; this owns what it is.
 *
 * **What it costs** is one program compile at construction and **one draw per level per bake**,
 * where the cube it replaced needed six — an octahedral map has no faces, so the six-way loop is
 * gone rather than moved. A bake is once per scene per probe, which is the whole reason a
 * convolution is affordable where a per-frame version of it would not be. **What would make it
 * wrong** is a caller baking every frame; at that point this is the frame's cost and the box chain
 * it replaced was the right trade.
 *
 * **A grid multiplies a bake by its probe count**, which is the real budget question rather than
 * the texture units. The caller drives one probe at a time for exactly that reason.
 */
export class EnvironmentPrefilterPass {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.program = compileProgram(gl, FULLSCREEN_VERT, PREFILTER_FRAG, 'envPrefilter');
    this.uniforms = uniformLocations(gl, this.program, 'envPrefilter');

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('EnvironmentPrefilterPass: createVertexArray failed');
    this.vao = vao;
  }

  /**
   * Fill every level of the probe's prefiltered cube from its captured one.
   *
   * The source is bound on the unit the environment normally occupies, which is deliberate rather
   * than convenient: that unit is rebound by the lit pass every frame, so borrowing it here cannot
   * outlive the bake, and it keeps the pass out of the unit accounting `textureUnitBudget.test.ts`
   * holds.
   */
  run(
    gl: WebGL2RenderingContext,
    source: ReflectionProbe,
    array: EnvProbeArray,
    layer: number,
    sourceUnit: number,
    samples: number,
    /**
     * Whether the reflection chain is the GGX convolution rather than a box filter.
     *
     * `RenderQuality.environmentPrefilter`, and it is consulted here rather than at bind time
     * because there is one chain now instead of two textures. A profile that has not asked for the
     * lobe chain bakes the box one into the same layers and gets the picture it already had.
     */
    prefiltered: boolean,
  ): void {
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    /*
     * A convolution writes over a target it has no depth relationship with, so both the test and
     * the write are off — and culling with it, because the fullscreen triangle's winding is
     * whatever the vertex shader's corner arithmetic produced rather than something anybody chose.
     */
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0 + sourceUnit);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, source.texture);
    gl.uniform1i(this.uniforms['uPrefilterSource'] ?? null, sourceUnit);
    gl.uniform1f(this.uniforms['uPrefilterSamples'] ?? null, samples);
    gl.uniform1f(this.uniforms['uPrefilterSourceTexels'] ?? null, source.size);
    gl.uniform1f(this.uniforms['uPrefilterSourceMaxLod'] ?? null, source.maxLod);

    array.convolve(gl, layer, (level, roughness, kind) => {
      /*
       * **The level's own edge, not the array's.** A gutter is one texel at every level, so its
       * share of the map doubles as the chain coarsens; insetting a coarse level by the base
       * edge's fraction reads as the reflection sliding as roughness rises.
       */
      gl.uniform1f(this.uniforms['uPrefilterEdge'] ?? null, Math.max(1, array.edge >> level));
      gl.uniform1f(this.uniforms['uPrefilterIrradiance'] ?? null, kind === 'irradiance' ? 1 : 0);
      gl.uniform1f(this.uniforms['uPrefilterBox'] ?? null, prefiltered ? 0 : 1);
      gl.uniform1f(this.uniforms['uPrefilterLevel'] ?? null, level);
      gl.uniform1f(this.uniforms['uPrefilterRoughness'] ?? null, roughness);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    /*
     * Put the caller's program back rather than leaving ours current. The bake around this reads
     * and restores flat-shader uniforms on either side of itself, and it would be doing that to
     * whichever program happened to be bound.
     */
    if (previousProgram !== null) gl.useProgram(previousProgram);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}

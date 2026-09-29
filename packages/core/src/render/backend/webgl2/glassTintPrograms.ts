/**
 * The five programs a pane casts its colour through, one per way a caster is drawn, compiled the
 * first time glass casts — so a scene with no glass compiles none of them.
 *
 * The vertex stages are the depth pass's with the world position handed on (`depth.ts`), so a
 * pane's colour lands exactly where its depth does; the fragment is `paneTexel` for the device.
 */
import { compileProgram, uniformLocations } from '../../shader.ts';
import {
  GLASS_TINT_CUTOUT_FRAG,
  GLASS_TINT_CUTOUT_VERT,
  GLASS_TINT_FRAG,
  GLASS_TINT_INSTANCED_CUTOUT_VERT,
  GLASS_TINT_INSTANCED_VERT,
  GLASS_TINT_SKINNED_VERT,
  GLASS_TINT_VERT,
} from '../../shaders/depth.ts';

export interface GlassTintProgram {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation>;
}

export class GlassTintPrograms {
  readonly rigid: GlassTintProgram;
  readonly instanced: GlassTintProgram;
  readonly skinned: GlassTintProgram;
  readonly cutout: GlassTintProgram;
  readonly instancedCutout: GlassTintProgram;

  constructor(gl: WebGL2RenderingContext) {
    const build = (vert: string, frag: string, label: string): GlassTintProgram => {
      const program = compileProgram(gl, vert, frag, label);
      return { program, uniforms: uniformLocations(gl, program, label) };
    };
    this.rigid = build(GLASS_TINT_VERT, GLASS_TINT_FRAG, 'glassTint');
    this.instanced = build(GLASS_TINT_INSTANCED_VERT, GLASS_TINT_FRAG, 'glassTint.instanced');
    this.skinned = build(GLASS_TINT_SKINNED_VERT, GLASS_TINT_FRAG, 'glassTint.skinned');
    this.cutout = build(GLASS_TINT_CUTOUT_VERT, GLASS_TINT_CUTOUT_FRAG, 'glassTint.cutout');
    this.instancedCutout = build(
      GLASS_TINT_INSTANCED_CUTOUT_VERT,
      GLASS_TINT_CUTOUT_FRAG,
      'glassTint.instancedCutout',
    );
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const { program } of [
      this.rigid,
      this.instanced,
      this.skinned,
      this.cutout,
      this.instancedCutout,
    ]) {
      gl.deleteProgram(program);
    }
  }
}

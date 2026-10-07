/**
 * A bone animation's textures on this backend, and a batch's clocks: what
 * `shaders/boneAnimation.ts` reads with `texelFetch`, made once and never filtered. The twin of
 * `webgpu/boneAnimations.ts`, at the same formats for the same reason: a turn in half floats jitters
 * a crowd's hands at the frame's rate.
 */
import {
  CLOCK_TEXTURE_WIDTH,
  type BoneAnimationHandle,
  type BoneAnimationTexels,
} from '../../boneAnimation.ts';

/**
 * A float texture read by index: one level, nearest, clamped. Bound on unit 0, chosen rather than
 * inherited, for the reason `oitPass.ts` gives: `bindTexture` binds to whatever unit is active, and
 * a frame leaves that wherever its last pass finished.
 */
function floatTexture(
  gl: WebGL2RenderingContext,
  internal: number,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (texture === null) throw new Error('boneAnimations: createTexture failed');
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** A clip on the device, from `createBoneAnimation`. */
export class GlBoneAnimation implements BoneAnimationHandle {
  readonly bones: number;
  readonly frames: number;
  readonly framesPerSecond: number;
  readonly boneScale: number;
  readonly places: WebGLTexture;
  readonly turns: WebGLTexture;
  disposed = false;

  constructor(gl: WebGL2RenderingContext, texels: BoneAnimationTexels) {
    this.bones = texels.bones;
    this.frames = texels.frames;
    this.framesPerSecond = texels.framesPerSecond;
    this.boneScale = texels.boneScale;
    const make = (data: Float32Array): WebGLTexture => {
      const texture = floatTexture(gl, gl.RGBA32F, texels.bones, texels.frames);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        texels.bones,
        texels.frames,
        gl.RGBA,
        gl.FLOAT,
        data,
      );
      return texture;
    };
    this.places = make(texels.places);
    this.turns = make(texels.turns);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    this.disposed = true;
    gl.deleteTexture(this.places);
    gl.deleteTexture(this.turns);
  }
}

/** A batch's clocks: two floats an instance, wrapped onto rows `CLOCK_TEXTURE_WIDTH` wide. */
export class GlInstanceClocks {
  readonly texture: WebGLTexture;
  readonly staging: Float32Array;
  private readonly width: number;

  constructor(gl: WebGL2RenderingContext, capacity: number) {
    this.width = Math.max(1, Math.min(capacity, CLOCK_TEXTURE_WIDTH));
    const rows = Math.max(1, Math.ceil(capacity / this.width));
    this.staging = new Float32Array(this.width * rows * 2);
    this.texture = floatTexture(gl, gl.RG32F, this.width, rows);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** The rows that hold the first `count` instances, from `staging`. */
  upload(gl: WebGL2RenderingContext, count: number): void {
    if (count <= 0) return;
    const rows = Math.ceil(count / this.width);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, rows, gl.RG, gl.FLOAT, this.staging);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteTexture(this.texture);
  }
}

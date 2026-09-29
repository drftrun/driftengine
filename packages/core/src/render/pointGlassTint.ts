import { mat3 } from 'gl-matrix';

import { createEmptyTexture2D } from './emptyTexture.ts';
import { pointShadowFaceRotation } from './pointShadowImage.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import {
  OCTAHEDRAL_RESOLVE_TINT_FRAG,
  OCTAHEDRAL_RESOLVE_VERT,
} from './shaders/octahedralResolve.ts';

/** Filled per resolved face, at module scope, because a bake runs inside the frame's budget. */
const faceRotation = mat3.create();
const CLEAR = new Float32Array([1, 1, 1, 1]);

/**
 * What a lamp's light keeps through glass: an RGBA8 array of one layer a light, parallel to the
 * point shadow array and indexed by the light, not by the interleaved depth layer. RGB is the
 * product of every pane's `transmission × (1 − F) × tint`, A the product of their clarities
 * (`glassShadow.ts`).
 *
 * **Drawn a face at a time, as the depth is**: into a face-sized colour scratch cleared to white,
 * with a multiplying blend and no depth test, then resolved into the face's region of the layer by
 * `OCTAHEDRAL_RESOLVE_TINT_FRAG`. One scratch for the whole engine, for the reason
 * `PointShadowArray` gives for its own.
 *
 * **Which faces hold glass is remembered, six bits a layer**, so a face with no glass and none to
 * forget costs nothing, and a face that inherited a previous owner's glass is cleared. **The chain
 * frost reads is rebuilt once a round**, for the layers the round touched, through a 2D staging
 * chain: `generateMipmap` on an array rebuilds every layer, which is the whole pool's texels for one
 * lamp's glass. What that costs is one layer of memory with its chain — 5.6 MB at 1024, 1.4 MB at
 * `'half'` — and a copy out and back per touched layer.
 */
export class PointGlassTint {
  readonly texture: WebGLTexture;
  readonly edge: number;

  private readonly layers: number;
  private readonly levels: number;
  private readonly faceSize: number;
  private readonly scratch: WebGLTexture;
  private readonly scratchFramebuffer: WebGLFramebuffer;
  private readonly staging: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly readFramebuffer: WebGLFramebuffer;
  /** Parked on the resolve's unit while the scratch is a render target; see `beginFace`. */
  private readonly parked: WebGLTexture;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  /** Six bits a layer: which faces' regions hold glass. */
  private readonly heldFaces: Uint8Array;
  /** Layers whose level 0 changed since the chain was last rebuilt. */
  private readonly dirty: Uint8Array;

  constructor(gl: WebGL2RenderingContext, faceSize: number, edge: number, layers: number) {
    this.edge = edge;
    this.layers = layers;
    this.faceSize = faceSize;
    this.levels = Math.floor(Math.log2(Math.max(1, edge))) + 1;
    this.heldFaces = new Uint8Array(layers);
    this.dirty = new Uint8Array(layers);

    this.texture = colourTexture(gl, gl.TEXTURE_2D_ARRAY, this.levels, edge, layers);
    this.scratch = colourTexture(gl, gl.TEXTURE_2D, 1, faceSize, 1);
    this.staging = colourTexture(gl, gl.TEXTURE_2D, this.levels, edge, 1);
    this.parked = createEmptyTexture2D(gl);
    this.scratchFramebuffer = framebufferOf(gl);
    this.framebuffer = framebufferOf(gl);
    this.readFramebuffer = framebufferOf(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratch, 0);

    this.program = compileProgram(
      gl,
      OCTAHEDRAL_RESOLVE_VERT,
      OCTAHEDRAL_RESOLVE_TINT_FRAG,
      'octahedralResolveTint',
    );
    this.uniforms = uniformLocations(gl, this.program, 'octahedralResolveTint');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('PointGlassTint: createVertexArray failed');
    this.vao = vao;

    /* Every layer born clear: a light no pane has reached lets everything through. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    for (let layer = 0; layer < layers; layer++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, layer);
      gl.clearBufferfv(gl.COLOR, 0, CLEAR);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    /* Once, for every layer: white all the way down. */
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  /** Whether `face` of `layer` holds glass: a face that does must be cleared before it is reused. */
  held(layer: number, face: number): boolean {
    return (((this.heldFaces[layer] ?? 0) >> face) & 1) === 1;
  }

  /**
   * Bind the colour scratch, clear it to white, and set the multiplying state.
   *
   * The previous resolve left the scratch bound for sampling on unit 0, and it is about to be the
   * target: parked first, for the reason `PointShadowArray.beginFace` gives.
   */
  beginFace(gl: WebGL2RenderingContext): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.parked);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFramebuffer);
    gl.viewport(0, 0, this.faceSize, this.faceSize);
    gl.clearBufferfv(gl.COLOR, 0, CLEAR);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.DST_ALPHA, gl.ZERO);
  }

  /**
   * Copy the scratch into `face`'s region of `layer`, and remember whether it held glass.
   *
   * Leaves depth testing and writing on, which is what the next face's casters expect: the depth
   * resolve that runs before them turns both on, and this one ran after it and turned them off.
   */
  resolveFace(gl: WebGL2RenderingContext, layer: number, face: number, drawn: boolean): void {
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, layer);
    gl.viewport(0, 0, this.edge, this.edge);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scratch);
    gl.uniform1i(this.uniforms['uFace'] ?? null, 0);
    gl.uniform1i(this.uniforms['uFaceIndex'] ?? null, face);
    gl.uniformMatrix3fv(
      this.uniforms['uFaceRotation'] ?? null,
      false,
      pointShadowFaceRotation(face, faceRotation),
    );
    gl.uniform1f(this.uniforms['uEdge'] ?? null, this.edge);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    const bit = 1 << face;
    const was = this.heldFaces[layer] ?? 0;
    this.heldFaces[layer] = drawn ? was | bit : was & ~bit;
    this.dirty[layer] = 1;
  }

  /** Rebuild the chain of every layer touched since the last call, one layer at a time. */
  fillMips(gl: WebGL2RenderingContext): void {
    for (let layer = 0; layer < this.layers; layer++) {
      if (this.dirty[layer] !== 1) continue;
      this.dirty[layer] = 0;
      /* Level 0 out into the staging chain, which mipmaps as one 2D texture. */
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFramebuffer);
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, layer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.staging,
        0,
      );
      blit(gl, this.edge, this.edge);
      gl.bindTexture(gl.TEXTURE_2D, this.staging);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
      /* And every level after it back into the layer. */
      for (let level = 1; level < this.levels; level++) {
        const size = Math.max(1, this.edge >> level);
        gl.framebufferTexture2D(
          gl.READ_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          this.staging,
          level,
        );
        gl.framebufferTextureLayer(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          this.texture,
          level,
          layer,
        );
        blit(gl, size, size);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.scratchFramebuffer);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteFramebuffer(this.readFramebuffer);
    gl.deleteTexture(this.texture);
    gl.deleteTexture(this.scratch);
    gl.deleteTexture(this.staging);
    gl.deleteTexture(this.parked);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}

/** A colour texture with `levels` levels: nearest for a single level, trilinear for a chain. */
function colourTexture(
  gl: WebGL2RenderingContext,
  target: number,
  levels: number,
  edge: number,
  layers: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (texture === null) throw new Error('PointGlassTint: createTexture failed');
  gl.bindTexture(target, texture);
  if (target === gl.TEXTURE_2D_ARRAY) {
    gl.texStorage3D(target, levels, gl.RGBA8, edge, edge, layers);
  } else {
    gl.texStorage2D(target, levels, gl.RGBA8, edge, edge);
  }
  gl.texParameteri(
    target,
    gl.TEXTURE_MIN_FILTER,
    levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST,
  );
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, levels > 1 ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(target, null);
  return texture;
}

function framebufferOf(gl: WebGL2RenderingContext): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null) throw new Error('PointGlassTint: createFramebuffer failed');
  return framebuffer;
}

/** The bound read framebuffer's colour into the bound draw framebuffer's, texel for texel. */
function blit(gl: WebGL2RenderingContext, width: number, height: number): void {
  gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
}

import { mat3 } from 'gl-matrix';

import { createEmptyTexture2D } from './emptyTexture.ts';
import { LIVE_POINT_SHADOW_MAPS, POINT_SHADOW_POOL } from './lightBudget.ts';
import { pointShadowFaceRotation } from './pointShadowImage.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { OCTAHEDRAL_RESOLVE_FRAG, OCTAHEDRAL_RESOLVE_VERT } from './shaders/octahedralResolve.ts';

/**
 * The edge of one light's octahedral map.
 *
 * Matching a 512 cube face's angular density would need `512 * sqrt(6)`, about 1254, because a
 * cube face covers a sixth of the sphere inside its own square. This is 1024, so texels are about
 * 1.2x coarser in the worst direction — chosen because the wider filter this whole change unlocks
 * is blurring the result anyway, and because 1024 costs 4.19 MB a layer against a cube's 6.29 MB.
 */
export const OCTAHEDRAL_EDGE = 1024;

/** Filled per resolved face, at module scope, because a bake runs inside the frame's budget. */
const faceRotation = mat3.create();

/**
 * What a `PointShadowMap` needs of the array: somewhere to render a face, and somewhere to put it.
 *
 * An interface rather than the class, so a map can be built without a device at all — the pooling
 * rules are worth testing on their own and none of them is about a texture.
 */
export interface PointShadowTarget {
  beginFace(gl: WebGL2RenderingContext): void;
  resolveFace(
    gl: WebGL2RenderingContext,
    layer: number,
    face: number,
    far: number,
    near: number,
  ): void;
}

/**
 * Every point light's shadow as one array texture, and the scratch that fills it.
 *
 * **One scratch for the whole engine rather than one cube per pool slot**, which is the economy
 * the whole design turns on. Each octahedral texel has exactly one dominant axis, so a cube face's
 * region of the map is disjoint from the other five and is written in full the moment that face is
 * resolved. A face is therefore consumed immediately, and a bake spread across frames — which is
 * how bakes work here, a couple of faces at a time against `pointShadowBudget.ts` — never needs a
 * second face to still be around.
 *
 * **The scratch is a separate texture and that is not tidiness.** WebGL2's rendering-feedback-loop
 * check is per texture object rather than per image: a draw that samples the array while any layer
 * of it is attached is `INVALID_OPERATION`, on a layer it does not even write. Measured on a probe
 * before this file existed. So the resolve reads the scratch and writes the array, and the two are
 * never the same object.
 */
export class PointShadowArray implements PointShadowTarget {
  readonly texture: WebGLTexture;
  /**
   * How many layers this array holds: the point pool, the two live transition maps, and two more
   * for each rectangle a world said would cast. See the constructor's `extraLayers`.
   */
  readonly layers: number;

  private readonly framebuffer: WebGLFramebuffer;
  private readonly scratchTexture: WebGLTexture;
  private readonly scratchFramebuffer: WebGLFramebuffer;
  /** Parked on the resolve's unit while the scratch is a render target. See `beginFace`. */
  private readonly parked: WebGLTexture;
  private readonly faceSize: number;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;

  constructor(
    gl: WebGL2RenderingContext,
    faceSize: number,
    lightCount: number,
    /**
     * Layers above the point pool, for the rectangles a world says will cast.
     *
     * **Sized from the declaration for the same reason the point half is**, and it is the whole of
     * what an area light costs in storage: `areaShadowLayerCount` counts two per casting rectangle
     * and zero for a world whose rectangles do not cast, so a consumer that has not asked for this
     * allocates exactly what it allocated before. Where they land is `firstAreaShadowLayer`, which
     * is the same expression as the line below — one function, because the array sizing itself and
     * the set handing out indices disagreeing by one would have every rectangle sampling a lamp's
     * map.
     */
    extraLayers = 0,
  ) {
    this.faceSize = faceSize;
    /*
     * Sized from the world rather than from the maximum. `texStorage3D` is immutable, so the
     * alternative is handing a three-light world the storage for twenty-two — which is the mistake
     * `lightBudget.ts` calls the most expensive the renderer has made, wearing a new shape.
     */
    this.layers =
      Math.min(lightCount, POINT_SHADOW_POOL) + LIVE_POINT_SHADOW_MAPS + Math.max(0, extraLayers);

    const texture = gl.createTexture();
    if (texture === null) throw new Error('PointShadowArray: createTexture failed');
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.DEPTH_COMPONENT24,
      OCTAHEDRAL_EDGE,
      OCTAHEDRAL_EDGE,
      this.layers,
    );
    /* One storage level and no filtering, so textureLod(..., 0.0) is the only fetch there is. */
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const scratchTexture = gl.createTexture();
    if (scratchTexture === null) throw new Error('PointShadowArray: createTexture failed');
    this.scratchTexture = scratchTexture;
    gl.bindTexture(gl.TEXTURE_2D, scratchTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, faceSize, faceSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.parked = createEmptyTexture2D(gl);

    const scratchFramebuffer = gl.createFramebuffer();
    if (scratchFramebuffer === null) throw new Error('PointShadowArray: createFramebuffer failed');
    this.scratchFramebuffer = scratchFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratchFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, scratchTexture, 0);
    /* Depth-only: without this WebGL expects a colour attachment. */
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    /*
     * The resolve program, built **before** the completeness check below, because that check may
     * return early on a lost context and every field has to be assigned by then. `PointShadowMap`
     * and `ShadowMap` both hold that shape; here it is load-bearing rather than incidental, since
     * `program`, `uniforms` and `vao` are all `readonly`.
     */
    this.program = compileProgram(
      gl,
      OCTAHEDRAL_RESOLVE_VERT,
      OCTAHEDRAL_RESOLVE_FRAG,
      'octahedralResolve',
    );
    this.uniforms = uniformLocations(gl, this.program, 'octahedralResolve');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('PointShadowArray: createVertexArray failed');
    this.vao = vao;

    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) throw new Error('PointShadowArray: createFramebuffer failed');
    this.framebuffer = framebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, 0, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    /*
     * Asked once, here, for the reason `pointShadowMap.ts` records at length: it is a synchronous
     * query, so the driver must drain what it has queued before it can answer, and asking it per
     * face put a pipeline flush inside the render loop for the life of the session — 95.6% of a
     * 69 ms frame. Every layer shares one texture, one size and one format, so a configuration
     * complete for layer 0 is complete for all of them, and nothing about that can change later.
     */
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      /*
       * A lost context reports every attachment unusable, and that is not a misconfiguration the
       * caller can fix — see `planarReflection.ts`. Init still throws, because the context cannot
       * be lost before it exists.
       */
      if (gl.isContextLost()) return;
      throw new Error(`PointShadowArray: framebuffer incomplete (0x${status.toString(16)})`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  /**
   * Bind the scratch as the render target for one face of one bake, and clear it.
   *
   * **The previous face's resolve left the scratch bound for sampling, and it is about to be the
   * target.** That is a rendering feedback loop, and WebGL2 answers a draw in one with
   * `INVALID_OPERATION` and no pixels — which is not the resolve's own draw but the *casters*,
   * because `depth.ts` declares `uPreviousShadowMap` on that unit and an active sampler is
   * enough whether the shader branch reads it or not. Found by capturing `night-court` and
   * `day-clock`, which bake while the shot is taken; `gilded-chamber` was silent, because it had
   * nothing stale to bake.
   *
   * `beginShadowPass` carries the identical fix for the directional maps, and this is the same
   * rule one level down. A complete 1x1 texture rather than `null`, because an unbound sampler
   * is *incomplete* and a driver may fetch its descriptor before evaluating the branch that
   * would have skipped it — see `emptyTexture.ts` for the card that page-faulted over it.
   */
  beginFace(gl: WebGL2RenderingContext): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.parked);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFramebuffer);
    gl.viewport(0, 0, this.faceSize, this.faceSize);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Write the scratch's contents into `layer`'s region for `face`.
   *
   * `depthFunc(ALWAYS)` because this is a copy and not a render. The layer already holds whatever
   * the previous bake of this light left in it, so a fragment that lost a comparison would leave
   * half of one image and half of another — a shadow baked around two different places at once,
   * which is the failure `PointShadowImage.planBake` exists to prevent one level up.
   *
   * Allocates nothing: the rotation is a module-scope scratch, and the pass draws three vertices
   * from an empty vertex array.
   */
  resolveFace(
    gl: WebGL2RenderingContext,
    layer: number,
    face: number,
    far: number,
    near: number,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.texture, 0, layer);
    gl.viewport(0, 0, OCTAHEDRAL_EDGE, OCTAHEDRAL_EDGE);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scratchTexture);
    gl.uniform1i(this.uniforms['uFace'] ?? null, 0);
    gl.uniform1i(this.uniforms['uFaceIndex'] ?? null, face);
    gl.uniformMatrix3fv(
      this.uniforms['uFaceRotation'] ?? null,
      false,
      pointShadowFaceRotation(face, faceRotation),
    );
    gl.uniform1f(this.uniforms['uFar'] ?? null, far);
    gl.uniform1f(this.uniforms['uNear'] ?? null, near);
    gl.uniform1f(this.uniforms['uEdge'] ?? null, OCTAHEDRAL_EDGE);

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    /*
     * **Saved and restored rather than put back to a named compare.** This used to end with
     * `depthFunc(LESS)`, which was the frame's compare when it was written and stopped being it
     * the moment the engine could draw reversed: after one point-shadow copy the whole rest of the
     * frame tested the wrong way, and a scene with point shadows lost most of its pixels. Reading
     * the state back costs one `getParameter` on a path that already binds a framebuffer, and it
     * cannot go stale the way a constant can.
     */
    const wasDepthFunc = gl.getParameter(gl.DEPTH_FUNC) as number;
    gl.depthFunc(gl.ALWAYS);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthFunc(wasDepthFunc);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteFramebuffer(this.scratchFramebuffer);
    gl.deleteTexture(this.texture);
    gl.deleteTexture(this.scratchTexture);
    gl.deleteTexture(this.parked);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}

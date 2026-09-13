/** A splat capture as a pass a consumer registers, drawn by whichever backend it is handed. */

import { SPLAT_BINDINGS } from './shaders/generated/splat.wgsl.ts';
import { SPLAT_STRIDE, splatRows, splatTexels } from './splatLayout.ts';
import { cameraInCaptureSpace, multiplyMat4 } from './splatMatrix.ts';
import { splatBoundsVisible } from './splatCull.ts';
import {
  createWebgl2Splats,
  disposeWebgl2Splats,
  drawWebgl2Splats,
  uploadWebgl2Order,
  uploadWebgl2SplatRange,
} from './splatGl.ts';
import type { Webgl2Splats } from './splatGl.ts';
import {
  createGpuSplats,
  disposeGpuSplats,
  uploadGpuOrder,
  uploadGpuSplatRange,
} from './splatGpu.ts';
import type { GpuSplats } from './splatGpu.ts';
import type { SplatData } from './splatData.ts';
import type { PassContext, PassDefinition, PassDevice } from '@driftengine/core';

const VERT = SPLAT_BINDINGS.SPLAT_VERT;
const FRAG = SPLAT_BINDINGS.SPLAT_FRAG;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * What a consumer hands the pass each frame.
 *
 * **The camera comes from the caller rather than from the renderer**, because `PassContext`
 * carries what the *frame* is and not what is being looked at — and a contributed pass has no
 * business reaching into the renderer for a matrix the caller already has. It is the same shape
 * every draw verb takes: the caller says where it is looking.
 */
export interface SplatView {
  /**
   * Column-major, as `Camera` publishes them.
   *
   * `ArrayLike<number>` rather than `Float32Array` because that is what `gl-matrix`'s `mat4` is,
   * and a consumer handing over `camera.view` should not have to cast a matrix the engine gave it.
   */
  readonly view: ArrayLike<number>;
  readonly projection: ArrayLike<number>;
  /** In pixels, because the ellipse is built in pixel space. */
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface SplatPass extends PassDefinition {
  /** Called once a frame, before `drawPass`. Allocates nothing. */
  setView(view: SplatView): void;
  /**
   * A new draw order, far to near. Four bytes a splat, into storage allocated once.
   *
   * Until one is set the pass draws nothing: an unsorted capture composited back to front is
   * wrong at every silhouette, and drawing it anyway would look like a working feature.
   */
  setOrder(order: Uint32Array, count: number): void;
  /**
   * The capture's own transform, so two captures compose in one scene.
   *
   * **Two batches are two orders and there is no order between them**, and that is a real limit
   * rather than an omission. Each sorter ranks its own splats along the view direction expressed
   * in that batch's space, so the two are each internally correct and the renderer draws one
   * batch's whole cloud before the other's. Where they occupy different volumes — a statue and the
   * room behind it — nothing shows. Where they interpenetrate, the seam is visible as a plane at
   * which one capture starts winning every blend.
   *
   * What that buys is that a batch's positions never move: one transform on the camera instead of
   * a million on the splats, every frame. What would make it wrong is a scene built from
   * overlapping parts, where the answer is one batch with one order rather than a merge — merging
   * two sorted orders is cheap, but the splats would still be drawn from two textures with two
   * draw calls, so the merge has nowhere to go.
   */
  setModel(model: ArrayLike<number>): void;
  /**
   * Push a run of splats that has just arrived into the data texture.
   *
   * **For a capture that is still streaming**, where the textures were sized for the final count
   * at registration and are filled block by block — see `SplatCapture`. A caller that packed its
   * whole capture before registering the pass never needs this: `init` uploads everything.
   *
   * Whole rows are re-sent, so calling this with overlapping ranges is correct and merely costs
   * a few kilobytes; calling it every frame with the whole capture is not, and is the per-frame
   * upload the scheduler exists to avoid.
   */
  uploadSplats(from: number, count: number): void;
  /**
   * Whether the capture reaches the frame at all, as of the last `setView`.
   *
   * **Read this before asking a sorter for a new order.** A capture out of frame costs one
   * discarded draw call and a whole linear sort over every splat it has, and the sort is the
   * expensive half — so the caller's frame should skip `SplatSorter.frame` when this is false.
   * `draw` checks it too, but by then the sort has already happened.
   */
  readonly visible: boolean;
  readonly count: number;
}

/**
 * Build a pass for one capture.
 *
 * **The consumer decides where it lands in the frame**, by calling `drawPass` at that point. The
 * documented slot is **after opaque and translucent meshes, before particles and light volumes**:
 * splats are scene content that particles and beams are drawn *through*, and the depth test that
 * makes the composition work only sees geometry drawn before it.
 */
export function createSplatPass(splats: SplatData, label = 'splats'): SplatPass {
  let gl: Webgl2Splats | null = null;
  let gpu: GpuSplats | null = null;
  let device: GPUDevice | null = null;

  const rows = splatRows(splats.count);
  /* One padded row buffer, reused by every order upload so a re-sort allocates nothing. */
  const paddedOrder = new Uint32Array(SPLAT_STRIDE * rows);
  const model = new Float32Array(IDENTITY);
  let drawCount = 0;
  let pendingOrder: Uint32Array | null = null;
  /** A span of newly arrived splats waiting for a WebGL2 context. See `uploadSplats`. */
  let pendingRange: { from: number; to: number } | null = null;

  const view = new Float32Array(16);
  /** The caller's projection, pre-multiplied by the backend's clip correction. */
  const projection = new Float32Array(16);
  /**
   * Where the camera is in the capture's own space, which is where the harmonics were trained.
   *
   * Recomputed whenever the view or the model changes rather than every frame, because both are
   * setters and neither is called more than once a frame. Zero for a capture with no harmonics,
   * where nothing reads it.
   */
  const cameraLocal = new Float32Array(3);
  const shDegree = splats.shDegree;
  const texels = splatTexels(splats.wordsPerSplat);
  /* Identity until `init`, so a `setView` before registration is not silently zeroed. */
  let clipCorrection: ArrayLike<number> = IDENTITY;
  let viewportX = 1;
  let viewportY = 1;
  /* True until the first `setView`, so a caller that never sets one still draws. */
  let visible = true;

  const writeVertexUniforms = (target: GpuSplats): void => {
    const f = target.vertexFloats;
    const i = target.vertexInts;
    i[VERT.fields.uSplatCount.offset / 4] = drawCount;
    i[VERT.fields.uSplatStride.offset / 4] = SPLAT_STRIDE;
    i[VERT.fields.uSplatTexels.offset / 4] = texels;
    i[VERT.fields.uSplatShDegree.offset / 4] = shDegree;
    f.set(cameraLocal, VERT.fields.uSplatCameraLocal.offset / 4);
    f.set(view, VERT.fields.uView.offset / 4);
    f.set(projection, VERT.fields.uProjection.offset / 4);
    f[VERT.fields.uViewport.offset / 4] = viewportX;
    f[VERT.fields.uViewport.offset / 4 + 1] = viewportY;
    f.set(model, VERT.fields.uModel.offset / 4);
  };

  return {
    label,

    init(passDevice: PassDevice): void {
      /*
       * **The clip correction the renderer's own verbs use, not a copy of it.** WebGPU's
       * framebuffer origin is the top-left and OpenGL's is the bottom-left, and the engine settles
       * that in the matrix rather than in the shaders. This pass takes its camera from its caller,
       * so it never sees the corrected matrix — without this it drew the world upside down on
       * WebGPU, which is exactly the first frame that backend ever produced.
       */
      clipCorrection = passDevice.clipCorrection;
      if (passDevice.backend === 'webgl2') {
        gl = createWebgl2Splats(passDevice.gl, splats, label);
        return;
      }
      device = passDevice.device;
      gpu = createGpuSplats(
        passDevice.device,
        passDevice.format,
        passDevice.depthFormat,
        passDevice.samples,
        splats,
        label,
      );
    },

    setView(next: SplatView): void {
      view.set(next.view);
      multiplyMat4(projection, clipCorrection, next.projection);
      viewportX = next.widthPx;
      viewportY = next.heightPx;
      /*
       * Culled against the caller's **uncorrected** projection, because the frustum planes come
       * out of it in the convention `mat4.perspective` writes; the corrected one has moved z into
       * [0, 1] and flipped y, and its near plane would be a different plane.
       */
      visible = splatBoundsVisible(
        next.view,
        next.projection,
        model,
        splats.boundsMin,
        splats.boundsMax,
      );
      if (shDegree > 0) cameraInCaptureSpace(cameraLocal, view, model);
    },

    setModel(next: ArrayLike<number>): void {
      model.set(next);
      /* The camera's place in the capture's space moves when either matrix does, and a model set
         after a view would otherwise evaluate the harmonics against the previous placement. */
      if (shDegree > 0) cameraInCaptureSpace(cameraLocal, view, model);
    },

    uploadSplats(from: number, count: number): void {
      const first = Math.max(0, Math.min(from, splats.count));
      const howMany = Math.max(0, Math.min(count, splats.count - first));
      if (howMany <= 0) return;
      if (gpu !== null && device !== null) {
        uploadGpuSplatRange(device, gpu, splats.packed, first, howMany);
        return;
      }
      /*
       * WebGL2 has no context outside `draw`, so the range is remembered and pushed there — the
       * same reason `setOrder` holds a pending order. Ranges are merged rather than queued
       * because they arrive in file order and a merged span re-sends whole rows anyway.
       */
      if (pendingRange === null) pendingRange = { from: first, to: first + howMany };
      else {
        pendingRange.from = Math.min(pendingRange.from, first);
        pendingRange.to = Math.max(pendingRange.to, first + howMany);
      }
    },

    setOrder(order: Uint32Array, count: number): void {
      drawCount = Math.max(0, Math.min(count, splats.count));
      /*
       * Held rather than uploaded here, because a consumer may sort before the pass has a device:
       * `registerPass` runs `init` at registration, but a sorter finishing first is ordinary and
       * dropping its result would leave the capture blank until the view turned again.
       */
      pendingOrder = order;
      if (gl !== null) {
        // The upload needs a context, which only `draw` is handed on this backend.
        return;
      }
      if (gpu !== null && device !== null) {
        uploadGpuOrder(device, gpu, order, paddedOrder);
        pendingOrder = null;
      }
    },

    draw(ctx: PassContext): void {
      if (drawCount <= 0 || !visible) return;

      if (ctx.backend === 'webgl2') {
        if (gl === null) return;
        if (pendingRange !== null) {
          uploadWebgl2SplatRange(
            ctx.gl,
            gl,
            splats.packed,
            pendingRange.from,
            pendingRange.to - pendingRange.from,
          );
          pendingRange = null;
        }
        if (pendingOrder !== null) {
          uploadWebgl2Order(ctx.gl, gl, pendingOrder, paddedOrder);
          pendingOrder = null;
        }
        const { uniforms } = gl;
        ctx.gl.useProgram(gl.program);
        ctx.gl.uniform1i(uniforms['uSplatCount'] ?? null, drawCount);
        ctx.gl.uniform1i(uniforms['uSplatStride'] ?? null, SPLAT_STRIDE);
        ctx.gl.uniform1i(uniforms['uSplatTexels'] ?? null, texels);
        ctx.gl.uniform1i(uniforms['uSplatShDegree'] ?? null, shDegree);
        ctx.gl.uniform3fv(uniforms['uSplatCameraLocal'] ?? null, cameraLocal);
        ctx.gl.uniformMatrix4fv(uniforms['uView'] ?? null, false, view);
        ctx.gl.uniformMatrix4fv(uniforms['uProjection'] ?? null, false, projection);
        ctx.gl.uniform2f(uniforms['uViewport'] ?? null, viewportX, viewportY);
        ctx.gl.uniformMatrix4fv(uniforms['uModel'] ?? null, false, model);
        /* The frame's own grade, per `PassContext`: this is a forward pass and may be last. */
        ctx.gl.uniform1i(uniforms['uOutputTransform'] ?? null, ctx.outputTransform);
        ctx.gl.uniform1f(uniforms['uOutputExposure'] ?? null, ctx.outputExposure);
        drawWebgl2Splats(ctx.gl, gl, drawCount);
        return;
      }

      if (gpu === null || device === null) return;
      if (pendingOrder !== null) {
        uploadGpuOrder(device, gpu, pendingOrder, paddedOrder);
        pendingOrder = null;
      }
      writeVertexUniforms(gpu);
      device.queue.writeBuffer(gpu.vertexUniforms, 0, gpu.vertexScratch);
      gpu.fragmentInts[FRAG.fields.uOutputTransform.offset / 4] = ctx.outputTransform;
      gpu.fragmentFloats[FRAG.fields.uOutputExposure.offset / 4] = ctx.outputExposure;
      device.queue.writeBuffer(gpu.fragmentUniforms, 0, gpu.fragmentScratch);

      ctx.pass.setPipeline(gpu.pipeline);
      ctx.pass.setBindGroup(0, gpu.bindGroup);
      ctx.pass.draw(drawCount * 6);
    },

    dispose(passDevice: PassDevice): void {
      if (passDevice.backend === 'webgl2') {
        if (gl !== null) disposeWebgl2Splats(passDevice.gl, gl);
        gl = null;
        return;
      }
      if (gpu !== null) disposeGpuSplats(gpu);
      gpu = null;
      device = null;
    },

    get visible(): boolean {
      return visible;
    },

    get count(): number {
      return splats.count;
    },
  };
}

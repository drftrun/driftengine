/** The renderer's distance field, marched into the frame so it can be looked at. */

import {
  MARCH_EPSILON,
  MARCH_EYE,
  MARCH_FIELD_WGSL,
  MARCH_INV_VIEW_PROJ,
  MARCH_LEVELS,
  MARCH_PARAM_FLOATS,
  MARCH_SIDE,
  MARCH_STEPS,
} from '../../shaders/gi/marchField.wgsl.ts';

import type { ReadonlyMat4, ReadonlyVec3 } from 'gl-matrix';
import type {
  PassContext,
  PassDefinition,
  PassDevice,
  PassDistanceField,
  PrepareContext,
} from '../../pass.ts';

const COPY_DST = 0x0008;
const STORAGE = 0x0080;

/**
 * **It no longer composes the field, and that is the whole of what changed on 2026-09-18.**
 *
 * This pass used to take a list of instances, compose the world's distance field from them and
 * march the result. It was the only thing in the engine that composed a field at all — which meant
 * the *renderer* had none, and the indirect-light plan had four tasks written on the assumption
 * that it did. The lesson is in `CONTRIBUTING.md`, under auditing a closed plan: grep for who
 * calls a thing, not only for whether it exists.
 *
 * The composition now belongs to the renderer, from what a consumer declares with
 * `addDistanceField`, and this marches what the renderer composed. So there is one field in a
 * frame rather than two, and what this draws is the field the indirect light actually traces
 * — which is the only thing that makes the picture worth looking at.
 *
 * **What `draw` does is a visualisation, and that is deliberate.** A distance field is a thing you
 * can look at, and looking is what a number cannot replace: if the geometry is in the right places
 * at the right sizes the composition is right, and if a cascade boundary shows as a seam the fade
 * is wrong. Wave 4A's own recorded failure — a phantom surface that passed 111,907 parity samples
 * and was found by looking at a picture — is why this exists at all.
 *
 * **The field it marches is one frame old**, because the renderer composes at `endFrame` and
 * `prepare` runs at `beginFrame`. `PrepareContext.distanceField` says why that is right rather
 * than merely what happens.
 */
export interface GiFieldOptions {
  /** How many steps a marched ray may take before it gives up. */
  readonly marchSteps?: number;
}

const DEFAULT_MARCH_STEPS = 96;

export class GiFieldPass implements PassDefinition {
  readonly label = 'driftengine.gi-field';

  private readonly marchSteps: number;

  private device: GPUDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private group: GPUBindGroup | null = null;
  private params: GPUBuffer | null = null;
  /** The field the current bind group was built against, so a replaced buffer is noticed. */
  private boundTo: PassDistanceField | null = null;

  private readonly scratch = new Float32Array(MARCH_PARAM_FLOATS);
  private readonly eye: [number, number, number] = [0, 0, 0];

  constructor(options: GiFieldOptions = {}) {
    this.marchSteps = options.marchSteps ?? DEFAULT_MARCH_STEPS;
  }

  /**
   * Where the camera is and how to unproject from it, for this frame.
   *
   * **Taken rather than derived**, which is the contributed-pass contract: a pass gets its camera
   * from its caller and never sees the renderer's. `invViewProj` is column-major, as `gl-matrix`
   * stores one, and a caller that inverts the same matrix it drew the scene with gets rays that
   * land on the same pixels.
   */
  setView(eye: ReadonlyVec3, invViewProj: ReadonlyMat4): void {
    this.eye[0] = eye[0] ?? 0;
    this.eye[1] = eye[1] ?? 0;
    this.eye[2] = eye[2] ?? 0;
    for (let at = 0; at < 16; at += 1) {
      this.scratch[MARCH_INV_VIEW_PROJ + at] = invViewProj[at] ?? 0;
    }
  }

  init(device: PassDevice): void {
    if (device.backend !== 'webgpu') {
      /*
       * Loud at registration rather than silent at the first frame. Marching a distance field
       * means having one, and the field is composed by compute that WebGL2 does not have — the
       * same refusal `INDIRECT_LIGHT_WEBGL2_REFUSAL` makes, arriving at the seam where a consumer
       * can act on it.
       */
      throw new Error(
        '[driftengine] the global illumination field needs compute and this backend is WebGL2. ' +
          'Ask for WebGPU, or leave the field unregistered; nothing else in the frame depends on it.',
      );
    }
    const gpu = device.device;
    this.device = gpu;

    this.params = gpu.createBuffer({
      label: 'gi-field march params',
      size: this.scratch.byteLength,
      usage: STORAGE | COPY_DST,
    });

    const march = gpu.createShaderModule({ label: 'gi march', code: MARCH_FIELD_WGSL });
    this.pipeline = gpu.createRenderPipeline({
      label: 'gi march',
      layout: 'auto',
      vertex: { module: march, entryPoint: 'vertexMain' },
      fragment: {
        module: march,
        entryPoint: 'fragmentMain',
        targets: [{ format: device.format }],
      },
      primitive: { topology: 'triangle-list' },
      /*
       * **Depth tested against the frame's own attachment and not written to.** The field is drawn
       * where nothing else did, so geometry in front of it hides it; writing depth would make a
       * visualisation occlude the scene it is standing in for. `PassDevice.depthFormat` exists for
       * exactly this and was missing for as long as nobody depth-tested through this seam.
       */
      depthStencil: {
        format: device.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
      multisample: { count: device.samples },
    });
  }

  /**
   * Bind whatever field the renderer composed, and tell the march where to look.
   *
   * **The bind group is rebuilt only when the field it was built against is a different object.**
   * The renderer replaces its samples buffer when a scene's fields grow, and a group holding a
   * destroyed buffer is a validation error at the next draw rather than a wrong picture — but
   * rebuilding one every frame is the per-frame allocation the house rules are about.
   */
  prepare(ctx: PrepareContext): void {
    if (ctx.backend !== 'webgpu') return;
    const gpu = this.device;
    if (gpu === null || this.pipeline === null || this.params === null) return;

    const field = ctx.distanceField;
    if (field === null) {
      /* Nothing composed: no group, and `draw` then draws nothing rather than reading a stale one. */
      this.group = null;
      this.boundTo = null;
      return;
    }

    if (this.boundTo !== field) {
      this.group = gpu.createBindGroup({
        label: 'gi march',
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: field.cascades } },
          { binding: 2, resource: { buffer: field.samples } },
        ],
      });
      this.boundTo = field;
    }

    this.scratch[MARCH_EYE] = this.eye[0];
    this.scratch[MARCH_EYE + 1] = this.eye[1];
    this.scratch[MARCH_EYE + 2] = this.eye[2];
    this.scratch[MARCH_LEVELS] = field.levels;
    this.scratch[MARCH_SIDE] = field.side;
    this.scratch[MARCH_STEPS] = this.marchSteps;
    /* Half a voxel of the finest cascade: below that a march is polishing a value it cannot see. */
    this.scratch[MARCH_EPSILON] = field.finestStep * 0.5;
    gpu.queue.writeBuffer(this.params, 0, this.scratch);
  }

  /** March the field into the frame. Nothing is written where the ray found nothing. */
  draw(ctx: PassContext): void {
    if (ctx.backend !== 'webgpu') return;
    if (this.pipeline === null || this.group === null) return;
    ctx.pass.setPipeline(this.pipeline);
    ctx.pass.setBindGroup(0, this.group);
    ctx.pass.draw(3, 1, 0, 0);
  }

  dispose(): void {
    this.params?.destroy();
    this.group = null;
    this.boundTo = null;
  }
}

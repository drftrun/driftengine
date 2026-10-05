import {
  CLUSTER_COUNT,
  LIGHT_TEXELS,
  MAX_CLUSTERED_LIGHTS,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  type ClusterLightSet,
  clusteredLightTotal,
  writeLightRecord,
} from '../../clusteredLights.ts';
import { MAX_POINT_LIGHTS } from '../../lightBudget.ts';
import type { ComputeContext, ComputeDefinition, ComputeDevice } from '../../compute.ts';
import { CLUSTER_BIN_WGSL } from './shaders/clusterBin.wgsl.ts';

/**
 * The froxel binner on the GPU: the first thing in this engine to dispatch compute.
 *
 * **What it replaces is not a slow thing, it is a thing on the wrong processor.** The CPU binner
 * in `clusteredLights.ts` is measured at 0.386 ms a frame for sixteen lights and 2.0 ms for 256,
 * and 2 ms is 12% of a 60 fps frame spent on the main thread where a consumer's own game logic
 * lives. On WebGL2 there is nowhere else to put it. Here there is.
 *
 * **It writes the same table, and that is asserted rather than assumed.** `scripts/cluster-check.mjs`
 * runs both binners over one camera and one light set and compares the tables, because the
 * 2026-08-17 rule says two implementations of one decision drift invisibly when their constants
 * agree — which is exactly the situation this is.
 */

/*
 * WebGPU usage flags, named rather than read off the globals, for the reason `buffers.ts` gives:
 * the values are normative in the specification and the globals do not exist outside a browser.
 */
const BUFFER_USAGE = {
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const;

const TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
} as const;

/** `mat4` plus a `vec4` plus four `u32`, which is 96 bytes and already 16-byte aligned. */
const PARAMS_BYTES = 16 * 4 + 4 * 4 + 4 * 4;

/** Invocations a workgroup, matching `@workgroup_size` in the shader. */
const WORKGROUP = 64;

/** What the caller sets before each dispatch. Held rather than passed, so `dispatch` allocates none. */
export interface ClusterBinnerFrame {
  lights: ClusterLightSet;
  /** Column-major, as gl-matrix builds it. */
  view: Float32Array;
  near: number;
  far: number;
  tanHalfFovY: number;
  aspect: number;
  /** How many shadow uniform slots are live. See `LIGHT_TEXELS` in `clusteredLights.ts`. */
  shadowSlots: number;
}

export class ClusterBinner {
  /** The table the lit pass samples. Written by the dispatch, never by the CPU on this backend. */
  private texture: GPUTexture | null = null;
  private view: GPUTextureView | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private group: GPUBindGroup | null = null;
  private params: GPUBuffer | null = null;
  private lightBuffer: GPUBuffer | null = null;
  private device: GPUDevice | null = null;

  /** Staging for the two uploads, allocated once: `dispatch` is a per-frame path. */
  private readonly paramsStaging = new ArrayBuffer(PARAMS_BYTES);
  private readonly paramsFloats = new Float32Array(this.paramsStaging);
  private readonly paramsUints = new Uint32Array(this.paramsStaging);
  /* The records as bits, because one slot holds two halves that must not pass through a float. */
  private readonly lightStaging = new Uint32Array(MAX_CLUSTERED_LIGHTS * LIGHT_TEXELS * 4);

  private frame: ClusterBinnerFrame | null = null;

  /** The table's view, for whoever binds it into the lit pass. Null before `init`. */
  get tableView(): GPUTextureView | null {
    return this.view;
  }

  /** The table itself, which a readback needs and the lit pass does not. */
  get tableTexture(): GPUTexture | null {
    return this.texture;
  }

  /**
   * The device `init` was handed, for a caller that needs to encode a copy of its own.
   *
   * **Exposed rather than fetched from somewhere else**, because there is nowhere else: a
   * `GPUTexture` does not name its device and `createRenderer` does not return one. The seam
   * hands a definition the device precisely so it can do work of its own outside a dispatch, and
   * a readback is that work.
   */
  get gpuDevice(): GPUDevice | null {
    return this.device;
  }

  /** What the next dispatch bins. Set per frame; nothing is copied until `dispatch`. */
  setFrame(frame: ClusterBinnerFrame): void {
    this.frame = frame;
  }

  definition(): ComputeDefinition {
    return {
      label: 'lights.bin',
      init: (device: ComputeDevice) => this.build(device.device),
      dispatch: (ctx: ComputeContext) => this.run(ctx),
      dispose: () => this.release(),
    };
  }

  private build(device: GPUDevice): void {
    this.device = device;
    this.texture = device.createTexture({
      label: 'lights.clusterTable',
      size: [TABLE_WIDTH, TABLE_HEIGHT],
      /*
       * `rgba32uint` because the indices are integers and an integer is what a texture carries
       * exactly. It is also one of core WebGPU's storage-capable formats, which is what lets the
       * dispatch write it at all — and `texelFetch` reads the same format on WebGL2, which is the
       * whole reason the interface between binning and shading is a texture.
       */
      format: 'rgba32uint',
      usage: TEXTURE_USAGE.STORAGE_BINDING | TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_SRC,
    });
    this.view = this.texture.createView({ label: 'lights.clusterTable' });

    this.params = device.createBuffer({
      label: 'lights.bin.params',
      size: PARAMS_BYTES,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    });
    this.lightBuffer = device.createBuffer({
      label: 'lights.bin.lights',
      size: this.lightStaging.byteLength,
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
    });

    this.pipeline = device.createComputePipeline({
      label: 'lights.bin',
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ label: 'lights.bin', code: CLUSTER_BIN_WGSL }),
        entryPoint: 'main',
      },
    });
    this.group = device.createBindGroup({
      label: 'lights.bin',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
        { binding: 2, resource: this.view },
      ],
    });
  }

  private run(ctx: ComputeContext): void {
    const frame = this.frame;
    const { device, pipeline, group, params, lightBuffer } = this;
    if (frame === null || device === null || pipeline === null || group === null) return;
    if (params === null || lightBuffer === null) return;

    /* The lamps and the clustered rectangles after them. See `ClusterLightSet.areas`. */
    const count = clusteredLightTotal(frame.lights);

    /*
     * The records, by the function `buildLightClusters` writes them with, because the shader
     * copies them into the table verbatim and the lit pass reads one layout on both backends.
     */
    for (let light = 0; light < count; light++) {
      writeLightRecord(
        frame.lights,
        light,
        frame.shadowSlots,
        this.lightStaging,
        light * LIGHT_TEXELS * 4,
      );
    }

    this.paramsFloats.set(frame.view, 0);
    this.paramsFloats[16] = frame.near;
    this.paramsFloats[17] = frame.far;
    this.paramsFloats[18] = frame.tanHalfFovY;
    this.paramsFloats[19] = frame.aspect;
    this.paramsUints[20] = count;

    device.queue.writeBuffer(params, 0, this.paramsStaging);
    device.queue.writeBuffer(
      lightBuffer,
      0,
      this.lightStaging.buffer,
      0,
      count * LIGHT_TEXELS * 16,
    );

    ctx.pass.setPipeline(pipeline);
    ctx.pass.setBindGroup(0, group);
    /*
     * Enough invocations for every cluster. The first `count` of them also write a light record,
     * which they can because there are always far more clusters than lights.
     */
    ctx.pass.dispatchWorkgroups(Math.ceil(CLUSTER_COUNT / WORKGROUP));
  }

  private release(): void {
    this.texture?.destroy();
    this.params?.destroy();
    this.lightBuffer?.destroy();
    this.texture = null;
    this.view = null;
    this.params = null;
    this.lightBuffer = null;
    this.pipeline = null;
    this.group = null;
    this.device = null;
  }
}

/** The shadow slots a frame has, which is the fixed budget the pool is sized for. */
export const DEFAULT_SHADOW_SLOTS = MAX_POINT_LIGHTS;

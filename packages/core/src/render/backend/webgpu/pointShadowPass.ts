import { mat3, type mat4 } from 'gl-matrix';

import { LIVE_POINT_SHADOW_MAPS, POINT_SHADOW_POOL } from '../../lightBudget.ts';
import { OCTAHEDRAL_EDGE } from '../../pointShadowArray.ts';
import {
  createFaceRange,
  DEFAULT_SOURCE_RADIUS,
  FACE_COUNT,
  POINT_SHADOW_NEAR,
  PointShadowImage,
  pointShadowFaceRotation,
  pointShadowFaceViewProj,
  type FaceRange,
  type PointShadowSource,
} from '../../pointShadowImage.ts';
import {
  OCTAHEDRAL_RESOLVE_FRAG_WGSL,
  OCTAHEDRAL_RESOLVE_VERT_WGSL,
} from '../../shaders/generated/octahedralResolve.wgsl.ts';
import { SHADOW_FORMAT } from './depthPass.ts';
import { UniformRing } from './uniformRing.ts';

/**
 * A point light's shadow on this device: one octahedral layer, filled a face at a time.
 *
 * **The state is `PointShadowImage`'s and so is every decision in it**, which is what makes
 * this file short: a cube texture, six single-layer views to attach, one cube view to sample,
 * and a loop that opens a pass per face. Six shipped bug fixes come with the image rather than
 * being re-earned here — see that module.
 *
 * **Six passes, not six draws into one.** WebGPU attaches exactly one texture subresource to a
 * depth attachment, so a face is a render pass of its own; the clear that the GL path gets from
 * `gl.clear` is the pass's own `depthClearValue`. The cost is the same either way — the caster
 * set is walked once per face — which is why `pointShadowBudget.ts` exists on both backends.
 */

const USAGE_RENDER_ATTACHMENT = 0x10;
const USAGE_TEXTURE_BINDING = 0x4;
const USAGE_UNIFORM_DST = 0x40 | 0x8; // UNIFORM | COPY_DST
const VISIBILITY_FRAGMENT = 0x2;

/**
 * Slots for one frame's resolves: every pool layer's six faces, which no budget ever reaches.
 *
 * At 256 bytes a slot that is 24 KB of staging for a ceiling nothing approaches — the face
 * budget is a handful a frame — and the alternative is `allocate` returning null and a face
 * silently not landing in its layer.
 */
const RESOLVE_SLOTS = (POINT_SHADOW_POOL + LIVE_POINT_SHADOW_MAPS) * FACE_COUNT;

/** `mat3x3<f32>` then four scalars, at std140's sixteen-byte columns: see the generated struct. */
const RESOLVE_UNIFORM_SIZE = 64;

/** Filled per resolved face, at module scope, because a bake runs inside the frame's budget. */
const faceRotation = mat3.create();
/** One mat3x3 column, staged so `writeFloats` takes an array without allocating one. */
const rotationColumn = new Float32Array(3);

/**
 * Every point light's shadow as one array texture, and the scratch that fills it.
 *
 * The WebGPU half of `pointShadowArray.ts`; the reasoning lives there, and this is one texture,
 * one scratch and a pipeline. **The scratch is a separate texture on this backend too**, and not
 * for WebGL2's reason: WebGPU rejects a pass outright for holding a texture it is also sampling,
 * where WebGL2 raises `INVALID_OPERATION` at the draw. Two ways of saying the same thing, and
 * both say the resolve reads the scratch.
 */
export class GpuPointShadowArray {
  /** The array, as the shader samples it. */
  readonly view: GPUTextureView;
  readonly layers: number;
  /** Where a face is rendered before it is resolved. One, shared by every light. */
  readonly scratchView: GPUTextureView;

  private readonly texture: GPUTexture;
  private readonly scratch: GPUTexture;
  private readonly layerViews: GPUTextureView[] = [];
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  /**
   * A slot per resolved face, not one buffer written six times.
   *
   * **`queue.writeBuffer` does not interleave with encoded commands.** Writes are ordered on
   * the queue timeline and the encoder is submitted afterwards, so six writes between six
   * passes give all six passes the *last* face's rotation and index — and five of them then
   * discard every fragment, because `uFaceIndex` does not match. The layer stays empty and the
   * light stops casting, which reads as a lighting change rather than as a missing upload.
   *
   * That is the failure `UniformRing` exists for, described in its own header, and this file
   * reproduced it exactly. Found by capturing: WebGPU diverged from WebGL2 by seven times and
   * came out *brighter*, and flipping a coordinate in the resolve changed the frame by not one
   * pixel — which is what an empty map looks like.
   */
  private readonly ring: UniformRing;

  constructor(
    device: GPUDevice,
    faceSize: number,
    lightCount: number,
    /** Layers above the point pool, for a world's casting rectangles. See `pointShadowArray.ts`. */
    extraLayers = 0,
  ) {
    this.layers =
      Math.min(lightCount, POINT_SHADOW_POOL) + LIVE_POINT_SHADOW_MAPS + Math.max(0, extraLayers);

    this.texture = device.createTexture({
      label: 'pointShadow.array',
      size: [OCTAHEDRAL_EDGE, OCTAHEDRAL_EDGE, this.layers],
      format: SHADOW_FORMAT,
      usage: USAGE_RENDER_ATTACHMENT | USAGE_TEXTURE_BINDING,
    });
    this.view = this.texture.createView({ dimension: '2d-array' });
    for (let layer = 0; layer < this.layers; layer++) {
      this.layerViews.push(
        this.texture.createView({
          label: `pointShadow.layer${layer}`,
          dimension: '2d',
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        }),
      );
    }

    this.scratch = device.createTexture({
      label: 'pointShadow.scratch',
      size: [faceSize, faceSize],
      format: SHADOW_FORMAT,
      usage: USAGE_RENDER_ATTACHMENT | USAGE_TEXTURE_BINDING,
    });
    this.scratchView = this.scratch.createView();

    this.ring = new UniformRing(
      device,
      RESOLVE_UNIFORM_SIZE,
      RESOLVE_SLOTS,
      USAGE_UNIFORM_DST,
      'pointShadow.resolve.uniforms',
    );
    /*
     * `non-filtering` and `unfilterable-float`, matching `flatPass.ts`: the scratch is a depth
     * format, whose supported sample types are UnfilterableFloat and Depth and never plain
     * Float, and nothing here asks the hardware to filter.
     */
    const layout = device.createBindGroupLayout({
      label: 'pointShadow.resolve.layout',
      entries: [
        {
          binding: 1,
          visibility: VISIBILITY_FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: RESOLVE_UNIFORM_SIZE,
          },
        },
        {
          binding: 32,
          visibility: VISIBILITY_FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 33, visibility: VISIBILITY_FRAGMENT, sampler: { type: 'non-filtering' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'pointShadow.resolve',
      layout,
      entries: [
        { binding: 1, resource: { buffer: this.ring.buffer, size: RESOLVE_UNIFORM_SIZE } },
        { binding: 32, resource: this.scratchView },
        { binding: 33, resource: device.createSampler({ label: 'pointShadow.resolve.sampler' }) },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'pointShadow.resolve',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module: device.createShaderModule({ code: OCTAHEDRAL_RESOLVE_VERT_WGSL }),
        entryPoint: 'main',
      },
      fragment: {
        module: device.createShaderModule({ code: OCTAHEDRAL_RESOLVE_FRAG_WGSL }),
        entryPoint: 'main',
        targets: [],
      },
      primitive: { topology: 'triangle-list' },
      /*
       * `always`, because this is a copy and not a render: the layer holds whatever the previous
       * bake of this light left, and a fragment that lost a comparison would leave half of one
       * image and half of another.
       */
      depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
    });
  }

  /**
   * Write the scratch's contents into `layer`'s region for `face`.
   *
   * A pass of its own on the caller's encoder, with `load` rather than `clear`: the other five
   * faces of this layer are already there and must survive. `discard` in the shader is what
   * keeps this face to its own region.
   */
  resolve(
    encoder: GPUCommandEncoder,
    layer: number,
    face: number,
    far: number,
    near: number,
  ): void {
    const view = this.layerViews[layer];
    if (view === undefined) return;
    const slot = this.ring.allocate();
    if (slot === null) return;

    pointShadowFaceRotation(face, faceRotation);
    /* WGSL pads a mat3x3 to three four-float columns; the generated struct expects that. */
    for (let column = 0; column < 3; column++) {
      rotationColumn[0] = faceRotation[column * 3] as number;
      rotationColumn[1] = faceRotation[column * 3 + 1] as number;
      rotationColumn[2] = faceRotation[column * 3 + 2] as number;
      this.ring.writeFloats(slot, column * 16, rotationColumn);
    }
    this.ring.writeInt(slot, 48, face);
    this.ring.writeFloat(slot, 52, far);
    this.ring.writeFloat(slot, 56, near);
    this.ring.writeFloat(slot, 60, OCTAHEDRAL_EDGE);

    const pass = encoder.beginRenderPass({
      label: 'pointShadow.resolve',
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup, [slot]);
    pass.draw(3);
    pass.end();
  }

  /** Start a frame's bakes. See the ring: slots are reused and nothing is freed. */
  beginFrame(): void {
    this.ring.reset();
  }

  /** Upload every slot this frame's resolves took, in one write, before the encoder is submitted. */
  flush(): void {
    this.ring.flush();
  }

  dispose(): void {
    this.texture.destroy();
    this.scratch.destroy();
    this.ring.dispose();
  }
}

/** What a face's pass needs from the caller: somewhere to record, and the casters to record. */
export type PointShadowFacePass = (view: GPUTextureView, viewProj: mat4) => void;

/** And what turns that face into its region of the light's octahedral layer. */
export type PointShadowResolve = (layer: number, face: number, far: number, near: number) => void;

export class GpuPointShadowMap implements PointShadowSource {
  readonly size: number;
  /** Which layer of the shared array this map's image lives in. See `pointShadowMap.ts`. */
  readonly layer: number;

  private readonly array: () => GpuPointShadowArray | null;
  private readonly image = new PointShadowImage();
  private readonly range: FaceRange = createFaceRange();

  constructor(array: () => GpuPointShadowArray | null, layer: number, size: number) {
    this.array = array;
    this.layer = layer;
    this.size = size;
  }

  get far(): number {
    return this.image.far;
  }

  get near(): number {
    return this.image.near;
  }

  get sourceRadius(): number {
    return this.image.sourceRadius;
  }

  /** Where the image was rendered from, not where the light is now. See the image. */
  get originX(): number {
    return this.image.originX;
  }

  get originY(): number {
    return this.image.originY;
  }

  get originZ(): number {
    return this.image.originZ;
  }

  get hasBaked(): boolean {
    return this.image.hasBaked;
  }

  get presence(): number {
    return this.image.presence;
  }

  matchesSource(
    x: number,
    y: number,
    z: number,
    range: number,
    near: number,
    sourceRadius = DEFAULT_SOURCE_RADIUS,
    tolerance = 0,
  ): boolean {
    return this.image.matchesSource(x, y, z, range, near, sourceRadius, tolerance);
  }

  advance(dt: number): void {
    this.image.advance(dt);
  }

  forget(): void {
    this.image.forget();
  }

  /**
   * Render up to `maxFaces` of the six, resuming a bake already under way.
   *
   * Returns how many faces were rendered. `renderFace` is handed the attachment and the face's
   * view-projection and is expected to open a pass and draw the casters into it — the renderer
   * owns the encoder and the pipelines, so it owns the pass.
   *
   * The scratch matrix is the caller's for the same reason `pointShadowFaceViewProj` takes one:
   * this runs once per face of every bake and `AGENTS.md` allows no allocation there.
   */
  bake(
    x: number,
    y: number,
    z: number,
    range: number,
    renderFace: PointShadowFacePass,
    resolveFace: PointShadowResolve,
    scratch: mat4,
    near = POINT_SHADOW_NEAR,
    sourceRadius = DEFAULT_SOURCE_RADIUS,
    maxFaces = FACE_COUNT,
  ): number {
    /*
     * What to render now, **and what to render it for**. A bake in flight owns the parameters
     * it started with; the arguments here only propose one that is not already under way. See
     * `planBake` for the permanent artefact reading them unconditionally left in a moving
     * light's map, and `pointShadowMap.ts` for the other backend making the identical call.
     */
    const plan = this.image.planBake(x, y, z, range, near, sourceRadius, maxFaces, this.range);
    const { first, last } = plan;
    if (last <= first) return 0;
    const array = this.array();
    if (array === null) return 0;

    for (let face = first; face < last; face++) {
      renderFace(
        array.scratchView,
        pointShadowFaceViewProj(face, plan.x, plan.y, plan.z, plan.near, plan.range, scratch),
      );
      resolveFace(this.layer, face, plan.range, plan.near);
    }

    this.image.completeBake(last, plan.x, plan.y, plan.z, plan.range, plan.near, plan.sourceRadius);
    return last - first;
  }

  /** Nothing to free: every GPU object belongs to `GpuPointShadowArray` now. */
  dispose(): void {}
}

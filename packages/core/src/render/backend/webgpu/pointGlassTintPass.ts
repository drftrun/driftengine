/**
 * What a lamp's light keeps through glass, on this device: an `rgba8unorm` array of one layer a
 * light, the face-sized colour scratch a face's glass is multiplied into, and the resolve that
 * copies a face into its octahedral region. The twin of `pointGlassTint.ts`, which says what the
 * channels hold and why the chain exists.
 *
 * **The chain is a `SnapshotMips` per layer**, made the first time that layer is touched and
 * recorded once a round for the layers the round touched — a layer's levels are its own
 * subresources here, so nothing is staged the way the other backend must.
 */
import { mat3 } from 'gl-matrix';

import { pointShadowFaceRotation } from '../../pointShadowImage.ts';
import {
  OCTAHEDRAL_RESOLVE_TINT_FRAG_WGSL,
  OCTAHEDRAL_RESOLVE_VERT_WGSL,
  OCTAHEDRALRESOLVE_BINDINGS,
} from '../../shaders/generated/octahedralResolve.wgsl.ts';
import { SnapshotMips } from './snapshotMips.ts';
import type { MipPipelines } from './surfaceTexturePass.ts';
import { UniformRing } from './uniformRing.ts';

const USAGE_RENDER_ATTACHMENT = 0x10;
const USAGE_TEXTURE_BINDING = 0x4;
const USAGE_UNIFORM_DST = 0x40 | 0x8; // UNIFORM | COPY_DST
const VISIBILITY_FRAGMENT = 0x2;
const TINT = OCTAHEDRALRESOLVE_BINDINGS.OCTAHEDRAL_RESOLVE_TINT_FRAG;

const faceRotation = mat3.create();
const rotationColumn = new Float32Array(3);

export class GpuPointGlassTint {
  readonly texture: GPUTexture;
  /** The whole array, for the lit pass. */
  readonly view: GPUTextureView;
  /** The colour scratch a face's glass is multiplied into. */
  readonly scratchView: GPUTextureView;
  readonly edge: number;

  private readonly device: GPUDevice;
  private readonly pipelines: MipPipelines;
  private readonly scratch: GPUTexture;
  private readonly layerViews: GPUTextureView[] = [];
  private readonly mips: (SnapshotMips | undefined)[] = [];
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly ring: UniformRing;
  private readonly heldFaces: Uint8Array;
  private readonly dirty: Uint8Array;

  constructor(
    device: GPUDevice,
    pipelines: MipPipelines,
    faceSize: number,
    edge: number,
    layers: number,
    /** Resolves a frame can make: the array's own figure, since every face resolves once. */
    slots: number,
    encoder: GPUCommandEncoder,
  ) {
    this.device = device;
    this.pipelines = pipelines;
    this.edge = edge;
    this.heldFaces = new Uint8Array(layers);
    /* Every layer's chain is filled once at birth, so a level nothing has touched is white too. */
    this.dirty = new Uint8Array(layers).fill(1);
    this.texture = device.createTexture({
      label: 'pointShadow.tint',
      size: [edge, edge, layers],
      format: 'rgba8unorm',
      mipLevelCount: Math.floor(Math.log2(Math.max(1, edge))) + 1,
      usage: USAGE_RENDER_ATTACHMENT | USAGE_TEXTURE_BINDING,
    });
    this.view = this.texture.createView({ dimension: '2d-array' });
    for (let layer = 0; layer < layers; layer++) {
      this.layerViews.push(
        this.texture.createView({
          label: `pointShadow.tint.layer${layer}`,
          dimension: '2d',
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      );
    }
    this.scratch = device.createTexture({
      label: 'pointShadow.tint.scratch',
      size: [faceSize, faceSize],
      format: 'rgba8unorm',
      usage: USAGE_RENDER_ATTACHMENT | USAGE_TEXTURE_BINDING,
    });
    this.scratchView = this.scratch.createView();

    this.ring = new UniformRing(
      device,
      TINT.uniformSize,
      slots,
      USAGE_UNIFORM_DST,
      'pointShadow.tint.uniforms',
    );
    const layout = device.createBindGroupLayout({
      label: 'pointShadow.tint.resolve.layout',
      entries: [
        {
          binding: TINT.uniforms,
          visibility: VISIBILITY_FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: TINT.uniformSize },
        },
        {
          binding: TINT.textures.uFace.texture,
          visibility: VISIBILITY_FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: TINT.textures.uFace.sampler,
          visibility: VISIBILITY_FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'pointShadow.tint.resolve',
      layout,
      entries: [
        { binding: TINT.uniforms, resource: { buffer: this.ring.buffer, size: TINT.uniformSize } },
        { binding: TINT.textures.uFace.texture, resource: this.scratchView },
        {
          binding: TINT.textures.uFace.sampler,
          resource: device.createSampler({ label: 'pointShadow.tint.resolve.sampler' }),
        },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'pointShadow.tint.resolve',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module: device.createShaderModule({ code: OCTAHEDRAL_RESOLVE_VERT_WGSL }),
        entryPoint: 'main',
      },
      fragment: {
        module: device.createShaderModule({ code: OCTAHEDRAL_RESOLVE_TINT_FRAG_WGSL }),
        entryPoint: 'main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    /* Every layer born clear: a light no pane has reached lets everything through. */
    for (const view of this.layerViews) {
      encoder
        .beginRenderPass({
          label: 'pointShadow.tint.clear',
          colorAttachments: [{ view, loadOp: 'clear', clearValue: [1, 1, 1, 1], storeOp: 'store' }],
        })
        .end();
    }
  }

  /** Whether `face` of `layer` holds glass: a face that does must be cleared before it is reused. */
  held(layer: number, face: number): boolean {
    return (((this.heldFaces[layer] ?? 0) >> face) & 1) === 1;
  }

  /** Copy the colour scratch into `face`'s region of `layer`, and remember whether it held glass. */
  resolve(encoder: GPUCommandEncoder, layer: number, face: number, drawn: boolean): void {
    const view = this.layerViews[layer];
    if (view === undefined) return;
    const slot = this.ring.allocate();
    if (slot === null) return;
    pointShadowFaceRotation(face, faceRotation);
    /* WGSL pads a mat3x3 to three four-float columns; the generated struct expects that. */
    const rotation = TINT.fields.uFaceRotation.offset;
    for (let column = 0; column < 3; column++) {
      rotationColumn[0] = faceRotation[column * 3] as number;
      rotationColumn[1] = faceRotation[column * 3 + 1] as number;
      rotationColumn[2] = faceRotation[column * 3 + 2] as number;
      this.ring.writeFloats(slot, rotation + column * 16, rotationColumn);
    }
    this.ring.writeInt(slot, TINT.fields.uFaceIndex.offset, face);
    this.ring.writeFloat(slot, TINT.fields.uEdge.offset, this.edge);

    const pass = encoder.beginRenderPass({
      label: 'pointShadow.tint.resolve',
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup, [slot]);
    pass.draw(3);
    pass.end();

    const bit = 1 << face;
    const was = this.heldFaces[layer] ?? 0;
    this.heldFaces[layer] = drawn ? was | bit : was & ~bit;
    this.dirty[layer] = 1;
  }

  /** The chain frost reads, for every layer touched since the last call. */
  recordMips(encoder: GPUCommandEncoder): void {
    for (let layer = 0; layer < this.dirty.length; layer++) {
      if (this.dirty[layer] !== 1) continue;
      this.dirty[layer] = 0;
      let chain = this.mips[layer];
      if (chain === undefined) {
        chain = new SnapshotMips(
          this.device,
          this.pipelines,
          this.texture,
          'rgba8unorm',
          layer,
          'pointShadow.tint.mips',
        );
        this.mips[layer] = chain;
      }
      chain.record(encoder);
    }
  }

  beginFrame(): void {
    this.ring.reset();
  }

  /** Before the round's submit: the slots are written and must be up before any pass reads. */
  flush(): void {
    this.ring.flush();
  }

  dispose(): void {
    this.texture.destroy();
    this.scratch.destroy();
    this.ring.dispose();
  }
}

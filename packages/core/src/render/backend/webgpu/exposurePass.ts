import {
  EXPOSURE_ADAPT_FRAG_WGSL,
  EXPOSURE_BINDINGS,
  EXPOSURE_METER_FRAG_WGSL,
} from '../../shaders/generated/exposure.wgsl.ts';
import {
  EXPOSURE_LOCAL_FRAG_WGSL,
  LOCALEXPOSURE_BINDINGS,
} from '../../shaders/generated/localExposure.wgsl.ts';
import { METER_GRID, adaptBlend } from '../../shaders/exposure.ts';
import { LOCAL_GRID_WIDTH } from '../../shaders/localExposure.ts';
import { createPostStageLayout, postPipeline } from './postPass.ts';
import type { PipelineCache } from './pipelineCache.ts';

/**
 * Eye adaptation on WebGPU: meter the finished scene into the frame's own encoder, and follow it
 * with a held brightness the composite reads. See `shaders/exposure.ts` for the design.
 *
 * **One held texel the composite always binds, and a scratch the adaptation writes.** Reading and
 * writing one texture in a pass is refused, and a pair that swapped roles would mean a composite
 * bind group per role; so the adaptation writes the scratch from the held value and a copy puts it
 * back, on the same encoder, before the composite reads it. Recorded into the frame's encoder
 * rather than submitted apart, because a separate submission would run before the frame that
 * draws the scene it is meant to measure.
 *
 * **And local exposure's grid, when that is asked for**, in the same encoder after the meter:
 * `rg16float`, a sum and a count per tile per band, sampled filtered by the composite. See
 * `localExposure.ts`.
 */

const METER = EXPOSURE_BINDINGS.EXPOSURE_METER_FRAG.textures;
const ADAPT = EXPOSURE_BINDINGS.EXPOSURE_ADAPT_FRAG;
const LOCAL = LOCALEXPOSURE_BINDINGS.EXPOSURE_LOCAL_FRAG.textures;
const USAGE_RENDER = 0x10;
const USAGE_TEXTURE = 0x04;
const USAGE_COPY_SRC = 0x01;
const USAGE_COPY_DST = 0x02;
const USAGE_UNIFORM_DST = 0x40 | 0x08;
const VISIBILITY_FRAGMENT = 0x2;

export class ExposurePass {
  private readonly meter: GPUTexture;
  private readonly meterView: GPUTextureView;
  private readonly held: GPUTexture;
  /** The texel the composite binds, for its bind group. */
  readonly heldView: GPUTextureView;
  private readonly scratch: GPUTexture;
  private readonly scratchView: GPUTextureView;
  private readonly localGrid: GPUTexture;
  /** Local exposure's grid, for the composite's bind group. */
  readonly localView: GPUTextureView;
  private readonly localLayout: GPUBindGroupLayout;
  private localGroup: GPUBindGroup | null = null;
  private localSource: GPUTextureView | null = null;
  private readonly meterLayout: GPUBindGroupLayout;
  private readonly adaptLayout: GPUBindGroupLayout;
  private readonly adaptGroup: GPUBindGroup;
  private readonly uniforms: GPUBuffer;
  private readonly blend = new Float32Array(4);
  private meterGroup: GPUBindGroup | null = null;
  private meterSource: GPUTextureView | null = null;
  /** Whether anything is held yet: the first frame, and the first after a cut, snaps. */
  private holding = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: PipelineCache,
    private readonly sampler: GPUSampler,
  ) {
    const target = (label: string, size: number, usage: number): GPUTexture =>
      device.createTexture({ label, size: [size, size], format: 'r16float', usage });
    this.meter = target('exposure.meter', METER_GRID, USAGE_RENDER | USAGE_TEXTURE);
    this.held = target('exposure.held', 1, USAGE_RENDER | USAGE_TEXTURE | USAGE_COPY_DST);
    this.scratch = target('exposure.scratch', 1, USAGE_RENDER | USAGE_COPY_SRC);
    this.localGrid = device.createTexture({
      label: 'exposure.localGrid',
      size: [LOCAL_GRID_WIDTH, METER_GRID],
      format: 'rg16float',
      usage: USAGE_RENDER | USAGE_TEXTURE,
    });
    this.localView = this.localGrid.createView();
    this.meterView = this.meter.createView();
    this.heldView = this.held.createView();
    this.scratchView = this.scratch.createView();

    /* The meter has no uniforms, so its layout is its one texture and sampler and nothing else. */
    this.meterLayout = device.createBindGroupLayout({
      label: 'exposure.meterLayout',
      entries: [
        { binding: METER.uScene.texture, visibility: VISIBILITY_FRAGMENT, texture: {} },
        { binding: METER.uScene.sampler, visibility: VISIBILITY_FRAGMENT, sampler: {} },
      ],
    });
    this.localLayout = device.createBindGroupLayout({
      label: 'exposure.localLayout',
      entries: [
        { binding: LOCAL.uScene.texture, visibility: VISIBILITY_FRAGMENT, texture: {} },
        { binding: LOCAL.uScene.sampler, visibility: VISIBILITY_FRAGMENT, sampler: {} },
      ],
    });
    this.adaptLayout = createPostStageLayout(device, ADAPT.uniforms, ADAPT.uniformSize, [
      { binding: ADAPT.textures.uMeter },
      { binding: ADAPT.textures.uHeld },
    ]);
    this.uniforms = device.createBuffer({
      label: 'exposure.uniforms',
      size: ADAPT.uniformSize,
      usage: USAGE_UNIFORM_DST,
    });
    this.adaptGroup = device.createBindGroup({
      label: 'exposure.adaptGroup',
      layout: this.adaptLayout,
      entries: [
        { binding: ADAPT.uniforms, resource: { buffer: this.uniforms, size: ADAPT.uniformSize } },
        { binding: ADAPT.textures.uMeter.texture, resource: this.meterView },
        { binding: ADAPT.textures.uMeter.sampler, resource: sampler },
        { binding: ADAPT.textures.uHeld.texture, resource: this.heldView },
        { binding: ADAPT.textures.uHeld.sampler, resource: sampler },
      ],
    });
  }

  /** Forget what is held, so the next frame meters afresh rather than easing from another shot. */
  cut(): void {
    this.holding = false;
  }

  /**
   * Meter `scene` and move the held brightness toward it by `dtSec` of adaptation, and with `local`
   * draw local exposure's grid too.
   */
  run(encoder: GPUCommandEncoder, scene: GPUTextureView, dtSec: number, local = false): void {
    const { device } = this;
    if (this.meterSource !== scene || this.meterGroup === null) {
      this.meterGroup = device.createBindGroup({
        label: 'exposure.meterGroup',
        layout: this.meterLayout,
        entries: [
          { binding: METER.uScene.texture, resource: scene },
          { binding: METER.uScene.sampler, resource: this.sampler },
        ],
      });
      this.meterSource = scene;
    }
    this.blend[0] = adaptBlend(dtSec, !this.holding);
    device.queue.writeBuffer(this.uniforms, 0, this.blend);

    const meter = encoder.beginRenderPass({
      label: 'exposure.meter',
      colorAttachments: [
        { view: this.meterView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    meter.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.meterLayout,
        'exposure.meter',
        EXPOSURE_METER_FRAG_WGSL,
        'r16float',
      ),
    );
    meter.setBindGroup(0, this.meterGroup);
    meter.draw(3);
    meter.end();
    if (local) this.drawLocal(encoder, scene);

    const adapt = encoder.beginRenderPass({
      label: 'exposure.adapt',
      colorAttachments: [
        { view: this.scratchView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    adapt.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.adaptLayout,
        'exposure.adapt',
        EXPOSURE_ADAPT_FRAG_WGSL,
        'r16float',
      ),
    );
    adapt.setBindGroup(0, this.adaptGroup, [0]);
    adapt.draw(3);
    adapt.end();
    encoder.copyTextureToTexture({ texture: this.scratch }, { texture: this.held }, [1, 1, 1]);
    this.holding = true;
  }

  /** Local exposure's grid, from the same scene the meter read. */
  private drawLocal(encoder: GPUCommandEncoder, scene: GPUTextureView): void {
    const { device } = this;
    if (this.localSource !== scene || this.localGroup === null) {
      this.localGroup = device.createBindGroup({
        label: 'exposure.localGroup',
        layout: this.localLayout,
        entries: [
          { binding: LOCAL.uScene.texture, resource: scene },
          { binding: LOCAL.uScene.sampler, resource: this.sampler },
        ],
      });
      this.localSource = scene;
    }
    const pass = encoder.beginRenderPass({
      label: 'exposure.local',
      colorAttachments: [
        { view: this.localView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(
      postPipeline(
        this.pipelines,
        device,
        this.localLayout,
        'exposure.local',
        EXPOSURE_LOCAL_FRAG_WGSL,
        'rg16float',
      ),
    );
    pass.setBindGroup(0, this.localGroup);
    pass.draw(3);
    pass.end();
  }

  dispose(): void {
    this.localGrid.destroy();
    this.meter.destroy();
    this.held.destroy();
    this.scratch.destroy();
    this.uniforms.destroy();
  }
}

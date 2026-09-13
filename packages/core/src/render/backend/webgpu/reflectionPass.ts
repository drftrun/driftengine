import { Camera } from '../../camera.ts';
import {
  mirrorCamera,
  reflectionClipPlane,
  reflectionTargetSize,
  type ReflectionSize,
} from '../../planarReflectionDraw.ts';
import { DEPTH_FORMAT } from './flatPass.ts';

/**
 * The target one horizontal planar reflection is drawn into, and the camera that draws it.
 *
 * **A second render pass inside a frame, which is the shape WebGPU makes explicit.** WebGL2
 * swaps a framebuffer binding and carries on; here the frame's pass has to be *ended* and a new
 * one opened on these attachments, then the frame's reopened with `load` so what it already
 * holds survives. `WebGPURenderer` does that switching; this owns the textures and the
 * arithmetic.
 *
 * **It carries the frame's sample count**, which WebGL2's does not. Every pipeline in this
 * backend is built against `PipelineCache`'s one count, so a one-sample reflection target could
 * not accept a single existing pipeline — and the alternative, a second set of pipelines keyed
 * by sample count, is a lot of machinery to make a mirror look worse. Recorded as a difference
 * rather than matched down: a scene at `sceneSamples: 4` gets an antialiased reflection here and
 * an aliased one on WebGL2.
 */

const USAGE_RENDER_ATTACHMENT = 0x10;
const USAGE_TEXTURE_BINDING = 0x4;

export interface GpuReflection {
  /** The camera the caller draws the mirrored world with. */
  readonly camera: Camera;
  /** `dot(vec4(worldPos, 1), plane) >= 0` is the half the mirrored pass may draw. */
  readonly clipPlane: Float32Array;
  /** The sampled texture — the resolve target when multisampling, the attachment otherwise. */
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly width: number;
  readonly height: number;
  /** What `beginRenderPass` is handed: the multisampled attachment, or the sampled texture. */
  readonly attachmentView: GPUTextureView;
  /** Set only when multisampling, where the attachment and the sampled texture differ. */
  readonly resolveView: GPUTextureView | null;
  readonly depthView: GPUTextureView;
  dispose(): void;
}

/**
 * Allocate the target at the size the frame is about to be.
 *
 * Eagerly, from `resize`, rather than on the first frame that shows water — the WebGL2 side
 * records why: allocated lazily it landed in whichever frame first put water on screen, measured
 * as 28% of a 62 ms frame, which is a stall in the middle of play rather than during a load.
 */
export function createGpuReflection(
  device: GPUDevice,
  format: GPUTextureFormat,
  canvasWidth: number,
  canvasHeight: number,
  scale: number,
  maxTextureSize: number,
  samples: number,
  size: ReflectionSize,
): GpuReflection {
  const { width, height } = reflectionTargetSize(
    canvasWidth,
    canvasHeight,
    scale,
    maxTextureSize,
    size,
  );

  const sampled = device.createTexture({
    label: 'reflection.color',
    size: [width, height],
    format,
    usage: USAGE_RENDER_ATTACHMENT | USAGE_TEXTURE_BINDING,
  });
  const msaa =
    samples === 1
      ? null
      : device.createTexture({
          label: 'reflection.colorMsaa',
          size: [width, height],
          format,
          sampleCount: samples,
          usage: USAGE_RENDER_ATTACHMENT,
        });
  const depth = device.createTexture({
    label: 'reflection.depth',
    size: [width, height],
    format: DEPTH_FORMAT,
    sampleCount: samples,
    usage: USAGE_RENDER_ATTACHMENT,
  });

  const view = sampled.createView();
  return {
    camera: new Camera(),
    clipPlane: new Float32Array(4),
    view,
    /*
     * `linear` and clamped, matching what `planarReflection.ts` asks WebGL2 for. The shader
     * takes several taps of its own on top, so this is the blend between texels rather than
     * the filtering.
     */
    sampler: device.createSampler({
      label: 'reflection.sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
    width,
    height,
    attachmentView: msaa === null ? view : msaa.createView(),
    resolveView: msaa === null ? null : view,
    depthView: depth.createView(),
    dispose(): void {
      sampled.destroy();
      msaa?.destroy();
      depth.destroy();
    },
  };
}

/** Point the mirrored camera and settle the clip plane. Both live in `planarReflectionDraw`. */
export function aimReflection(reflection: GpuReflection, source: Camera, planeY: number): Camera {
  mirrorCamera(
    source,
    planeY,
    reflection.width / Math.max(reflection.height, 1),
    reflection.camera,
  );
  reflectionClipPlane(source.position[1] ?? 0, planeY, reflection.clipPlane);
  return reflection.camera;
}

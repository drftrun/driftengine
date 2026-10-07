/**
 * A bone animation's textures on this backend, and a batch's clocks: what
 * `shaders/boneAnimation.ts` reads by index, made once and never filtered.
 *
 * **`rgba32float` places and turns, and `rg32float` clocks**, all read with `textureLoad` and bound
 * `unfilterable-float`, as the joint palette is: a turn in half floats moves a crowd's hands by a
 * thousandth of their reach, a jitter at the frame's rate, and the bytes are a clip's, once.
 */
import {
  CLOCK_TEXTURE_WIDTH,
  type BoneAnimationHandle,
  type BoneAnimationTexels,
} from '../../boneAnimation.ts';

const USAGE_TEXTURE = 0x4 | 0x2; // TEXTURE_BINDING | COPY_DST

/** A clip on the device, from `createBoneAnimation`. */
export class GpuBoneAnimation implements BoneAnimationHandle {
  readonly bones: number;
  readonly frames: number;
  readonly framesPerSecond: number;
  readonly boneScale: number;
  readonly placesView: GPUTextureView;
  readonly turnsView: GPUTextureView;
  disposed = false;
  private readonly places: GPUTexture;
  private readonly turns: GPUTexture;

  constructor(device: GPUDevice, texels: BoneAnimationTexels) {
    this.bones = texels.bones;
    this.frames = texels.frames;
    this.framesPerSecond = texels.framesPerSecond;
    this.boneScale = texels.boneScale;
    const make = (label: string, data: Float32Array): GPUTexture => {
      const texture = device.createTexture({
        label,
        size: [texels.bones, texels.frames],
        format: 'rgba32float',
        usage: USAGE_TEXTURE,
      });
      device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: texels.bones * 16, rowsPerImage: texels.frames },
        [texels.bones, texels.frames],
      );
      return texture;
    };
    this.places = make('bones.places', texels.places);
    this.turns = make('bones.turns', texels.turns);
    this.placesView = this.places.createView();
    this.turnsView = this.turns.createView();
  }

  dispose(): void {
    this.disposed = true;
    this.places.destroy();
    this.turns.destroy();
  }
}

/** A batch's clocks: two floats an instance, wrapped onto rows `CLOCK_TEXTURE_WIDTH` wide. */
export class GpuInstanceClocks {
  readonly view: GPUTextureView;
  readonly staging: Float32Array;
  private readonly texture: GPUTexture;
  private readonly width: number;

  constructor(device: GPUDevice, capacity: number, label: string) {
    this.width = Math.max(1, Math.min(capacity, CLOCK_TEXTURE_WIDTH));
    const rows = Math.max(1, Math.ceil(capacity / this.width));
    this.staging = new Float32Array(this.width * rows * 2);
    this.texture = device.createTexture({
      label,
      size: [this.width, rows],
      format: 'rg32float',
      usage: USAGE_TEXTURE,
    });
    this.view = this.texture.createView();
  }

  /** The rows that hold the first `count` instances, from `staging`. */
  upload(queue: GPUQueue, count: number): void {
    if (count <= 0) return;
    const rows = Math.ceil(count / this.width);
    queue.writeTexture(
      { texture: this.texture },
      this.staging,
      { bytesPerRow: this.width * 8, rowsPerImage: rows },
      [this.width, rows],
    );
  }

  dispose(): void {
    this.texture.destroy();
  }
}

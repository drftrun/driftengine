/**
 * A cloth binding's textures on WebGPU: the binding and the rest particles once, a mesh's; the
 * particles every frame, a character's — the twin of `webgl2/clothTextures.ts`.
 *
 * `rgba32float`, read by `textureLoad` in the vertex stage, so bound as `unfilterable-float` and
 * never sampled. Two particle textures that swap on each update, so last frame's positions stay for
 * a motion vector with no copy. **Written with `writeTexture`, whose queue order is the trap the
 * per-draw rings exist for**: an update lands before every draw of the frame, so a character's
 * particles are updated once a frame, before its draws, never between two draws of it.
 *
 * `clothStandIn` is what a skinned pipeline binds where no cloth is set: its layout declares the
 * three textures whatever the draw, and WebGPU binds every declared texture.
 */
import { clothTextureSize, packClothBinding, packClothParticles } from '../../clothBindingData.ts';
import type { ClothBindingData } from '../../clothBindingData.ts';

const USAGE = 0x4 | 0x2; // TEXTURE_BINDING | COPY_DST
const STORAGE_BINDING = 0x8;

function floatTexture(
  device: GPUDevice,
  label: string,
  width: number,
  height: number,
  texels: Float32Array | null,
  storage = false,
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [width, height],
    format: 'rgba32float',
    usage: storage ? USAGE | STORAGE_BINDING : USAGE,
  });
  if (texels !== null) {
    device.queue.writeTexture(
      { texture },
      texels as Float32Array<ArrayBuffer>,
      { bytesPerRow: width * 16, rowsPerImage: height },
      { width, height },
    );
  }
  return texture;
}

/** The three views a skinned bind group takes for its cloth. */
export interface ClothViews {
  readonly binding: GPUTextureView;
  readonly particles: GPUTextureView;
  readonly rest: GPUTextureView;
}

/** A one-texel float texture, as all three views, for every draw with no cloth. */
export function clothStandIn(device: GPUDevice): { texture: GPUTexture; views: ClothViews } {
  const texture = floatTexture(device, 'cloth.standIn', 1, 1, new Float32Array(4));
  const view = texture.createView();
  return { texture, views: { binding: view, particles: view, rest: view } };
}

/** A mesh's binding and its particles at rest. */
export class GpuClothBinding {
  readonly binding: GPUTexture;
  readonly rest: GPUTexture;
  readonly bindingView: GPUTextureView;
  readonly restView: GPUTextureView;
  readonly particles: number;

  constructor(device: GPUDevice, data: ClothBindingData) {
    const size = clothTextureSize(data.weights.length * 2);
    this.binding = floatTexture(
      device,
      'cloth.binding',
      size.width,
      size.height,
      packClothBinding(data),
    );
    this.particles = data.rest.length / 3;
    const rest = clothTextureSize(this.particles);
    const texels = new Float32Array(rest.width * rest.height * 4);
    packClothParticles(data.rest, texels);
    this.rest = floatTexture(device, 'cloth.rest', rest.width, rest.height, texels);
    this.bindingView = this.binding.createView();
    this.restView = this.rest.createView();
  }

  /** Its textures, for the renderer to retire once no draw of this frame can read them. */
  get textures(): readonly GPUTexture[] {
    return [this.binding, this.rest];
  }
}

/**
 * One character's particles: this frame's and the last, in two textures that swap. Written from
 * the CPU with `update`, or — `storage` — by the device solver's publish pass, `publish` then
 * saying which texture it writes.
 */
export class GpuClothParticles {
  readonly count: number;
  /** Texels a row, which the publish pass wraps a particle index by. */
  readonly width: number;
  private readonly height: number;
  private readonly staging: Float32Array<ArrayBuffer>;
  /** Both textures, for the renderer to retire once no draw of this frame can read them. */
  readonly textures: readonly [GPUTexture, GPUTexture];
  private readonly views: [GPUTextureView, GPUTextureView];
  private latest = 0;
  /** The frame each texture was last written for, so a motion knows whether the other is last frame's. */
  private readonly written = [-1, -1];
  private paired: GpuClothBinding | null = null;
  private pairedViews: ClothViews[] = [];

  constructor(device: GPUDevice, count: number, storage = false) {
    this.count = count;
    const size = clothTextureSize(count);
    this.width = size.width;
    this.height = size.height;
    this.staging = new Float32Array(size.width * size.height * 4);
    this.textures = [
      floatTexture(device, 'cloth.particles', size.width, size.height, this.staging, storage),
      floatTexture(device, 'cloth.particles', size.width, size.height, this.staging, storage),
    ];
    this.views = [this.textures[0].createView(), this.textures[1].createView()];
  }

  /** This frame's particles. */
  get current(): GPUTextureView {
    return this.views[this.latest] as GPUTextureView;
  }

  /** Last frame's. */
  get previous(): GPUTextureView {
    return this.views[1 - this.latest] as GPUTextureView;
  }

  /**
   * Where they were last frame, for a motion vector at `frame`: the other texture where it was
   * written the frame before this one's update, and this frame's otherwise — particles not updated
   * this frame did not move, and a first update has no past to measure from.
   */
  previousAt(frame: number): GPUTextureView {
    const fresh =
      this.written[this.latest] === frame && this.written[1 - this.latest] === frame - 1;
    return fresh ? this.previous : this.current;
  }

  /** A texture's view, by index: the publish pass binds both, one at a time. */
  viewOf(k: number): GPUTextureView {
    return this.views[k] as GPUTextureView;
  }

  /**
   * The device is about to write the particles of `frame`: the older texture becomes this frame's,
   * as an `update` makes it, and its index is returned for the pass that writes it.
   */
  publish(frame: number): number {
    this.latest = 1 - this.latest;
    this.written[this.latest] = frame;
    return this.latest;
  }

  /** Write `positions` as the particles of `frame`; last frame's stays. */
  update(device: GPUDevice, positions: Float32Array, frame: number): void {
    if (positions.length !== this.count * 3) {
      throw new Error(
        `cloth: ${this.count} particles and an update of ${positions.length / 3}; a cloth's ` +
          'particle count is fixed when its particles are created',
      );
    }
    packClothParticles(positions, this.staging);
    this.latest = 1 - this.latest;
    this.written[this.latest] = frame;
    device.queue.writeTexture(
      { texture: this.textures[this.latest] as GPUTexture },
      this.staging,
      { bytesPerRow: this.width * 16, rowsPerImage: this.height },
      { width: this.width, height: this.height },
    );
  }

  /**
   * The three views a draw of `binding` with these particles binds, kept so a cached bind group
   * compares equal frame after frame. Two objects, one for each texture that is current.
   */
  viewsWith(binding: GpuClothBinding): ClothViews {
    if (this.paired !== binding) {
      this.paired = binding;
      this.pairedViews = [0, 1].map((k) => ({
        binding: binding.bindingView,
        particles: this.views[k] as GPUTextureView,
        rest: binding.restView,
      }));
    }
    return this.pairedViews[this.latest] as ClothViews;
  }
}

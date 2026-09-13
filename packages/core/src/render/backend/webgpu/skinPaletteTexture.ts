import { paletteTextureWidth, validateSkinPalette } from '../../skinPalette.ts';

/**
 * The joint palette as a one-row `rgba32float` texture, on WebGPU.
 *
 * The twin of the WebGL2 module of this name, and deliberately symmetric with it: one decision in
 * `skinPalette.ts`, two thin binders, per the 2026-08-13 rule.
 *
 * **`rgba32float` is `unfilterable-float` to a bind group layout**, which costs nothing because
 * the shader reads it with `textureLoad` — an integer coordinate and no sampler at all. A layout
 * declaring it filterable would fail validation at pipeline creation, which is the loud failure
 * rather than the quiet one.
 */
/*
 * Spelled out rather than read from the global `GPUTextureUsage`, which is not in the TypeScript
 * lib this package compiles against — `clusterBinner.ts` does the same and for the same reason.
 */
const TEXTURE_USAGE = {
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
} as const;

export class SkinPaletteTexture {
  private texture: GPUTexture | null = null;
  private joints = 0;
  /**
   * The view, cached rather than created per call.
   *
   * `createView` allocates, and a bind group is rebuilt against this per draw — so a fresh view
   * each time is both an allocation in the frame loop and a value that never compares equal,
   * which would defeat any cache keyed on it. Invalidated only when the texture is replaced.
   */
  private cachedView: GPUTextureView | null = null;

  /** Upload a palette, reallocating only when the joint count changes. */
  update(device: GPUDevice, palette: Float32Array): void {
    validateSkinPalette(palette);
    const joints = palette.length / 16;
    const width = paletteTextureWidth(joints);

    if (this.texture === null || this.joints !== joints) {
      this.texture?.destroy();
      this.cachedView = null;
      this.texture = device.createTexture({
        /* Labelled, because `createGpuSurface`'s uncaptured-error lines are only legible when
           every resource carries one. See the 2026-08-14 rule. */
        label: `skin.palette:${joints}`,
        size: { width, height: 1 },
        format: 'rgba32float',
        usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST,
      });
      this.joints = joints;
    }

    device.queue.writeTexture(
      { texture: this.texture },
      palette,
      { bytesPerRow: width * 16 },
      { width, height: 1 },
    );
  }

  view(): GPUTextureView | null {
    if (this.texture === null) return null;
    if (this.cachedView === null) this.cachedView = this.texture.createView();
    return this.cachedView;
  }

  get ready(): boolean {
    return this.texture !== null;
  }

  dispose(): void {
    this.texture?.destroy();
    this.texture = null;
    this.cachedView = null;
    this.joints = 0;
  }
}

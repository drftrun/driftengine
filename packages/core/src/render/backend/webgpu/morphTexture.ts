import { morphTextureRows, morphTextureWidth } from '../../skinPalette.ts';

/**
 * A mesh's morph deltas as an `rgba32float` texture, on WebGPU.
 *
 * The twin of the WebGL2 module of this name, and **`rgba` where that one is `rgb`**: WebGPU has
 * no three-channel float format at all, so the fourth channel is padding the shader ignores. That
 * is a quarter of the texture holding nothing, and it is the format list rather than a choice —
 * naming it here so the difference between the two files is not read as an oversight.
 */
export class MorphTexture {
  private texture: GPUTexture | null = null;
  private cachedView: GPUTextureView | null = null;
  readonly width: number;
  readonly rows: number;
  readonly targetCount: number;

  constructor(device: GPUDevice, deltas: Float32Array, vertices: number, targets: number) {
    this.targetCount = targets;
    this.width = morphTextureWidth(vertices, targets);
    this.rows = morphTextureRows(vertices, targets);

    this.texture = device.createTexture({
      label: `morph.deltas:${targets}x${vertices}`,
      size: { width: this.width, height: this.rows },
      format: 'rgba32float',
      usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST,
    });

    /* Three floats a delta widened to four, and padded to the full rectangle for the reason the
       WebGL2 twin gives: a short last row is what an upload walks off the end of. */
    const padded = new Float32Array(this.width * this.rows * 4);
    const count = Math.min(deltas.length / 3, this.width * this.rows);
    for (let i = 0; i < count; i++) {
      padded[i * 4] = deltas[i * 3] as number;
      padded[i * 4 + 1] = deltas[i * 3 + 1] as number;
      padded[i * 4 + 2] = deltas[i * 3 + 2] as number;
    }
    device.queue.writeTexture(
      { texture: this.texture },
      padded,
      { bytesPerRow: this.width * 16, rowsPerImage: this.rows },
      { width: this.width, height: this.rows },
    );
  }

  view(): GPUTextureView | null {
    if (this.texture === null) return null;
    if (this.cachedView === null) this.cachedView = this.texture.createView();
    return this.cachedView;
  }

  dispose(): void {
    this.texture?.destroy();
    this.texture = null;
    this.cachedView = null;
  }
}

/* Spelled out, because the global is not in the TypeScript lib this package compiles against. */
const TEXTURE_USAGE = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04 } as const;

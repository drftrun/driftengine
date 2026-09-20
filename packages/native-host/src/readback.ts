/**
 * The frame as the engine left it in the canvas, read back to the CPU for the pixel gate.
 *
 * **The canvas texture, not the window**: the window is Dawn's `bgra8unorm-srgb` swap chain, which
 * the present decodes into, and a comparison against it would compare that round trip. The canvas
 * texture carries `COPY_SRC` for exactly this (see `canvas.ts`).
 */

const COPY_DST = 0x08;
const MAP_READ = 0x01;

export interface Frame {
  readonly width: number;
  readonly height: number;
  /** Top row first, four bytes a pixel, in the canvas's own channel order. */
  readonly rgba: Uint8Array;
}

/** Rows are copied at a stride of 256 bytes, which `copyTextureToBuffer` requires. */
export function paddedRow(width: number): number {
  return 256 * Math.ceil((width * 4) / 256);
}

/** The padded rows, packed. */
export function unpad(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const row = paddedRow(width);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    out.set(bytes.subarray(y * row, y * row + width * 4), y * width * 4);
  }
  return out;
}

export async function readFrame(context: GPUCanvasContext): Promise<Frame> {
  const configuration = context.getConfiguration();
  if (configuration === null)
    throw new Error('[driftengine] there is no frame: the canvas was never configured');
  const { device, format } = configuration;
  if (format !== 'rgba8unorm') {
    throw new Error(`[driftengine] the gate reads rgba8unorm frames, and this one is ${format}`);
  }
  const texture = context.getCurrentTexture();
  const { width, height } = texture;
  const buffer = device.createBuffer({
    label: 'native readback',
    size: paddedRow(width) * height,
    usage: COPY_DST | MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: 'native readback' });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: paddedRow(width) },
    { width, height },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ);
  const rgba = unpad(new Uint8Array(buffer.getMappedRange()), width, height);
  buffer.unmap();
  buffer.destroy();
  return { width, height, rgba };
}

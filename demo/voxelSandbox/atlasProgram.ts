/**
 * The block atlas as a decode program, which is how the second pipeline reads an image.
 *
 * **The forward path samples the atlas as a texture; the GPU-driven pipeline samples a program.**
 * An ordinary image is already a program of one instruction — `SAMPLE_BLOCK` over a block with a
 * full chain, which `imageProgram` in `demo/gpuDrivenRig.ts` established — so this is that, plus
 * the three things an atlas needs and a rig's picture did not.
 *
 * - **A cell for every tile, twice its size, with a gutter of its own edge.** A mip chain is what a
 *   large radius needs, and it is also what breaks a bare atlas: `buildBlockAtlas` insets each
 *   tile's UVs by half a texel, which is exactly enough at level 0 and nothing at any level
 *   coarser, so a bilinear sample at a tile's edge reads its neighbour. The first capture of the
 *   port wore a grass-green line along every edge of every block of sand. Each tile sits in the
 *   middle of a 256-texel cell with its edge repeated 64 texels deep all round, which holds it to
 *   itself down to one texel a tile, and a power-of-two cell is what keeps the box-filtered chain
 *   from ever averaging two tiles together. The mesher's UVs are remapped into the cells when a
 *   chunk is streamed; the forward path's atlas and UV table are untouched.
 * - **A power-of-two square with every level down to one texel**, because `decodeTables.ts` puts
 *   every image in one texture array with one square size and refuses a chain that stops short.
 * - **The sRGB curve.** The forward path uploads the atlas as `srgb` and its sampler decodes; a
 *   program reads bytes, so it decodes them itself with one `REMAP_CHANNEL` a colour channel.
 *
 * **Past every cell the square is transparent**, so a cutout material discards anything that
 * strays there. The price of the gutters is memory: twenty-seven tiles are a 2048 square, sixteen
 * megabytes and a third again for the chain.
 */
import { ADDRESS_MODE } from '@driftengine/texture';

import { srgbImage } from '../imageProgram';

import type { GpuDrivenProgram } from '../../packages/core/src/index';

export interface AtlasProgram {
  readonly program: GpuDrivenProgram;
  /** A UV from `buildBlockAtlas`'s table, moved to the same texel of its tile's cell. */
  remap(u: number, v: number): [number, number];
}

/**
 * The atlas's RGBA, top row first as a canvas reads it, as a program and the remap to apply.
 *
 * @param pixels `width * height * 4` bytes, sRGB colour and straight alpha — `getImageData`'s own.
 * @param tile The atlas's cell size, `TILE_PX` in `atlas.ts`. Both sides must be whole tiles.
 */
export function atlasProgram(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  tile: number,
): AtlasProgram {
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `[driftengine] an atlas of ${width} by ${height} is ${width * height * 4} bytes, and ` +
        `${pixels.length} were given`,
    );
  }
  if (width % tile !== 0 || height % tile !== 0) {
    throw new Error(
      `[driftengine] an atlas of ${width} by ${height} is not whole tiles of ${tile}`,
    );
  }
  const cols = width / tile;
  const rows = height / tile;
  const cell = tile * 2;
  const gutter = tile / 2;
  let edge = 1;
  while (edge < cols * cell || edge < rows * cell) edge *= 2;

  /*
   * Zeroed, which is transparent black: past every cell is nothing. Inside a cell each texel reads
   * the tile texel nearest it, so the content is the tile and the gutter is its edge, repeated.
   */
  const level0 = new Uint8Array(edge * edge * 4);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      for (let y = 0; y < cell; y += 1) {
        const sy = row * tile + Math.min(tile - 1, Math.max(0, y - gutter));
        for (let x = 0; x < cell; x += 1) {
          const sx = col * tile + Math.min(tile - 1, Math.max(0, x - gutter));
          const from = (sy * width + sx) * 4;
          const to = ((row * cell + y) * edge + col * cell + x) * 4;
          level0[to] = pixels[from] as number;
          level0[to + 1] = pixels[from + 1] as number;
          level0[to + 2] = pixels[from + 2] as number;
          level0[to + 3] = pixels[from + 3] as number;
        }
      }
    }
  }
  return {
    /* Clamped: the far edge of the square is another cell, not this one repeating. */
    program: srgbImage(level0, edge, ADDRESS_MODE.CENTRE_CLAMP),
    remap(u: number, v: number): [number, number] {
      /*
       * **The tile is found from the texel, not from the UV's nearest edge**, because the mesher's
       * UVs are inset half a texel inside their tile and so never sit on a boundary. Clamped at
       * the atlas's own edge for a UV exactly at one.
       */
      const x = u * width;
      const y = v * height;
      const col = Math.min(cols - 1, Math.max(0, Math.floor(x / tile)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(y / tile)));
      return [
        (col * cell + gutter + (x - col * tile)) / edge,
        (row * cell + gutter + (y - row * tile)) / edge,
      ];
    },
  };
}

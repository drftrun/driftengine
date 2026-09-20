/**
 * Every block face in one texture, and the UV cell each tile occupies.
 *
 * Culled meshing maps each face to exactly one tile, so UVs stay inside a cell and a half-texel
 * inset is enough to stop bleeding. There is no greedy tiling, so no cell is ever sampled across
 * and no tile needs a border.
 *
 * **The texture is made through the renderer, never with `new SurfaceTexture(gl, …)`.** That
 * constructor is WebGL2-only and takes a raw context; `createSurfaceTexture` is on the
 * backend-neutral `RendererApi` and is the only form that survives a WebGPU run.
 *
 * **Composed from each tile's own bytes, not on a canvas.** A 2D canvas holds premultiplied
 * pixels, so a leaf's partly transparent edge went in straight and came out divided and rounded —
 * and rounded differently by the texture upload the forward pipeline samples and by the
 * `getImageData` the GPU-driven one decodes (see `pngTexels.ts`). Decoded, the 7,739 partly
 * transparent texels across the 85 tiles arrive as written on both pipelines, both backends, and
 * a host with no canvas.
 */
import type { LoadTracker, RendererApi, SurfaceTextureHandle } from '../../packages/core/src/index';

import { decodePngTexels } from './pngTexels';
import type { PngTexels } from './pngTexels';

/** A tile's UV cell, already inset by half a texel. */
export interface TileRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface BlockAtlas {
  texture: SurfaceTextureHandle;
  rects: Map<string, TileRect>;
  /** Stands in for a tile that would not load, so an absence is visible rather than silent. */
  fallback: TileRect;
  /**
   * The RGBA the atlas was drawn with, top row first — sRGB colour and straight alpha.
   *
   * **For the GPU-driven path, which cannot read `texture`.** It samples a decode program, and
   * `atlasProgram` builds one from these bytes, which are the same bytes `texture` was made from.
   */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Cell size in the atlas, and the source tiles' own resolution.
 *
 * The reference uses 64 and downsamples Kenney's 128. This keeps the native size, because the
 * sampler cannot be asked for nearest magnification (see `GAPS.md`) and the only lever left
 * against that blur is starting from more texels. Same pixels, four times the atlas, which is
 * nothing at twenty-seven tiles.
 */
export const TILE_PX = 128;

/** The tracker's task id, so the caller can find this load among others. */
export const ATLAS_TASK = 'voxel-atlas';

/** A tile's texels, or null for one that would not load or is not a cell's size. */
async function loadTile(url: string): Promise<PngTexels | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    const tile = await decodePngTexels(new Uint8Array(await response.arrayBuffer()));
    /* Copied into its cell as it is, with nothing to scale it: a tile of another size is absent. */
    return tile.width === TILE_PX && tile.height === TILE_PX ? tile : null;
  } catch {
    return null;
  }
}

/** Straight, as decoded: the upload must neither premultiply nor colour-manage what it is given. */
const AS_WRITTEN = {
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
} as const satisfies ImageBitmapOptions;

/** Opaque magenta, straight RGBA. */
const MISSING = [255, 0, 255, 255] as const;

export async function buildBlockAtlas(
  renderer: RendererApi,
  baseUrl: string,
  tileNames: readonly string[],
  tracker?: LoadTracker,
): Promise<BlockAtlas> {
  const names = [...new Set(tileNames)];
  const cols = Math.ceil(Math.sqrt(names.length));
  const rows = Math.ceil(names.length / cols);
  const atlasW = cols * TILE_PX;
  const atlasH = rows * TILE_PX;

  tracker?.add(ATLAS_TASK, names.length);

  const pixels = new Uint8ClampedArray(atlasW * atlasH * 4);
  const rects = new Map<string, TileRect>();
  const halfU = 0.5 / atlasW;
  const halfV = 0.5 / atlasH;

  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const ox = (i % cols) * TILE_PX;
    const oy = Math.floor(i / cols) * TILE_PX;

    const tile = await loadTile(`${baseUrl}/${name}.png`);
    for (let y = 0; y < TILE_PX; y++) {
      const row = ((oy + y) * atlasW + ox) * 4;
      if (tile !== null) {
        pixels.set(tile.rgba.subarray(y * TILE_PX * 4, (y + 1) * TILE_PX * 4), row);
      } else {
        /* Magenta, so a missing tile is a thing you notice in the first screenshot rather than a
           thing you find out about when somebody asks why the grass is grey. */
        for (let x = 0; x < TILE_PX; x++) pixels.set(MISSING, row + x * 4);
      }
    }
    tracker?.report(ATLAS_TASK, (i + 1) / names.length);

    rects.set(name, {
      u0: ox / atlasW + halfU,
      v0: oy / atlasH + halfV,
      u1: (ox + TILE_PX) / atlasW - halfU,
      v1: (oy + TILE_PX) / atlasH - halfV,
    });
  }

  /* See GAPS.md: the sampler magnifies linearly and cannot be told otherwise, so the atlas carries
     no mip chain to soften it further. */
  const image = await createImageBitmap(new ImageData(pixels, atlasW, atlasH), AS_WRITTEN);
  const texture = renderer.createSurfaceTexture(image, {
    wrap: 'clamp',
    colorSpace: 'srgb',
    mipmap: false,
    anisotropy: 1,
  });
  image.close();
  tracker?.finish(ATLAS_TASK);

  const fallback = rects.values().next().value ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
  return { texture, rects, fallback, pixels, width: atlasW, height: atlasH };
}

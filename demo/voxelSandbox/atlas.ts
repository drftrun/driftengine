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
 */
import type { LoadTracker, RendererApi, SurfaceTextureHandle } from '../../packages/core/src/index';

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
}

/**
 * Cell size in the atlas, and the source tiles' own resolution.
 *
 * The reference uses 64 and downsamples Kenney's 128. This keeps the native size, because the
 * sampler cannot be asked for nearest magnification (see `GAPS.md`) and the only lever left
 * against that blur is starting from more texels. Same pixels, four times the atlas, which is
 * nothing at twenty-seven tiles.
 */
const TILE_PX = 128;

/** The tracker's task id, so the caller can find this load among others. */
export const ATLAS_TASK = 'voxel-atlas';

async function loadBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

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

  const canvas = document.createElement('canvas');
  canvas.width = atlasW;
  canvas.height = atlasH;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('voxel atlas: 2D canvas context unavailable');
  /* See GAPS.md: the sampler magnifies linearly and cannot be told otherwise, so the atlas is
     composed with hard edges and carries no mip chain to soften it further. */
  ctx.imageSmoothingEnabled = false;

  const rects = new Map<string, TileRect>();
  const halfU = 0.5 / atlasW;
  const halfV = 0.5 / atlasH;

  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const ox = (i % cols) * TILE_PX;
    const oy = Math.floor(i / cols) * TILE_PX;

    const bitmap = await loadBitmap(`${baseUrl}/${name}.png`);
    if (bitmap !== null) {
      ctx.drawImage(bitmap, ox, oy, TILE_PX, TILE_PX);
      bitmap.close();
    } else {
      /* Magenta, so a missing tile is a thing you notice in the first screenshot rather than a
         thing you find out about when somebody asks why the grass is grey. */
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(ox, oy, TILE_PX, TILE_PX);
    }
    tracker?.report(ATLAS_TASK, (i + 1) / names.length);

    rects.set(name, {
      u0: ox / atlasW + halfU,
      v0: oy / atlasH + halfV,
      u1: (ox + TILE_PX) / atlasW - halfU,
      v1: (oy + TILE_PX) / atlasH - halfV,
    });
  }

  const texture = renderer.createSurfaceTexture(canvas, {
    wrap: 'clamp',
    colorSpace: 'srgb',
    mipmap: false,
    anisotropy: 1,
  });
  tracker?.finish(ATLAS_TASK);

  const fallback = rects.values().next().value ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
  return { texture, rects, fallback };
}

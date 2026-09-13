/**
 * The hotbar's block tiles, drawn as quads a fixed distance in front of the camera.
 *
 * **Why not on the overlay.** `fillPanel` takes a colour and nothing on the public surface puts a
 * texture into a screen rectangle, so the first version of the hotbar was ten coloured swatches —
 * which is not what the reference shows and not what a player reads. This draws the real atlas
 * tiles instead, as world geometry parented to the camera, which is how a first-person game draws
 * anything held in front of the eye.
 *
 * One mesh, rebuilt only when the selection changes: ten quads with the right UVs, positioned in
 * the camera's own basis each frame.
 */
import {
  type Camera,
  type MeshData,
  type RendererApi,
  type SurfaceMaterial,
  type SurfaceTextureHandle,
} from '../../packages/core/src/index';

import type { BlockAtlas, TileRect } from './atlas';
import { Block, blockDef, HOTBAR } from './blocks';
import { hotbarLayout, slotLeft } from './hotbarLayout';

/**
 * How far in front of the eye the bar sits, in metres. Beyond the scene's 0.15 near plane.
 *
 * The distance is arbitrary on its own: the quads are sized from it and the camera's field of
 * view so that they land on exactly the CSS-pixel rectangles `hotbarLayout` states, whatever the
 * distance is. It only has to clear the near plane and stay closer than anything the player can
 * stand against.
 */
const DISTANCE_M = 0.62;

export class HotbarIcons {
  private readonly renderer: RendererApi;
  private readonly material: SurfaceMaterial<SurfaceTextureHandle>;
  private mesh: ReturnType<RendererApi['createMesh']> | null = null;
  private builtFor = '';
  private readonly model = new Float32Array(16);
  private disposed = false;

  constructor(
    renderer: RendererApi,
    private readonly atlas: BlockAtlas,
  ) {
    this.renderer = renderer;
    /*
     * **Unlit and unfogged, which the standard path does have.** An earlier note here said it did
     * not, and that was a misreading: `TranslucentMeshOptions` carries `lit` and `fog`, and
     * `lit: false` is documented as drawing "exactly its own vertex colour times its own texture,
     * with no ambient, sun, point lights, specular, reflectivity, grain or emissive touching it".
     * That is precisely what a HUD tile wants.
     *
     * Drawn lit, the bar took the world's lighting: the tiles came out far darker than the atlas
     * they were cut from, and they changed brightness with the time of day and with which way the
     * player faced, because the quads are world geometry in front of the eye and their normals
     * turn with the camera.
     */
    this.material = { albedo: atlas.texture, roughnessScale: 1, metallicScale: 0 };
  }

  /**
   * Draw the bar in the camera's basis.
   *
   * The quads are built in a local frame — x right, y up, z into the screen — and the model
   * matrix is the camera's own orientation and position, so the bar sits in front of the eye
   * however the player is looking.
   */
  draw(camera: Camera, selected: number): void {
    const width = this.renderer.cssWidth;
    const height = this.renderer.cssHeight;
    if (width <= 0 || height <= 0) return;
    /*
     * The quads are sized from the viewport as well as the selection, because their whole job is
     * to land on the CSS-pixel rectangles the HUD drew. A resize moves those rectangles.
     */
    /*
     * The view plane's half-extents at the bar's distance, read off the projection rather than
     * rebuilt from the field of view.
     *
     * `mat4.perspective` writes `1/tan(fovY/2)` at `[5]` and that over the aspect at `[0]`, so
     * these two divisions are the exact inverse of whatever the camera was given — including the
     * aspect, which comes from the *drawing buffer* and is not the CSS aspect when the canvas is
     * scaled. Computing the extents from `fovYDeg` and `cssWidth / cssHeight` instead put the
     * tiles a slot's width off centre, growing with distance from the middle of the bar.
     */
    const halfH = DISTANCE_M / camera.projection[5]!;
    const halfW = DISTANCE_M / camera.projection[0]!;
    const key = `${selected}:${width}x${height}:${halfW.toFixed(5)}:${halfH.toFixed(5)}`;
    if (key !== this.builtFor) this.rebuild(selected, width, height, halfW, halfH, key);
    if (this.mesh === null) return;

    const yaw = camera.yaw;
    const pitch = camera.pitch;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);

    /* Right, up and forward, exactly as `Camera` builds them, so the bar cannot drift from the
       view it is supposed to be attached to. */
    const rx = cy;
    const ry = 0;
    const rz = sy;
    const fx = sy * cp;
    const fy = sp;
    const fz = -cy * cp;
    /* Up is forward × right, which for this basis is the tilted vertical. */
    const ux = -sy * sp;
    const uy = cp;
    const uz = cy * sp;

    const m = this.model;
    m[0] = rx;
    m[1] = ry;
    m[2] = rz;
    m[3] = 0;
    m[4] = ux;
    m[5] = uy;
    m[6] = uz;
    m[7] = 0;
    m[8] = fx;
    m[9] = fy;
    m[10] = fz;
    m[11] = 0;
    m[12] = camera.position[0];
    m[13] = camera.position[1];
    m[14] = camera.position[2];
    m[15] = 1;

    this.renderer.setMaterial(this.material);
    /* Opaque, and flat: `lit: false` is what keeps a tile the colour the atlas holds. */
    this.renderer.drawTranslucentMesh(this.mesh, m, 1, { lit: false, fog: false });
    this.renderer.setMaterial(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mesh !== null) this.renderer.disposeMesh(this.mesh);
    this.mesh = null;
  }

  /** Only when the selection or the viewport moves: ten quads is cheap, and rebuilding is not. */
  private rebuild(
    selected: number,
    width: number,
    height: number,
    halfW: number,
    halfH: number,
    key: string,
  ): void {
    if (this.mesh !== null) this.renderer.disposeMesh(this.mesh);
    this.mesh = this.renderer.createMesh(this.build(selected, width, height, halfW, halfH));
    this.builtFor = key;
  }

  /**
   * Ten quads placed so they project onto the HUD's own slot rectangles.
   *
   * **The bar is laid out in CSS pixels and drawn in metres, and the conversion is exact.** A
   * pixel becomes a normalised device coordinate, and that scales by the view plane's half
   * extents at the bar's distance — which `draw` reads off the projection itself. No fitting and
   * no constants to tune. The previous version placed the quads from metre constants picked by
   * eye, a tile size and a gap and a drop, and they agreed with the HUD at no viewport size at
   * all: the tiles sat in a row above the bar rather than inside it.
   */
  private build(
    selected: number,
    width: number,
    height: number,
    halfW: number,
    halfH: number,
  ): MeshData {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const layout = hotbarLayout(width, height);
    /* A CSS pixel to a point on the view plane: NDC first, then scaled by the half-extents. */
    const localX = (px: number): number => ((px / width) * 2 - 1) * halfW;
    const localY = (py: number): number => (1 - (py / height) * 2) * halfH;

    for (let i = 0; i < HOTBAR.length; i++) {
      const id = HOTBAR[i] ?? Block.AIR;
      const def = blockDef(id);
      const rect = this.atlas.rects.get(def?.faces.side ?? '') ?? this.atlas.fallback;

      const left = slotLeft(layout, i);
      const x0 = localX(left);
      const x1 = localX(left + layout.slot);
      const y0 = localY(layout.top);
      const y1 = localY(layout.top + layout.slot);

      /*
       * Every tile at full strength, and the selection marked by the ring the HUD fills behind
       * it — which is what the reference does. Dimming the unselected ones was standing in for a
       * ring that could not be seen, because the tiles were nowhere near it.
       */
      const tint = i === selected ? 1 : 0.86;

      const base = positions.length / 3;
      /* Screen order: top-left, top-right, bottom-right, bottom-left. */
      const corners: readonly (readonly [number, number])[] = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      /* `v0` is the top of the tile, so it pairs with the top of the slot. */
      const uv: readonly (readonly [number, number])[] = [
        [rect.u0, rect.v0],
        [rect.u1, rect.v0],
        [rect.u1, rect.v1],
        [rect.u0, rect.v1],
      ];
      for (let c = 0; c < 4; c++) {
        positions.push(corners[c]![0], corners[c]![1], DISTANCE_M);
        /* Facing the eye, which is -z in this local frame. */
        normals.push(0, 0, -1);
        colors.push(tint, tint, tint);
        uvs.push(uv[c]![0], uv[c]![1]);
      }
      /*
       * **Wound against the local frame, because the model matrix is a mirror.**
       *
       * The basis below is `(right, up, forward)`, and for this camera `forward` is
       * `-(right x up)` — a determinant of -1. So a triangle that is counter-clockwise in this
       * local frame reaches the rasteriser clockwise and is culled as a back face, and the quad
       * has to be wound the other way to survive. Stated because it looks like a mistake: the
       * corners above run in screen order and the indices below run against them.
       */
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      colors: new Float32Array(colors),
      /* Zero: an unlit draw never reads emissive, and the bar no longer goes out with the sun. */
      emissive: new Float32Array(positions.length / 3),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
    };
  }
}

/** Which tile a hotbar slot shows: the side face, as the reference does. */
export function slotTile(id: Block, atlas: BlockAtlas): TileRect {
  return atlas.rects.get(blockDef(id)?.faces.side ?? '') ?? atlas.fallback;
}

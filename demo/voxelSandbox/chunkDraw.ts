/**
 * What gets drawn this frame, given a tree of chunks and a camera.
 *
 * Split from `chunkRenderer.ts` because "which chunks should exist" and "which of them is on
 * screen" are two questions with two lifetimes: the first changes when the player walks, the
 * second every frame. Keeping them apart also keeps the per-frame path in one readable piece.
 *
 * **Allocates nothing.** Every buffer here is built once and refilled, because this runs sixty
 * times a second.
 */
import {
  createFrustum,
  createVisitResult,
  frustumFromViewProjection,
  visitVisible,
  type Camera,
  type Frustum,
  type MeshHandle,
  type RendererApi,
  type SceneNode,
  type SurfaceMaterial,
  type SurfaceTextureHandle,
  type VisitResult,
} from '../../packages/core/src/index';

import type { BlockAtlas } from './atlas';
import type { RenderMode } from './blocks';

const MODES = ['opaque', 'cutout', 'blend'] as const;

/** What the reference draws its water and glass at. */
const BLEND_OPACITY = 0.72;

export class ChunkDraw {
  private readonly renderer: RendererApi;
  private readonly frustum: Frustum = createFrustum();
  private readonly visit: VisitResult = createVisitResult();
  private readonly byNode = new Map<SceneNode, { mode: RenderMode; mesh: MeshHandle }>();

  private readonly visible: Record<RenderMode, MeshHandle[]> = {
    opaque: [],
    cutout: [],
    blend: [],
  };
  private readonly visibleNodes: Record<RenderMode, SceneNode[]> = {
    opaque: [],
    cutout: [],
    blend: [],
  };

  private readonly materials: Record<RenderMode, SurfaceMaterial<SurfaceTextureHandle>>;

  constructor(renderer: RendererApi, atlas: BlockAtlas) {
    this.renderer = renderer;
    this.materials = {
      opaque: { albedo: atlas.texture, roughnessScale: 1, metallicScale: 0 },
      /* Leaves are a cutout: anything below this is discarded rather than blended, which is
         what stops a canopy from having to sort against itself. */
      cutout: { albedo: atlas.texture, cutout: 0.5, roughnessScale: 1, metallicScale: 0 },
      blend: { albedo: atlas.texture, roughnessScale: 0.1, metallicScale: 0 },
    };
  }

  /** Say that this node carries this mesh, so the walk knows what to draw when it reaches it. */
  register(node: SceneNode, mode: RenderMode, mesh: MeshHandle): void {
    this.byNode.set(node, { mode, mesh });
  }

  forget(node: SceneNode): void {
    this.byNode.delete(node);
  }

  /**
   * One material bind per render mode, then every visible chunk mesh that uses it.
   *
   * `visitVisible` deliberately does not draw — order is the caller's business — so the walk
   * collects and the draws happen per mode afterwards. Three binds a frame however many chunks
   * there are, and the ones behind the camera cost one sphere test each.
   */
  draw(root: SceneNode, camera: Camera): VisitResult {
    frustumFromViewProjection(camera.viewProjection, this.frustum);
    for (const mode of MODES) {
      this.visible[mode].length = 0;
      this.visibleNodes[mode].length = 0;
    }

    visitVisible(
      root,
      this.frustum,
      (node) => {
        const part = this.byNode.get(node);
        if (part === undefined) return;
        this.visible[part.mode].push(part.mesh);
        this.visibleNodes[part.mode].push(node);
      },
      this.visit,
    );

    for (const mode of MODES) {
      const meshes = this.visible[mode];
      if (meshes.length === 0) continue;
      this.renderer.setMaterial(this.materials[mode]);
      const nodes = this.visibleNodes[mode];
      if (mode === 'blend') {
        /*
         * **Water and glass are translucent, and `drawMesh` is the opaque path.** Drawing them
         * with it made a sea you could not see into and a pane of glass you could not see
         * through — the surface was there, and it was solid. The reference blends its water at
         * 0.72; this is the same number through the verb that actually blends.
         */
        for (let i = 0; i < meshes.length; i++) {
          this.renderer.drawTranslucentMesh(meshes[i]!, nodes[i]!.worldMatrix, BLEND_OPACITY);
        }
      } else {
        for (let i = 0; i < meshes.length; i++) {
          this.renderer.drawMesh(meshes[i]!, nodes[i]!.worldMatrix);
        }
      }
    }
    this.renderer.setMaterial(null);
    return this.visit;
  }
}

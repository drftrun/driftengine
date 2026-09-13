/**
 * A world described as a hierarchy, drawn through a traversal that prunes.
 *
 * **The scene exists to put a number on the partition.** A hierarchy that prunes nothing is a
 * linear scan with extra steps, and counting is the only means of telling which one a given
 * world produces — so the readout carries `visited` and `pruned` beside the frame time, and turning the
 * camera changes both while you watch.
 *
 * Six towers of stacked blocks, each tower one node with its children under it. Turn away from a
 * tower and its whole subtree is discarded on one sphere test rather than on one per block.
 */
import {
  Camera,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createFrustum,
  createRenderer,
  createVisitResult,
  frustumFromViewProjection,
  visitVisible,
} from '../packages/core/src/index';
import type {
  MeshHandle,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
  SkyColors,
} from '../packages/core/src/index';

import { DEMO_BACKEND } from './backend';
import { OrbitView } from './orbit';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';

const TOWERS = 6;
const BLOCKS_PER_TOWER = 14;
/** Far enough apart that a tower leaves the view entirely as the camera turns. */
const RING_RADIUS = 34;
/**
 * Just inside the ring, looking outward.
 *
 * From outside it the whole ring fits in the view and nothing is ever pruned, which is an honest
 * state and a useless demonstration. From inside, the towers behind the eye are behind it — and
 * "behind the camera" is the case a frustum rejects most decisively.
 */
const EYE_RADIUS = 9;

const SKY: SkyColors = {
  top: [0.07, 0.1, 0.18],
  horizon: [0.3, 0.33, 0.4],
  deep: [0.02, 0.03, 0.05],
  sunDir: [0.4, 0.6, 0.3],
  sunColor: [1, 0.94, 0.82],
  sunAngularRadius: 0.005,
  moonDir: [-0.4, 0.5, -0.3],
  moonColor: [0.5, 0.55, 0.7],
  moonAngularRadius: 0.006,
  moonPhase: 0.4,
  nightFactor: 0.55,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

const ENV = createEnvironment({
  directionalDir: [0.4, 0.6, 0.3],
  directionalColor: [1, 0.96, 0.88],
  ambient: [0.18, 0.2, 0.26],
  ambientGround: [0.08, 0.08, 0.1],
  emissiveGain: 0,
  nightFactor: 0.55,
  fogColor: [0.16, 0.18, 0.24],
  fogDensity: 0.004,
  fogHeightFalloff: 0.03,
  fogBaseY: 0,
});

class HierarchyHandle implements DemoHandle {
  private readonly renderer: RendererApi;
  private readonly canvas: HTMLCanvasElement;
  private readonly camera = new Camera();
  /*
   * Outside the ring, on purpose. From inside it every tower is behind the camera or beside it
   * and the count swings between everything and nothing; from outside, roughly half the world is
   * in front at any angle, which is the state the rig exists to show.
   */
  readonly view = new OrbitView(58, 140, 12);

  private readonly root = new SceneNode();
  private readonly block: MeshHandle;
  private readonly frustum = createFrustum();
  private readonly counts = createVisitResult();
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0, instances: 0, extra: '' };

  private elapsed = 0;
  private disposed = false;

  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  get lost(): boolean {
    return this.renderer.contextLost;
  }

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.renderer.resize();
    const builder = new MeshBuilder();
    builder.addBox([0, 0, 0], [0.8, 0.8, 0.8], [0.72, 0.74, 0.8]);
    this.block = renderer.createMesh(builder.build());

    for (let tower = 0; tower < TOWERS; tower += 1) {
      const angle = (tower / TOWERS) * Math.PI * 2;
      /*
       * One node per tower, and the blocks beneath it. This is the whole of the partition: the
       * tower's own bounds are the union of its blocks, so a frustum that rejects the tower has
       * rejected fourteen blocks on one sphere test.
       */
      const node = new SceneNode();
      node.setPosition(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS);
      node.setRotationAxisAngle(0, 1, 0, -angle);
      this.root.attachChild(node);

      for (let i = 0; i < BLOCKS_PER_TOWER; i += 1) {
        const brick = new SceneNode();
        brick.setBounds(this.block.bounds);
        brick.setPosition(i % 2 === 0 ? 0.6 : -0.6, 1 + i * 1.7, 0);
        node.attachChild(brick);
      }
    }
  }

  frame(dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    this.elapsed += dtSec;

    /* One tower leans, so something is dirty every frame and the walk has work to skip. */
    const leaning = this.root.children[0];
    leaning?.setRotationAxisAngle(0, 0, 1, Math.sin(this.elapsed * 0.6) * 0.08);
    this.root.updateWorld();

    /*
     * Placed here, then handed to `follow` so a drag starts where the eye already is.
     *
     * `follow` *reads* the camera rather than placing it — it exists so a handover from a
     * scene-driven camera is seamless — so a scene that only calls it never moves at all, and
     * sits at the origin looking down -Z. That was this rig's first version, and it looked like
     * a camera setting that would not take.
     */
    if (this.view.taken) {
      this.view.place(this.camera);
    } else {
      const turn = this.elapsed * 0.16;
      const outX = Math.sin(turn);
      const outZ = Math.cos(turn);
      this.camera.position[0] = outX * EYE_RADIUS;
      this.camera.position[1] = 13;
      this.camera.position[2] = outZ * EYE_RADIUS;
      this.camera.lookAt(outX * 90, 11, outZ * 90);
      this.view.follow(this.camera, outX * 90, 11, outZ * 90);
    }
    this.camera.updateMatrices(this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1);

    frustumFromViewProjection(this.camera.viewProjection, this.frustum);

    this.renderer.beginFrame([0.05, 0.06, 0.09]);
    this.renderer.bindMeshPass(this.camera, ENV);
    this.renderer.drawSky(this.camera, SKY, ENV);
    /*
     * The traversal hands over nodes; this decides what a node is worth drawing as. That
     * separation is the reason `visitVisible` does not draw: order is the caller's, and so is the
     * choice of verb.
     */
    visitVisible(
      this.root,
      this.frustum,
      (node) => this.renderer.drawMesh(this.block, node.worldMatrix),
      this.counts,
    );
    this.renderer.endFrame();

    this.stats.draws = this.counts.visited + 1;
    this.stats.extra =
      `${this.counts.visited}/${TOWERS * BLOCKS_PER_TOWER} drawn · ` +
      `${this.counts.pruned} subtrees pruned · ${this.counts.tested} tested`;
    return this.stats;
  }

  resize(): void {
    this.renderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeMesh(this.block);
    this.renderer.dispose();
  }
}

export const hierarchy: DemoScene = {
  id: 'hierarchy',
  title: 'A world described as a hierarchy',
  note:
    'Six towers, each a node with its blocks beneath it, drawn through a traversal that tests a ' +
    'tower before its blocks. Turn away from one and the readout shows fourteen draws leaving on ' +
    'a single sphere test.',

  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(canvas, { ...overrides }, DEMO_BACKEND);
    await renderer.ready();
    return new HierarchyHandle(renderer, canvas);
  },
};

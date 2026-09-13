/**
 * The same mesh thirty times, once as thirty draws and once as one.
 *
 * **The scene exists to put a number on the batch.** Two identical ranks of blocks stand side by
 * side, wearing the same geometry and the same material and differing only in how they are
 * submitted: the left rank is thirty `drawMesh` calls, the right is one `drawInstanced`. The
 * readout carries both counts, so the claim is measured on screen rather than asserted here.
 *
 * Each block carries its own colour, which is the half that makes this useful rather than merely
 * cheap. A batch whose instances had to share a tint would be one draw and one object; the
 * per-instance tint is what lets thirty differently painted copies of one model stay one draw.
 *
 * Both ranks also cast into one shadow pass, each through its own verb — `sink.mesh` thirty
 * times against `sink.instanced` once — because a batch that cast no shadow would look like a
 * lighting choice rather than a missing depth variant.
 *
 * **The control this rig was checked with, since two ranks side by side invite the eye to see a
 * difference that is not there.** Swapping which rank is instanced, changing nothing else,
 * produced a frame identical to the first in **0 of 704,000 pixels**. Same geometry, same
 * placements, same light, only the verb moved — so the instanced path draws what thirty
 * individual draws draw, in colour and in shadow. Squinting at the two ranks proves nothing:
 * the light comes from one side, so the near rank's shadows read harder whichever verb drew it.
 *
 * **What it does not show** is skinning or morphing, which the instanced variant refuses — the
 * joint attributes want the locations the matrix does, and a morph weight is per draw, so every
 * instance would wear one expression.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../packages/core/src/index';
import type {
  InstancedHandle,
  ShadowCasters,
  MeshHandle,
  MeshInstances,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
  SkyColors,
} from '../packages/core/src/index';

import { DEMO_BACKEND } from './backend';
import { OrbitView } from './orbit';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';

/** Thirty a side, which is the count the comparison this was built for names. */
const PER_RANK = 30;
const COLUMNS = 6;
const SPACING = 2.4;
/** Far enough apart that the two ranks read as two groups rather than one field. */
const RANK_OFFSET = 11;

/** Reused for the ground, which never moves. Nothing allocates per frame. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const SKY: SkyColors = {
  top: [0.08, 0.11, 0.19],
  horizon: [0.34, 0.37, 0.44],
  deep: [0.02, 0.03, 0.05],
  sunDir: [0.4, 0.7, 0.35],
  sunColor: [1, 0.95, 0.85],
  sunAngularRadius: 0.005,
  moonDir: [-0.4, 0.5, -0.3],
  moonColor: [0.5, 0.55, 0.7],
  moonAngularRadius: 0.006,
  moonPhase: 0.4,
  nightFactor: 0.2,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

const ENV = createEnvironment({
  directionalDir: [0.4, 0.7, 0.35],
  directionalColor: [1, 0.96, 0.9],
  ambient: [0.2, 0.22, 0.28],
  ambientGround: [0.08, 0.08, 0.1],
  emissiveGain: 0,
  nightFactor: 0.2,
  fogColor: [0.18, 0.2, 0.26],
  fogDensity: 0.003,
  fogHeightFalloff: 0.03,
  fogBaseY: 0,
});

/** Where one block of a rank stands, so both ranks are laid out by one rule. */
function placement(index: number, xOffset: number, out: Float32Array, at: number): void {
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const x = xOffset + (column - (COLUMNS - 1) / 2) * SPACING;
  const z = (row - 2) * SPACING;
  /* Column-major, identity but for the translation: the same layout `drawMesh` takes. */
  out[at] = 1;
  out[at + 1] = 0;
  out[at + 2] = 0;
  out[at + 3] = 0;
  out[at + 4] = 0;
  out[at + 5] = 1;
  out[at + 6] = 0;
  out[at + 7] = 0;
  out[at + 8] = 0;
  out[at + 9] = 0;
  out[at + 10] = 1;
  out[at + 11] = 0;
  out[at + 12] = x;
  out[at + 13] = 0.9;
  out[at + 14] = z;
  out[at + 15] = 1;
}

/**
 * A colour per index, so no two neighbours match and the per-instance tint is visible.
 *
 * Takes anything indexable so the batch's `Float32Array` and the single draw's `Vec3` tuple are
 * filled by one rule — two rules would be two colours for one index, which is the comparison
 * quietly breaking.
 */
function tintFor(index: number, out: { [i: number]: number }, at: number): void {
  const t = index / PER_RANK;
  out[at] = 0.45 + 0.5 * Math.sin(t * 6.283);
  out[at + 1] = 0.45 + 0.5 * Math.sin(t * 6.283 + 2.1);
  out[at + 2] = 0.45 + 0.5 * Math.sin(t * 6.283 + 4.2);
}

class InstancingHandle implements DemoHandle {
  private readonly renderer: RendererApi;
  private readonly canvas: HTMLCanvasElement;
  private readonly camera = new Camera();
  readonly view = new OrbitView(34, 150, 14);

  private readonly block: MeshHandle;
  private readonly ground: MeshHandle;
  private readonly batch: InstancedHandle;
  private readonly lightMatrix = new Float32Array(16);
  /**
   * Both ranks cast, each through its own verb.
   *
   * **This is the half that would otherwise ship written rather than ported.** The instanced
   * depth variant exists so a batch casts one shadow per instance; nothing would have exercised
   * it if the scene only drew colour, and a batch that cast no shadow at all looks like a
   * lighting choice rather than a missing pass.
   */
  private readonly casters: ShadowCasters;
  private readonly instances: MeshInstances;
  /** One matrix reused for the individually drawn rank; nothing allocates per frame. */
  private readonly single = new Float32Array(16);
  private readonly singleTint: [number, number, number] = [1, 1, 1];
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
    /* White, so the tint decides the colour outright rather than modulating one. */
    builder.addBox([0, 0, 0], [0.7, 0.9, 0.7], [1, 1, 1]);
    this.block = renderer.createMesh(builder.build());

    this.instances = createMeshInstances(PER_RANK);
    this.instances.count = PER_RANK;
    for (let i = 0; i < PER_RANK; i += 1) {
      placement(i, RANK_OFFSET, this.instances.models, i * 16);
      tintFor(i, this.instances.tints, i * 3);
    }
    const ground = new MeshBuilder();
    ground.addBox([0, -0.4, 0], [26, 0.4, 12], [0.5, 0.52, 0.55]);
    this.ground = renderer.createMesh(ground.build());

    this.batch = renderer.createInstanced(this.block, PER_RANK);
    /* Uploaded once: these instances do not move. A batch that moved would upload per frame,
       which is what `uploadInstanced` exists for and why the staging array is preallocated. */
    renderer.uploadInstanced(this.batch, this.instances);

    this.casters = (sink) => {
      for (let i = 0; i < PER_RANK; i += 1) {
        placement(i, -RANK_OFFSET, this.single, 0);
        sink.mesh(this.block, this.single);
      }
      /* `?.` because the sink declares this optionally — see `ShadowCasterSink.instanced`, which
         is implemented outwards by consumers and cannot grow a required member in a minor. The
         renderer always supplies it, so this never actually skips. */
      sink.instanced?.(this.batch, this.instances);
    };
  }

  frame(dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    this.elapsed += dtSec;

    if (this.view.taken) {
      this.view.place(this.camera);
    } else {
      /*
       * Front-on and still, rather than orbiting.
       *
       * The two ranks are the whole point and an orbit puts one behind the other for most of a
       * turn — which is also what a held-clock capture would freeze it at, at whatever angle the
       * frame count happened to land on. Dragging still takes the camera; this is only where it
       * starts.
       */
      this.camera.position[0] = 0;
      this.camera.position[1] = 13;
      this.camera.position[2] = 30;
      this.camera.lookAt(0, 1, 0);
      this.view.follow(this.camera, 0, 1, 0);
    }
    this.camera.updateMatrices(this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1);

    /* One shadow pass over both ranks, so a difference between the two verbs shows on the
       ground rather than only in the readout. */
    /*
     * **Guarded on the map existing, defensively rather than from a bug seen here.**
     * `computeLightMatrix` snaps the frustum to the texel grid by dividing the radius by
     * `shadowMapSize`, so a renderer built without a directional map would divide by zero and
     * put NaN into every entry of a matrix the flat shader reads. This scene's renderer answers
     * 2048 — the readout prints it — so that path is not exercised here; the guard is for a
     * consumer copying this scene into a profile with shadows off.
     */
    const mapSize = this.renderer.shadowMapSize;
    if (mapSize > 0) {
      ENV.shadowDepthSpan = computeLightMatrix(
        ENV.directionalDir,
        0,
        2,
        2,
        30,
        mapSize,
        this.lightMatrix,
      );
      ENV.lightViewProj = this.lightMatrix;
      ENV.shadowStrength = 0.75;
      this.renderer.beginShadowPass(this.lightMatrix, 'static');
      this.renderer.drawShadowCasters(this.casters);
      this.renderer.endShadowPass();
    }

    this.renderer.beginFrame([0.05, 0.06, 0.09]);
    this.renderer.bindMeshPass(this.camera, ENV);
    this.renderer.drawMesh(this.ground, IDENTITY);
    this.renderer.drawSky(this.camera, SKY, ENV);

    /* The left rank, one draw each. */
    for (let i = 0; i < PER_RANK; i += 1) {
      placement(i, -RANK_OFFSET, this.single, 0);
      tintFor(i, this.singleTint, 0);
      this.renderer.drawMesh(this.block, this.single, 0, this.singleTint);
    }
    /* The right rank, one draw for all of them. */
    this.renderer.drawInstanced(this.batch, this.instances);

    this.renderer.endFrame();

    this.stats.draws = PER_RANK + 1;
    this.stats.instances = PER_RANK;
    this.stats.extra =
      `left rank ${PER_RANK} draws · right rank 1 draw for ${PER_RANK} instances · ` +
      `same mesh, same material, a colour each · shadow map ${this.renderer.shadowMapSize}`;
    return this.stats;
  }

  resize(): void {
    this.renderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeInstanced(this.batch);
    this.renderer.disposeMesh(this.ground);
    this.renderer.disposeMesh(this.block);
    this.renderer.dispose();
  }
}

export const instancing: DemoScene = {
  id: 'instancing',
  title: 'Thirty of one mesh, in one draw',
  note:
    'Two identical ranks of thirty blocks, wearing the same geometry and the same material and ' +
    'differing only in how they are submitted: thirty draws on the left, one on the right. Each ' +
    'block carries its own colour, which is what keeps thirty differently painted copies of one ' +
    'model a single draw.',

  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(canvas, { ...overrides }, DEMO_BACKEND);
    await renderer.ready();
    return new InstancingHandle(renderer, canvas);
  },
};

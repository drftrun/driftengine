/**
 * A room with a fire in it and a wall of smoke between the fire and everything else.
 *
 * **A rig for one question, and the question is what an absence costs.** Track P's design refuses
 * radiative transfer through participating media — smoke that absorbs the fire's radiation and
 * re-emits it — and records what would reverse that: *"Measured evidence that a large smoke-filled
 * scene reads wrong."* Nobody had produced that evidence in either direction, so the refusal
 * rested on an assumption. This is the scene the evidence is taken from.
 *
 * **It is built as a control rather than as a picture.** `AGENTS.md`'s rule is that a negative needs
 * a positive control and the control has to separate the two states under test — and the trap it
 * names is a comparison that cannot tell them apart. So the geometry is arranged so that the one
 * thing that changes between two captures is *whether there is smoke between the fire and the lit
 * surface*, and nothing else moves at all:
 *
 * - The **fire** sits at one end, as a point light with a physical radius and an additive plume.
 * - The **screen** is a plain wall at the other end, facing the fire, and is the surface measured.
 * - The **smoke** stands between them as a bank of alpha plumes, off screen to the left of the
 *   camera, so it occludes the *light path* without occluding the *view path*. That is the whole
 *   design: a capture pair with the smoke on and off differs on the screen only if the smoke did
 *   something to the light crossing it.
 * - The camera never moves, the fire never moves, and the clock is held by the harness.
 *
 * **`?smoke=0` removes the smoke and nothing else.** The plumes are not drawn and no other call
 * changes, which is the toggle `AGENTS.md` asks for: turn the one thing under test on and off.
 *
 * **A draft, and it stays one.** It argues about a refusal rather than showing what the engine can
 * do, which is the same reason `contributedPass` and `hierarchy` are drafts. Publishing an
 * instrument on a page that argues for the engine is putting the wrong thing in front of a reader.
 */
import {
  Camera,
  MeshBuilder,
  ParticlePool,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectPointLights,
} from '../packages/core/src/index';
import type {
  MeshHandle,
  ParticleHandle,
  PlumePlacement,
  PointLightSource,
  PlumeHandle,
  RenderBackend,
  RendererApi,
  RenderQualityOptions,
  SkyColors,
} from '../packages/core/src/index';

import { DEMO_BACKEND } from './backend';
import { OrbitView } from './orbit';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';

/** Where the fire stands, and where the screen it lights stands. */
const FIRE_Z = 9;
const SCREEN_Z = -9;
/** The smoke bank sits between them, nearer the fire, where a real plume would be. */
const SMOKE_Z = 4.5;

/** The room never moves, so one matrix serves it. The shape every other scene here uses. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const ROOM_HALF = 11;
const ROOM_HEIGHT = 8;

/**
 * Night, so the fire is the only thing lighting the screen.
 *
 * **A daylit room would have answered the wrong question.** The measurement is what the fire's
 * radiation does crossing the smoke, and a sun contributing most of the screen's
 * brightness would bury the difference under something the smoke was never between.
 */
const SKY: SkyColors = {
  top: [0.01, 0.012, 0.02],
  horizon: [0.03, 0.032, 0.04],
  deep: [0.004, 0.005, 0.01],
  sunDir: [0.3, -0.8, 0.2],
  sunColor: [0.02, 0.02, 0.03],
  sunAngularRadius: 0.005,
  moonDir: [-0.3, 0.5, -0.4],
  moonColor: [0.1, 0.11, 0.16],
  moonAngularRadius: 0.006,
  moonPhase: 0.2,
  nightFactor: 1,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

/**
 * Fog off, deliberately, and it is the second thing that would have hidden the answer.
 *
 * Height fog is the engine's *other* participating medium, and it is a screen-space `mix` toward a
 * constant rather than anything the fire lights. Leaving it on would put a haze over the screen
 * that changes with distance and not with the fire, which is exactly the confusion this rig exists
 * to avoid.
 */
const ENV = createEnvironment({
  directionalDir: [0.3, -0.8, 0.2],
  directionalColor: [0.02, 0.02, 0.03],
  ambient: [0.012, 0.013, 0.018],
  ambientGround: [0.006, 0.006, 0.008],
  emissiveGain: 1,
  nightFactor: 1,
  fogColor: [0.02, 0.02, 0.028],
  fogDensity: 0,
  fogHeightFalloff: 0,
  fogBaseY: 0,
});

/** The fire, as a light with a physical size. One source, so nothing else can be blamed. */
const FIRE_LIGHT: PointLightSource = {
  x: 0,
  y: 1.4,
  z: FIRE_Z,
  r: 1.0,
  g: 0.52,
  b: 0.2,
  radius: 34,
  /* Steady. A flicker would put a difference between two captures that is not the smoke. */
  flicker: 0,
  shadowNear: 0.2,
  sourceRadius: 0.5,
};

const FIRE_PLUMES: readonly PlumePlacement[] = [
  { x: 0, y: 0.2, z: FIRE_Z, width: 0.9, height: 2.6 },
];

/**
 * The smoke bank: a wall of overlapping plumes across the light path.
 *
 * **Ninety-six of them, and the count is the experiment rather than a taste.** `§26`'s condition
 * names a *large smoke-filled* scene, and one thin column is the case where nobody would expect to
 * see anything. The smoke fragment shader multiplies its density by **0.13**, so a single quad is
 * nearly transparent and a bank has to be built out of depth: twelve columns across the width the
 * fire lights, eight ranks a metre apart, so a line of sight through it crosses eight quads and the
 * room is genuinely full rather than veiled.
 */
const SMOKE_PLUMES: readonly PlumePlacement[] = Array.from({ length: 96 }, (_, i) => {
  const column = i % 12;
  const row = (i / 12) | 0;
  return {
    x: -10 + column * 1.8,
    y: 0.2,
    /* Eight ranks a metre apart, so a line of sight crosses eight quads rather than one. */
    z: SMOKE_Z + (row - 3.5) * 1,
    width: 2.4,
    height: 8,
  };
});

/**
 * How many particles the particle bank holds, and why there is a second bank at all.
 *
 * **The engine draws smoke two ways and they do not behave alike.** `drawPlumes(material: 'smoke')`
 * is a billboard shader with no light term in it anywhere; `drawParticles(material: 'smoke')` runs
 * a point-light loop with a wrapped-diffuse term, which is first-order in-scattering. Chemistry's
 * `emitSmoke` writes into a `ParticleInstances`, so a consumer driving smoke from the simulation
 * gets the second one — and the refusal being tested here is written as though there were only one.
 *
 * So the rig carries both, on the same geometry, under the same toggle, and `?medium=particles`
 * picks the second. Anything else and the comparison would be between two scenes.
 */
const PARTICLE_COUNT = 900;

class SmokeRoomHandle implements DemoHandle {
  private readonly renderer: RendererApi;
  private readonly canvas: HTMLCanvasElement;
  private readonly camera = new Camera();
  readonly view = new OrbitView(20, 90, 6);

  private readonly room: MeshHandle;
  private readonly fire: PlumeHandle;
  private readonly smoke: PlumeHandle;
  private readonly motes: ParticlePool;
  private readonly moteBatch: ParticleHandle;
  private readonly lights: PointLightSource[] = [FIRE_LIGHT];
  private readonly lightBuffer = createPointLightBuffer();
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0, extra: '' };

  private elapsed = 0;
  private disposed = false;

  constructor(
    renderer: RendererApi,
    canvas: HTMLCanvasElement,
    private readonly drawSmoke: boolean,
    private readonly look: 'wall' | 'smoke',
    private readonly medium: 'plumes' | 'particles',
  ) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.renderer.resize();

    /*
     * `addBox` takes **half**-extents. Getting that wrong is invisible in a lit room and was not
     * invisible here: the first version built a room twice its intended size and read as a
     * lighting failure rather than as a geometry one.
     */
    const builder = new MeshBuilder();
    /* Floor, and a plain grey so what is read off it is the light rather than the paint. */
    builder.addBox([0, -0.25, 0], [ROOM_HALF, 0.25, ROOM_HALF], [0.55, 0.55, 0.56]);
    /* The screen: the surface the measurement is taken on, facing the fire. */
    builder.addBox(
      [0, ROOM_HEIGHT / 2, SCREEN_Z],
      [ROOM_HALF, ROOM_HEIGHT / 2, 0.25],
      [0.62, 0.62, 0.63],
    );
    /* The two side walls, so the room is a room and the light has somewhere to bounce off. */
    for (const side of [-1, 1]) {
      builder.addBox(
        [side * ROOM_HALF, ROOM_HEIGHT / 2, 0],
        [0.25, ROOM_HEIGHT / 2, ROOM_HALF],
        [0.5, 0.5, 0.52],
      );
    }
    this.room = renderer.createMesh(builder.build());

    /*
     * **The environment has to be pointed at the buffer's arrays, and nothing says so if it is
     * not.** `selectPointLights` fills a `PointLightBuffer`, and the mesh pass reads its uniforms
     * off the environment — so setting `lightCount` alone leaves the shader looping over positions
     * nobody wrote, which is zero, which is a real position. `AGENTS.md`'s rule about a missing
     * value-typed member being silent where a missing method is loud, met on the first frame: the
     * room came back black and read as a lighting failure rather than as a binding that was
     * never made.
     */
    ENV.lightPositions = this.lightBuffer.positions;
    ENV.lightColors = this.lightBuffer.colors;
    ENV.lightRadii = this.lightBuffer.radii;
    ENV.lightSourceRadii = this.lightBuffer.sourceRadii;
    ENV.lightWeights = this.lightBuffer.weights;
    ENV.activeLightWorldIndices = this.lightBuffer.sourceIndex;

    this.fire = renderer.createPlumes(FIRE_PLUMES, {
      material: 'fire',
      blend: 'additive',
      sizePulse: 0,
      windResponse: 0,
    });
    this.smoke = renderer.createPlumes(SMOKE_PLUMES, {
      material: 'smoke',
      blend: 'alpha',
      sizePulse: 0,
      windResponse: 0,
    });

    /*
     * The same volume as particles. Long-lived and motionless, because what is being measured is
     * the shading rather than the motion, and a drifting medium would put a difference between two
     * captures that is not the thing under test.
     */
    this.motes = new ParticlePool({
      capacity: PARTICLE_COUNT,
      lifeSec: 1e6,
      sizeStart: 1.1,
      sizeEnd: 1.1,
      colorStart: [0.5, 0.5, 0.5],
      colorEnd: [0.5, 0.5, 0.5],
      gravity: 0,
      drag: 0,
      rise: 0,
      alphaStart: 0.28,
      alphaEnd: 0.28,
    });
    this.moteBatch = renderer.createParticles(PARTICLE_COUNT, {
      material: 'smoke',
      blend: 'alpha',
      erosion: 0.2,
    });
    /*
     * Filled once, on a fixed lattice over the same box the plumes occupy. A lattice rather than a
     * scatter, because two captures have to be the same volume and `Math.random` in a rig is a
     * difference between runs with nothing behind it.
     */
    let seed = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i % 15;
      const iy = ((i / 15) | 0) % 6;
      const iz = (i / 90) | 0;
      this.motes.emit(
        -10 + ix * 1.45,
        0.6 + iy * 1.2,
        SMOKE_Z + (iz - 4.5) * 0.95,
        0,
        0,
        0,
        (seed = (seed + 0.137) % 1),
      );
    }
  }

  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  get lost(): boolean {
    return this.renderer.contextLost;
  }

  frame(dtSec: number): DemoStats {
    if (this.disposed || this.renderer.contextLost) return this.stats;
    this.elapsed += dtSec;

    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else if (this.look === 'smoke') {
      /*
       * Facing the bank with the fire behind it: the view that shows what the measurement was
       * taken through. Without it the rig can assert the smoke is there and cannot show it, and a
       * capture pair that came back identical would be indistinguishable from a bank that never
       * drew.
       */
      camera.position[0] = 0;
      camera.position[1] = 3;
      camera.position[2] = SCREEN_Z + 3;
      camera.lookAt(0, 3, FIRE_Z);
      this.view.follow(camera, 0, 3, FIRE_Z);
    } else {
      /*
       * Fixed, hard against the left wall and facing the screen, so the smoke bank is between the
       * fire and the screen and entirely out of frame. That geometry *is* the control: what changes
       * between the two captures is the light path and not the view path.
       */
      camera.position[0] = -10;
      camera.position[1] = 3.4;
      camera.position[2] = -2;
      camera.lookAt(-2, 2.6, SCREEN_Z);
      this.view.follow(camera, -2, 2.6, SCREEN_Z);
    }
    camera.updateMatrices(this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1);

    selectPointLights(
      this.lights,
      camera.position[0] ?? 0,
      camera.position[1] ?? 0,
      camera.position[2] ?? 0,
      this.lightBuffer,
      this.elapsed,
    );
    ENV.lightCount = this.lightBuffer.count;

    /*
     * The pool writes its instance data in `update`, so a batch that is never updated is a batch
     * with nothing in it. Zero gravity, zero drag and a million-second life, so this advances the
     * bookkeeping and moves not one particle.
     */
    if (this.medium === 'particles') this.motes.update(dtSec);

    this.renderer.beginFrame([0.008, 0.009, 0.014]);
    this.renderer.bindMeshPass(camera, ENV);
    this.renderer.drawSky(camera, SKY, ENV);
    this.renderer.drawMesh(this.room, IDENTITY);
    this.renderer.drawPlumes(this.fire, camera, this.elapsed, ENV, 0.2, 0.1);
    if (this.drawSmoke) {
      if (this.medium === 'particles') {
        this.renderer.drawParticles(
          this.moteBatch,
          this.motes.particles,
          camera,
          ENV,
          this.elapsed,
        );
      } else {
        this.renderer.drawPlumes(this.smoke, camera, this.elapsed, ENV, 0.35, 0.15);
      }
    }
    this.renderer.endFrame();

    this.stats.draws = this.drawSmoke ? 4 : 3;
    this.stats.extra = !this.drawSmoke
      ? 'medium off — the control'
      : this.medium === 'particles'
        ? `${PARTICLE_COUNT} smoke particles across the light path`
        : `${SMOKE_PLUMES.length} smoke plumes across the light path`;
    return this.stats;
  }

  resize(): void {
    this.renderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposePlumes(this.fire);
    this.renderer.disposePlumes(this.smoke);
    this.renderer.disposeParticles(this.moteBatch);
    this.renderer.disposeMesh(this.room);
    this.renderer.dispose();
  }
}

export const smokeRoom: DemoScene = {
  id: 'smoke-room',
  title: 'A fire behind a bank of smoke',
  note:
    'A rig for one measurement: whether smoke between a fire and a wall changes what reaches the ' +
    'wall. `?smoke=0` removes the bank and nothing else, so a capture pair differs on the lit ' +
    'surface only if the smoke did something to the light crossing it. `?look=smoke` turns round ' +
    'and faces the bank, which is how the bank is shown to be there at all.',

  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(canvas, { ...overrides }, DEMO_BACKEND);
    await renderer.ready();
    /*
     * Read from the address bar, because the toggle has to survive a capture harness that can only
     * pass a query string. Absent means on, so the scene shows what it is about by default.
     */
    const asked = new URLSearchParams(globalThis.location?.search ?? '');
    return new SmokeRoomHandle(
      renderer,
      canvas,
      asked.get('smoke') !== '0',
      asked.get('look') === 'smoke' ? 'smoke' : 'wall',
      asked.get('medium') === 'particles' ? 'particles' : 'plumes',
    );
  },
};

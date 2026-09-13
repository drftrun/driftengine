/**
 * The same fall, every time: a stack of stone balls knocked down a stepped ramp.
 *
 * The other scenes are about what the engine can draw. This one is about the property
 * that makes a game recordable, and it is the hardest one to demonstrate because it
 * looks like nothing at all when it works.
 *
 * **The claim being made.** The simulation advances in fixed steps of exactly 1/60 of a
 * second, in a fixed order, from a seeded generator. It never reads a wall clock and it
 * never reads a frame time. So the state at step *n* is a pure function of the seed and
 * *n*, which means this fall is the same fall on every machine, at every frame rate, in
 * every session, forever.
 *
 * **Why that is worth a scene of its own.** It is what a replay is: a recorded run is a
 * seed and a list of inputs, a few hundred bytes, rather than a video. It is what a
 * ghost is, what a leaderboard can be checked against, and what makes a physics bug
 * reportable — a run that cannot be reproduced cannot be fixed, only argued about.
 *
 * **How the page can check it.** The run restarts every cycle, and the scene reports the
 * resting position of the balls from the previous run beside the current one. They
 * agree bit for bit or the counter stops advancing. Nothing here is being asserted at
 * you: the number on the screen is a comparison, run live.
 */

import type { DemoBudget, DemoHandle, DemoScene, DemoStats, ResolutionControl } from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import {
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  Camera,
  ColliderSet,
  MeshBuilder,
  TAU,
  boxCollider,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
  moveAxis,
  mulberry32,
} from '../packages/core/src/index';
import type {
  Body,
  Collider,
  Environment,
  Mesh,
  MeshHandle,
  MeshData,
  RenderQualityOptions,
  RenderBackend,
  RendererApi,
  ShadowCasters,
  SkyColors,
  Vec3,
} from '../packages/core/src/index';

/* -- The apparatus, in metres --------------------------------------------- */

/** The ramp: how many steps, how deep and how tall each is. */
const STEPS = 7;
const STEP_RUN_M = 1.5;
const STEP_RISE_M = 0.62;
const RAMP_WIDTH_M = 5.2;

/**
 * The stack that gets knocked down: a wall of stone balls at the top of the ramp.
 *
 * **Spheres rather than boxes, and the reason is what the simulation does not model.**
 * There is no angular velocity here: a body is a position and a velocity, and nothing
 * rotates. A cube that slides down a flight of steps without ever tumbling is instantly
 * wrong to look at, and no amount of markings on it helps — the first version painted a
 * band round each one to make the rotation legible, which only advertised that there was
 * none. A sphere has no orientation to betray, so it reads exactly as what it is.
 */
const BALL_R = 0.23;
const BALL_COLUMNS = 5;
const BALL_ROWS = 5;
const BALL_COUNT = BALL_COLUMNS * BALL_ROWS;

/** How long a run lasts before the apparatus is reset and it happens again. */
const RUN_SECONDS = 8;

/**
 * The step the simulation advances in, and it is the whole point.
 *
 * A physics loop driven by the frame time produces a different result on a 60 Hz panel
 * from a 144 Hz one, and a different result again on the frame where a browser hitched.
 * A fixed step decouples the simulation from how fast the machine happens to be drawing:
 * a slow frame runs more steps, a fast one runs fewer, and the sequence of states is
 * identical in both cases.
 */
const STEP_SEC = 1 / 60;
/** A ceiling on catch-up, so a tab restored after a minute does not run a minute of it. */
const MAX_STEPS_PER_FRAME = 6;

const GRAVITY = 19.5;
/** How much speed a ball keeps when it lands on something. */
const BOUNCE = 0.24;
/*
 * Only applied on a landing, and gently.
 *
 * It was four times this, which killed the run: a ball resting on a step lands on
 * every single frame, so the decay compounded sixty times a second and the stack slumped
 * where it stood instead of cascading. Friction wants to be the reason a ball finally
 * stops, rather than the reason it never starts.
 */
const FRICTION = 1.1;

/* -- Palette --------------------------------------------------------------- */

const CONCRETE: Vec3 = [0.3, 0.3, 0.32];
const CONCRETE_EDGE: Vec3 = [0.4, 0.4, 0.42];
const BALL_A: Vec3 = [0.62, 0.36, 0.16];
const BALL_B: Vec3 = [0.5, 0.44, 0.3];
const STONE_FLOOR: Vec3 = [0.36, 0.36, 0.35];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Where the top of the ramp is, so everything else can be placed from it. */
const TOP_Y_M = STEPS * STEP_RISE_M;
const TOP_Z_M = -STEPS * STEP_RUN_M;

/** The ramp and the floor it runs down to, plus the colliders that match them. */
function buildRamp(): { mesh: MeshData; colliders: Collider[] } {
  const builder = new MeshBuilder();
  const colliders: Collider[] = [];
  builder.setRoughness(0.85);
  /* Cast concrete and a stone apron: aggregate throughout, so all of it grains. */
  builder.setGrain(0.9);

  for (let i = 0; i < STEPS; i++) {
    const y = i * STEP_RISE_M;
    const z = -i * STEP_RUN_M;
    /*
     * Each step is a solid block down to the floor rather than a tread.
     *
     * A ball that clipped through the riser of a hollow step would be the one thing in
     * this scene a reader would remember, and a solid block cannot be entered from the
     * side however fast anything arrives.
     */
    const halfY = (y + STEP_RISE_M) / 2;
    builder.addBox(
      [0, halfY, z - STEP_RUN_M / 2],
      [RAMP_WIDTH_M / 2, halfY, STEP_RUN_M / 2],
      i % 2 === 0 ? CONCRETE : CONCRETE_EDGE,
      0,
      0.15,
    );
    colliders.push(
      boxCollider(0, halfY, z - STEP_RUN_M / 2, RAMP_WIDTH_M / 2, halfY, STEP_RUN_M / 2),
    );
  }

  /*
   * The run-out, and a wide apron around the whole apparatus.
   *
   * The apron is not there to be collided with; it is there because a ramp standing in
   * empty fog reads as a model on a turntable rather than as a place. It is one box.
   */
  builder.addBox([0, -0.9, 0], [30, 0.5, 34], STONE_FLOOR, 0, 0.1);
  builder.addBox([0, -0.4, 5], [RAMP_WIDTH_M / 2, 0.4, 10], CONCRETE, 0, 0.15);
  colliders.push(boxCollider(0, -0.4, 5, RAMP_WIDTH_M / 2, 0.4, 10));
  colliders.push(boxCollider(0, -0.9, 0, 30, 0.5, 34));
  for (const side of [-1, 1]) {
    const x = (side * (RAMP_WIDTH_M + 0.5)) / 2;
    builder.addBox([x, 0.16, 4], [0.25, 0.24, 11], CONCRETE_EDGE, 0, 0.2);
    colliders.push(boxCollider(x, 0.16, 4, 0.25, 0.24, 11));
  }

  builder.setRoughness(null);
  return { mesh: builder.build(), colliders };
}

/** One ball, centred on its own origin so an instance transform is a translation. */
function buildBall(color: Vec3): MeshData {
  const builder = new MeshBuilder();
  builder.setRoughness(0.55);
  /*
   * And no grain, which is a rendering fact rather than a claim about what the balls are
   * made of. The pattern is world-space, so a prop that *turns* moves through it as a solid
   * would — but a prop travelling several metres a second crosses many cycles per frame,
   * and that reads as the surface crawling rather than as the object moving.
   */
  builder.setGrain(0);
  // Enough segments to read as round at this size and no more: twenty-five of these are
  // in the frame, and every one of them is in the shadow pass as well.
  builder.addSphere([0, 0, 0], BALL_R, color, 0, 16, 8);
  builder.setRoughness(null);
  return builder.build();
}

const PROFILES: Readonly<Record<DemoBudget, RenderQualityOptions>> = {
  full: {
    /*
     * Four samples. The one place a demo deliberately asks for *more* than the engine
     * default, because the default is 1 only so that no scene written before multisampling
     * existed changes by a bit — not because 1 is the right look. These scenes are what the
     * engine is judged on, and a panel gap or a trim edge seen at a shallow angle is a
     * staircase without it.
     */
    sceneSamples: 4,
    pointShadows: false,
    water: false,
    waterReflections: false,
  },
  lean: {
    pointShadows: false,
    water: false,
    waterReflections: false,
    directionalShadows: false,
    screenEffects: false,
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
  },
};

class CollapseHandle implements DemoHandle {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: RendererApi;

  /** Which backend is actually drawing, asked of the renderer rather than of the address bar. */
  get backend(): RenderBackend {
    return this.renderer.backend;
  }

  /** Whether the device has gone, so a host can remount rather than show a black frame. */
  get lost(): boolean {
    return this.renderer.contextLost;
  }
  private readonly camera = new Camera();
  /** Handed out through the contract, so a viewer can take the camera at any time. */
  readonly view = new OrbitView(4, 60, 0.5);
  private readonly ramp: MeshHandle;
  private readonly balls: readonly MeshHandle[];
  private readonly colliders: ColliderSet;
  private readonly env: Environment;
  private readonly sky: SkyColors;
  private readonly lightMatrix = new Float32Array(16);
  private readonly casters: ShadowCasters;
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };

  /** Per ball: the body the simulation moves, and the matrix the renderer draws. */
  private readonly bodies: Body[] = [];
  private readonly velocity: Float32Array;
  private readonly models: Float32Array[] = [];
  /** Where the previous run came to rest, and where this one has. */
  private readonly restedPrevious: Float32Array;
  private readonly restedCurrent: Float32Array;

  private elapsedSec = 0;
  private carrySec = 0;
  private runSec = 0;
  /** How many consecutive runs have landed in exactly the same place. */
  private identicalRuns = 0;
  private hasPreviousRun = false;
  private disposed = false;
  private lastGpuMs = 0;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = renderer;
    const renderer_ = renderer;

    const ramp = buildRamp();
    this.ramp = renderer.createMesh(ramp.mesh);
    this.colliders = new ColliderSet(ramp.colliders);
    this.balls = [renderer.createMesh(buildBall(BALL_A)), renderer.createMesh(buildBall(BALL_B))];

    this.velocity = new Float32Array(BALL_COUNT * 3);
    this.restedPrevious = new Float32Array(BALL_COUNT * 3);
    this.restedCurrent = new Float32Array(BALL_COUNT * 3);
    for (let i = 0; i < BALL_COUNT; i++) {
      /*
       * A box body around a round ball, which is the sphere's bounding box.
       *
       * `moveAxis` resolves a `Body`, and a body is a box. At this radius the corners it
       * adds are a couple of centimetres of contact arriving marginally early, which is
       * invisible here and would matter in a game about rolling.
       */
      this.bodies.push({ x: 0, y: 0, z: 0, hx: BALL_R, hy: BALL_R, hz: BALL_R });
      // One model matrix per ball, built once. A ball is placed rather than turned, so
      // the matrix is a translation and only three of its numbers ever change.
      this.models.push(new Float32Array(IDENTITY));
    }
    this.reset();

    this.env = createEnvironment({
      directionalDir: [-0.42, 0.78, 0.46],
      directionalColor: [1.05, 0.99, 0.88],
      ambient: [0.33, 0.36, 0.42],
      ambientGround: [0.2, 0.19, 0.18],
      emissiveGain: 0,
      nightFactor: 0,
      fogColor: [0.62, 0.65, 0.7],
      fogDensity: 0.006,
      fogHeightFalloff: 0.02,
      fogBaseY: 0,
    });
    this.sky = {
      top: [0.24, 0.38, 0.62],
      horizon: [0.68, 0.72, 0.77],
      deep: [0.16, 0.27, 0.5],
      sunDir: this.env.directionalDir,
      sunColor: [1, 0.95, 0.84],
      sunAngularRadius: 0.0046,
      moonDir: [0, -1, 0],
      moonColor: [0, 0, 0],
      moonAngularRadius: 0.01,
      moonPhase: 0.5,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    };

    this.casters = (sink) => {
      this.stats.draws++;
      sink.mesh(this.ramp, IDENTITY);
      for (let i = 0; i < BALL_COUNT; i++) {
        this.stats.draws++;
        sink.mesh(this.balls[i % 2] as Mesh, this.models[i] as Float32Array);
      }
    };

    this.camera.fovYDeg = 48;
    this.camera.near = 0.3;
    this.camera.far = 160;

    renderer.resize();
  }

  /**
   * Put the apparatus back exactly where it started.
   *
   * From a generator seeded with a constant, so "exactly" means exactly: the same
   * sequence of offsets, in the same order, on every run and every machine. A reset
   * that used `Math.random` would make this scene a demonstration of the opposite of
   * what it is for.
   */
  private reset(): void {
    const random = mulberry32(0xc011_a95e);
    for (let i = 0; i < BALL_COUNT; i++) {
      const column = i % BALL_COLUMNS;
      const row = Math.floor(i / BALL_COLUMNS);
      const body = this.bodies[i] as Body;
      // A hair of offset per ball, so the stack is not a perfect lattice and the fall
      // has something to be sensitive to. It is the same hair every time.
      body.x = (column - (BALL_COLUMNS - 1) / 2) * (BALL_R * 2 + 0.03) + (random() - 0.5) * 0.012;
      body.y = TOP_Y_M + BALL_R + row * (BALL_R * 2 + 0.004);
      body.z = TOP_Z_M + 0.9 + (random() - 0.5) * 0.012;
      const v = i * 3;
      // The shove that starts it: down the ramp, strongest at the top of the stack.
      this.velocity[v] = (random() - 0.5) * 0.35;
      this.velocity[v + 1] = 0;
      this.velocity[v + 2] = 4.6 + row * 1.15 + random() * 0.4;
    }
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    if (this.disposed) return this.stats;

    this.elapsedSec += dtSec;
    this.stats.draws = 0;
    renderer.resize();

    /*
     * Fixed steps, with the remainder carried.
     *
     * This is the whole of the determinism claim in six lines: the simulation is handed
     * a constant, the leftover time waits for the next frame, and a frame that took too
     * long runs a bounded number of steps rather than an unbounded one. Nothing below
     * this line ever sees `dtSec`.
     */
    this.carrySec += Math.min(dtSec, 0.25);
    let steps = 0;
    while (this.carrySec >= STEP_SEC && steps < MAX_STEPS_PER_FRAME) {
      this.carrySec -= STEP_SEC;
      steps++;
      this.step();
    }

    const camera = this.camera;
    const now = this.elapsedSec;
    if (this.view.taken) {
      this.view.place(camera);
    } else {
      // A slow arc around the run-out, low enough that the steps are read edge on.
      const angle = Math.sin((now / 27) * TAU) * 0.7;
      camera.position[0] = Math.sin(angle) * 15;
      camera.position[1] = 5.4 + Math.sin(now * 0.21) * 0.6;
      camera.position[2] = Math.cos(angle) * 15 + 2;
      camera.lookAt(0, 2.2, -4.5);
      this.view.follow(camera, 0, 2.2, -4.5);
    }
    const height = this.canvas.height;
    camera.updateMatrices(height > 0 ? this.canvas.width / height : 1);

    renderer.gpuTimer.beginFrame();

    const env = this.env;
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      2,
      -4,
      13,
      renderer.shadowMapSize,
      this.lightMatrix,
    );
    env.lightViewProj = this.lightMatrix;
    env.shadowStrength = 0.9;
    renderer.beginShadowPass(this.lightMatrix, 'static');
    renderer.drawShadowCasters(this.casters);
    renderer.endShadowPass();

    renderer.beginFrame(this.sky.horizon);
    renderer.gpuTimer.begin('rest');

    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(this.ramp, IDENTITY);
    this.stats.draws++;
    for (let i = 0; i < BALL_COUNT; i++) {
      renderer.drawMesh(this.balls[i % 2] as Mesh, this.models[i] as Float32Array);
      this.stats.draws++;
    }
    renderer.drawSky(camera, this.sky, env);
    this.stats.draws++;

    renderer.gpuTimer.end();
    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.gpuMs = this.lastGpuMs;
    /*
     * The comparison, printed. Zero until two runs have finished, then one more each
     * time the balls land exactly where they landed before. If the loop ever reached
     * outside itself for a number, this would sit at zero and the scene would be
     * telling on itself in public, which is the correct behaviour for a claim like this.
     */
    this.stats.extra =
      this.identicalRuns > 0 ? `${this.identicalRuns} identical runs` : 'comparing runs';

    return this.stats;
  }

  /**
   * One simulation step: gravity, then a swept move on each axis in a fixed order.
   *
   * Axis at a time, and always the same order, because that is what makes a collision
   * response reproducible. Resolving "the move" as a single vector needs a choice about
   * which contact wins, and any choice that depends on floating point comparison order
   * is a choice that can differ between two runs of the same input.
   */
  private step(): void {
    const bodies = this.bodies;
    const velocity = this.velocity;

    for (let i = 0; i < BALL_COUNT; i++) {
      const body = bodies[i] as Body;
      const v = i * 3;
      velocity[v + 1] = (velocity[v + 1] as number) - GRAVITY * STEP_SEC;

      const movedX = moveAxis(body, this.colliders, AXIS_X, (velocity[v] as number) * STEP_SEC);
      if (Math.abs(movedX) < Math.abs((velocity[v] as number) * STEP_SEC) - 1e-6) {
        velocity[v] = -(velocity[v] as number) * BOUNCE;
      }

      const wantZ = (velocity[v + 2] as number) * STEP_SEC;
      const movedZ = moveAxis(body, this.colliders, AXIS_Z, wantZ);
      if (Math.abs(movedZ) < Math.abs(wantZ) - 1e-6) {
        velocity[v + 2] = -(velocity[v + 2] as number) * BOUNCE;
      }

      const wantY = (velocity[v + 1] as number) * STEP_SEC;
      const movedY = moveAxis(body, this.colliders, AXIS_Y, wantY);
      if (Math.abs(movedY) < Math.abs(wantY) - 1e-6) {
        // Landing: keep a little of the impact, and let the floor take the rest through
        // friction on the axes it can reach.
        velocity[v + 1] = -(velocity[v + 1] as number) * BOUNCE;
        const decay = Math.max(0, 1 - FRICTION * STEP_SEC);
        velocity[v] = (velocity[v] as number) * decay;
        velocity[v + 2] = (velocity[v + 2] as number) * decay;
      }

      const model = this.models[i] as Float32Array;
      model[12] = body.x;
      model[13] = body.y;
      model[14] = body.z;
    }

    this.runSec += STEP_SEC;
    if (this.runSec >= RUN_SECONDS) this.finishRun();
  }

  /**
   * Compare where this run ended against where the last one ended, then start again.
   *
   * The comparison is exact. There is no tolerance, because the claim is not that the
   * runs are close: they are the same arithmetic in the same order on the same inputs,
   * and anything other than equality would mean something in the loop had reached
   * outside itself for a number.
   */
  private finishRun(): void {
    const rested = this.restedCurrent;
    for (let i = 0; i < BALL_COUNT; i++) {
      const body = this.bodies[i] as Body;
      rested[i * 3] = body.x;
      rested[i * 3 + 1] = body.y;
      rested[i * 3 + 2] = body.z;
    }

    if (this.hasPreviousRun) {
      let same = true;
      for (let i = 0; i < rested.length; i++) {
        if (rested[i] !== this.restedPrevious[i]) {
          same = false;
          break;
        }
      }
      this.identicalRuns = same ? this.identicalRuns + 1 : 0;
    }

    this.restedPrevious.set(rested);
    this.hasPreviousRun = true;
    this.runSec = 0;
    this.reset();
  }

  /**
   * Density, so a host that measures this scene can soften it rather than stop it.
   *
   * A getter rather than a stored object: `this.renderer` is assigned in the constructor body
   * on most of these scenes and a class field would be initialised before it, which would
   * capture `undefined` and fail at the first frame a governor moved.
   */
  get resolution(): ResolutionControl {
    return {
      ceiling: this.renderer.resolutionScale,
      apply: (scale: number): void => this.renderer.applyResolutionScale(scale),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeMesh(this.ramp);
    for (const ball of this.balls) this.renderer.disposeMesh(ball);
    this.renderer.dispose();
  }
}

export const collapse: DemoScene = {
  id: 'collapse',
  title: 'The same fall, twice',
  note: 'Twenty-five stone balls knocked down a stepped ramp, simulated in fixed steps from a seeded start. The run repeats every nine seconds and lands in exactly the same place, which is what makes a run recordable as a seed rather than as a video.',
  async mount(
    canvas: HTMLCanvasElement,
    budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    const { renderer } = await createRenderer(
      canvas,
      { ...PROFILES[budget], ...overrides },
      DEMO_BACKEND,
    );
    /* Pipelines compiled before the first frame rather than inside it; on WebGPU
       `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
    await renderer.ready();
    return new CollapseHandle(renderer, canvas);
  },
};

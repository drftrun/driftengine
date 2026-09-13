/**
 * A hillside in the wind: forty thousand plants, in six draw calls.
 *
 * The court next door is about light. This one is about **quantity**, which is the
 * other half of what a game engine has to survive: a world is not a handful of lit
 * objects, it is a field of small things that all have to move, be lit, and cast into
 * the same shadow map, at a cost that does not scale with how many of them there are.
 *
 * **What it is composed to show:**
 *
 *   1. **One draw call per kind, whatever the count.** The grass is a single instanced
 *      batch. Doubling it changes the instance figure over the frame and leaves the
 *      draw figure exactly where it is, which is the whole argument for instancing and
 *      is much easier to believe when both numbers are printed side by side.
 *   2. **A gust that travels.** Wind is one shared field, sampled once per frame and
 *      handed to everything that answers to it. Each plant takes its phase from its own
 *      world position, so a gust crosses the hillside rather than the hillside pulsing.
 *   3. **Foliage that casts what it is.** A canopy is bent by the wind and must be bent
 *      *identically* in the depth pass, or its shadow comes loose from it. The shadow
 *      sink takes instanced batches for exactly this reason, and this scene uses it.
 *   4. **Terrain generated, not loaded.** The hill is a height function evaluated over a
 *      grid at mount. There is no heightmap, because there is no image of any kind.
 */

import type { DemoBudget, DemoHandle, DemoScene, DemoStats, ResolutionControl } from './types';
import { OrbitView } from './orbit';
import { DEMO_BACKEND } from './backend';
import {
  Camera,
  MeshBuilder,
  TAU,
  advanceWindField,
  buildTree,
  computeLightMatrix,
  createEnvironment,
  createInstanceData,
  createRenderer,
  createWindField,
  mulberry32,
  writeInstance,
} from '../packages/core/src/index';
import type {
  Environment,
  InstanceData,
  MeshHandle,
  ScatterHandle,
  MeshData,
  RenderQualityOptions,
  RenderBackend,
  RendererApi,
  ShadowCasters,
  SkyColors,
  Vec3,
  WindProfile,
} from '../packages/core/src/index';

/* -- The hillside, in metres ---------------------------------------------- */

/** Half the ground plane, and the cell it is tessellated at. */
const GROUND_HALF_M = 46;
const CELL_M = 2.3;
/** Where the plants are sown: a disc, so the field has no visible square edge. */
const SOWN_RADIUS_M = 33;

/**
 * How many plants, and it is the number this scene exists to print.
 *
 * Chosen to be plainly more than anybody would place by hand and plainly affordable:
 * at this count the grass is one buffer and one draw call, and the frame cost is
 * dominated by how many of them cover a pixel rather than by how many exist. Raising it
 * moves the instance figure and leaves the draw figure alone, which is the point.
 */
const GRASS_COUNT = 42_000;
const GRASS_HEIGHT_M = 0.44;
const TREE_COUNT = 18;

/* -- The camera ------------------------------------------------------------ */

/**
 * A slow pass across the slope rather than an orbit.
 *
 * An orbit says "look at this object". A field has no object to orbit, and travelling
 * over it is what makes the parallax between near grass and far trees legible — which
 * is the only thing that communicates how much ground is actually covered.
 */
const PASS_SECONDS = 54;
const PASS_HALF_M = 26;
const CAMERA_HEIGHT_M = 4.2;
/*
 * Inside the sown disc, not behind it.
 *
 * At 30 the camera stood outside a 25 m field looking in, so the nearest third of every
 * frame was bare ground: the plants were all in the middle distance and the scene read
 * as a lawn seen from a car park. A field is convincing from inside it.
 */
const CAMERA_Z_M = 19;

/* -- Palette --------------------------------------------------------------- */

const SOIL: Vec3 = [0.29, 0.3, 0.21];
const SOIL_HIGH: Vec3 = [0.45, 0.47, 0.33];
const BLADE: Vec3 = [0.42, 0.53, 0.24];
const BARK: Vec3 = [0.27, 0.22, 0.17];
const LEAF: Vec3 = [0.29, 0.42, 0.21];

/**
 * A steady breeze with a real gust in it, on a cycle that closes exactly.
 *
 * `cycleSeconds` matters more than it looks: the profile is built from integer
 * harmonics so the whole signal repeats, which is what lets a recorded run be replayed
 * and get the same weather. A demo does not need that, and inheriting it costs nothing.
 */
const WIND: WindProfile = {
  directionX: 0.82,
  directionZ: 0.57,
  baseSpeed: 2.6,
  gustSpeed: 2.2,
  directionWander: 0.35,
  cycleSeconds: 41,
  phase: 0,
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * The hill, as a function rather than a picture.
 *
 * Three sines at different scales and angles. It is not noise and does not pretend to
 * be: at this size what a slope has to do is stop the ground reading as a plane and
 * give the grass somewhere to sit above the horizon, and three terms do that for the
 * cost of three sines per vertex, evaluated once at mount.
 */
function heightAt(x: number, z: number): number {
  return (
    Math.sin(x * 0.055) * 2.6 +
    Math.sin(z * 0.043 + 1.7) * 2.1 +
    Math.sin((x + z) * 0.11 + 0.6) * 0.7
  );
}

/** Everything rigid: the ground, and the trunks standing on it. */
function buildGround(random: () => number, trees: readonly MeshData[]): MeshData {
  const builder = new MeshBuilder();
  builder.setRoughness(0.9);
  /*
   * And no `setGrain` anywhere in this scene, which is the audit result rather than an
   * omission. Soil, bark, leaf and grass are all rough and none of them is mineral: what
   * gives loose earth its look is that it is loose, not that it has crystal structure.
   * Grain is absent by default, so this costs a comment and no code.
   */

  const steps = Math.ceil((GROUND_HALF_M * 2) / CELL_M);
  for (let ix = 0; ix < steps; ix++) {
    for (let iz = 0; iz < steps; iz++) {
      const x0 = -GROUND_HALF_M + ix * CELL_M;
      const z0 = -GROUND_HALF_M + iz * CELL_M;
      const x1 = x0 + CELL_M;
      const z1 = z0 + CELL_M;
      /*
       * Wound counter-clockwise seen from above, which is what makes the derived
       * normal point at the sky. `addQuad` takes the normal from the winding rather
       * than as an argument, so a face cannot be lit as if it faced somewhere it does
       * not — and getting this backwards shows up immediately as black ground.
       */
      const y00 = heightAt(x0, z0);
      const y10 = heightAt(x1, z0);
      const y11 = heightAt(x1, z1);
      const y01 = heightAt(x0, z1);
      // Higher ground is drier and paler. One lerp, and it is what stops a large
      // single-colour field reading as a flat sheet with a lighting gradient on it.
      const t = Math.min(1, Math.max(0, (y00 + 3) / 7)) * (0.86 + random() * 0.28);
      builder.addQuad(
        [x0, y00, z0],
        [x0, y01, z1],
        [x1, y11, z1],
        [x1, y10, z0],
        [
          SOIL[0] + (SOIL_HIGH[0] - SOIL[0]) * t,
          SOIL[1] + (SOIL_HIGH[1] - SOIL[1]) * t,
          SOIL[2] + (SOIL_HIGH[2] - SOIL[2]) * t,
        ],
      );
    }
  }

  for (const trunk of trees) builder.addMesh(trunk, 0, 0, 0, 1);
  builder.setRoughness(null);
  return builder.build();
}

/**
 * One blade, as two crossed cards.
 *
 * Crossed rather than single for the same reason the plume renderer crosses its blades:
 * one card has no structure to see, so walking past a field of them shows the identical
 * silhouette from every angle and the whole field reads as a sheet. The blade is
 * authored with its base at the origin, because the wind shader roots the bend at y=0
 * and lifts it with the square of height.
 */
function buildBlade(): MeshData {
  const builder = new MeshBuilder();
  const half = 0.026;
  const tip = 0.009;
  for (const turn of [0, Math.PI / 2]) {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const at = (u: number, y: number): Vec3 => [u * c, y, -u * s];
    builder.addQuad(
      at(-half, 0),
      at(half, 0),
      at(tip, GRASS_HEIGHT_M),
      at(-tip, GRASS_HEIGHT_M),
      BLADE,
    );
  }
  return builder.build();
}

/** Sow the disc, and hand back what to draw it with. */
function sowGrass(random: () => number): InstanceData {
  const data = createInstanceData(GRASS_COUNT);
  for (let i = 0; i < GRASS_COUNT; i++) {
    // Square root of a uniform draw, or every plant piles into the middle: area grows
    // with the square of the radius, so a uniform radius is not a uniform field.
    const radius = Math.sqrt(random()) * SOWN_RADIUS_M;
    const angle = random() * TAU;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const shade = 0.78 + random() * 0.46;
    writeInstance(
      data,
      i,
      x,
      heightAt(x, z),
      z,
      0.7 + random() * 0.75,
      random() * TAU,
      shade,
      shade * (0.94 + random() * 0.14),
      shade * 0.9,
      // Bend is the reciprocal of the plant's height: it is what turns a vertex's y
      // into "how far up this plant am I", and the shader squares that.
      1 / GRASS_HEIGHT_M,
      0.55 + random() * 0.9,
      random() * TAU,
    );
  }
  data.count = GRASS_COUNT;
  return data;
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
    // Nothing in this scene has a point light or a water surface, so the passes that
    // serve them are compiled and allocated for nothing.
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

class WindFieldHandle implements DemoHandle {
  /**
   * Held only to dispose engine objects whose `dispose` still takes a context.
   *
   * Null on a backend that is not WebGL2. Asked of the canvas rather than accepted from a
   * host, because a canvas that has given a `webgpu` context cannot also give this one, and
   * a host that supplies it is choosing the backend by accident.
   */
  private readonly gl: WebGL2RenderingContext | null;
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
  readonly view = new OrbitView(5, 70, 1.2);
  private readonly ground: MeshHandle;
  private readonly grass: ScatterHandle;
  private readonly grassData: InstanceData;
  private readonly canopy: ScatterHandle;
  private readonly canopyData: InstanceData;
  private readonly env: Environment;
  private readonly sky: SkyColors;
  private readonly wind = createWindField();
  private readonly lightMatrix = new Float32Array(16);
  private readonly casters: ShadowCasters;
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0, instances: 0 };

  private elapsedSec = 0;
  private disposed = false;
  private lastGpuMs = 0;

  constructor(renderer: RendererApi, canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl2');
    this.canvas = canvas;
    this.renderer = renderer;
    const renderer_ = renderer;

    const random = mulberry32(0x0f1e_2d3c);

    /*
     * Trees: the trunk merges into the ground mesh, the canopy becomes instances.
     *
     * That split is the engine's, not this scene's: `buildTree` hands back `solid` and
     * `flexible` separately because a trunk is rigid and collidable while a crown bends
     * in the wind and must never be either. Merging the trunks costs no extra draw and
     * the crowns are one more batch however many trees there are.
     */
    const trunks: MeshData[] = [];
    const canopyData = createInstanceData(TREE_COUNT);
    let canopySource: MeshData | null = null;
    for (let i = 0; i < TREE_COUNT; i++) {
      const angle = random() * TAU;
      const radius = 9 + Math.sqrt(random()) * (SOWN_RADIUS_M - 3);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = heightAt(x, z);
      const height = 4.4 + random() * 3.2;
      const tree = buildTree(
        {
          height,
          trunkRadius: 0.17 + random() * 0.09,
          taper: 0.5,
          canopyRadius: 1.5 + random() * 0.9,
          canopyClusters: 9,
          trunkColor: BARK,
          canopyColor: LEAF,
        },
        random,
      );
      const solid = new MeshBuilder();
      solid.addMesh(tree.solid, x, y, z, 1);
      trunks.push(solid.build());
      canopySource ??= tree.flexible;
      const shade = 0.85 + random() * 0.3;
      writeInstance(
        canopyData,
        i,
        x,
        y,
        z,
        0.85 + random() * 0.5,
        random() * TAU,
        shade,
        shade,
        shade * 0.92,
        1 / height,
        0.35 + random() * 0.4,
        random() * TAU,
      );
    }
    canopyData.count = TREE_COUNT;
    this.canopyData = canopyData;

    this.ground = renderer.createMesh(buildGround(random, trunks));
    this.grassData = sowGrass(random);
    this.grass = renderer.createScatter(buildBlade(), this.grassData);
    this.canopy = renderer.createScatter(canopySource ?? buildBlade(), canopyData);

    this.env = createEnvironment({
      directionalDir: [-0.36, 0.72, 0.59],
      directionalColor: [1.18, 1.06, 0.86],
      ambient: [0.34, 0.4, 0.5],
      ambientGround: [0.24, 0.24, 0.19],
      emissiveGain: 0,
      nightFactor: 0,
      fogColor: [0.66, 0.72, 0.8],
      fogDensity: 0.008,
      fogHeightFalloff: 0.03,
      fogBaseY: 0,
    });
    this.sky = {
      top: [0.21, 0.4, 0.72],
      horizon: [0.72, 0.78, 0.84],
      deep: [0.13, 0.28, 0.58],
      sunDir: this.env.directionalDir,
      sunColor: [1, 0.94, 0.8],
      sunAngularRadius: 0.0046,
      moonDir: [0, -1, 0],
      moonColor: [0, 0, 0],
      moonAngularRadius: 0.01,
      moonPhase: 0.5,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    };

    /*
     * Both kinds of caster, and the second is the one worth demonstrating.
     *
     * A crown that bends in the wind has to be bent by the *same* numbers in the depth
     * pass or its shadow slides out from under it. The sink takes an instanced batch
     * with the gust it was drawn with, so the picture and its shadow cannot disagree.
     */
    this.casters = (sink) => {
      this.stats.draws++;
      sink.mesh(this.ground, IDENTITY);
      this.stats.draws++;
      sink.scatter(
        this.canopy,
        this.canopyData,
        this.wind.velocityX,
        this.wind.velocityZ,
        this.wind.gust,
        this.elapsedSec,
      );
    };

    this.camera.fovYDeg = 52;
    this.camera.near = 0.25;
    this.camera.far = 220;

    renderer.resize();
  }

  frame(dtSec: number): DemoStats {
    const renderer = this.renderer;
    if (this.disposed) return this.stats;

    this.elapsedSec += dtSec;
    const now = this.elapsedSec;
    this.stats.draws = 0;
    this.stats.instances = this.grassData.count + this.canopyData.count;

    renderer.resize();

    // One field, advanced once, read by everything. A second sample somewhere else in
    // the frame would be a second wind by definition.
    advanceWindField(this.wind, WIND, now, dtSec, 1);

    const camera = this.camera;
    if (this.view.taken) {
      this.view.place(camera);
    } else {
      const sweep = Math.sin((now / PASS_SECONDS) * TAU);
      camera.position[0] = sweep * PASS_HALF_M;
      camera.position[2] = CAMERA_Z_M + Math.cos((now / PASS_SECONDS) * TAU) * 5;
      camera.position[1] =
        heightAt(camera.position[0] ?? 0, camera.position[2] ?? 0) + CAMERA_HEIGHT_M;
      // Looking a little ahead of the sweep, so the field opens up rather than sliding by.
      camera.lookAt(sweep * 6, 1.2, -12);
      this.view.follow(camera, sweep * 6, 1.2, -12);
    }
    const height = this.canvas.height;
    camera.updateMatrices(height > 0 ? this.canvas.width / height : 1);

    this.sky.cloudOffsetX = this.wind.driftX;
    this.sky.cloudOffsetZ = this.wind.driftZ;

    renderer.gpuTimer.beginFrame();

    const env = this.env;
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      camera.position[0] ?? 0,
      0,
      camera.position[2] ?? 0,
      26,
      renderer.shadowMapSize,
      this.lightMatrix,
    );
    env.lightViewProj = this.lightMatrix;
    env.shadowStrength = 0.85;
    renderer.beginShadowPass(this.lightMatrix, 'static');
    renderer.drawShadowCasters(this.casters);
    renderer.endShadowPass();

    renderer.beginFrame(this.sky.horizon);
    renderer.gpuTimer.begin('rest');

    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(this.ground, IDENTITY);
    this.stats.draws++;
    renderer.drawSky(camera, this.sky, env);
    this.stats.draws++;

    // Forty-two thousand plants and eighteen crowns: two calls.
    renderer.drawScatter(
      this.grass,
      this.grassData,
      camera,
      env,
      this.wind.velocityX,
      this.wind.velocityZ,
      this.wind.gust,
      now,
    );
    this.stats.draws++;
    renderer.drawScatter(
      this.canopy,
      this.canopyData,
      camera,
      env,
      this.wind.velocityX,
      this.wind.velocityZ,
      this.wind.gust,
      now,
    );
    this.stats.draws++;

    renderer.gpuTimer.end();
    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.reflection + sample.rest;
    this.stats.gpuMs = this.lastGpuMs;

    return this.stats;
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
    this.renderer.disposeMesh(this.ground);
    this.renderer.disposeScatter(this.grass);
    this.renderer.disposeScatter(this.canopy);
    this.renderer.dispose();
  }
}

export const windField: DemoScene = {
  id: 'wind-field',
  title: 'Wind field',
  note: 'Forty-two thousand plants and a hillside, in six draw calls including the shadow pass. One shared gust travels across the field, and the crowns cast the shape the wind actually bent them into.',
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
    return new WindFieldHandle(renderer, canvas);
  },
};

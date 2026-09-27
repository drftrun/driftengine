/**
 * The courtyard after dark: four braziers on the ground floor, the model's own lanterns, and its ten
 * thousand floating candles, every one a light.
 *
 * **One list, nearest first, into the clustered table.** Braziers and lanterns come first in it and
 * cast; the candles follow and do not. `selectPointLights` chooses the `MAX_CLUSTERED_LIGHTS`
 * nearest the camera every frame, so the arcade the camera is in is lit by its own candles and the
 * far end by its lanterns, and the shadow pool goes to whichever fires are nearest.
 *
 * - **Braziers** are built here from boxes and tubes, so no image is added, and burn as
 *   `createFlame` describes a 40 cm fire: a metre of flame breathing at 2.4 Hz, a plume, and smoke.
 * - **Lanterns** hang where Intel's file put their lights (`LITE`), and burn as a 3 cm flame behind
 *   glass: 9 Hz and barely moving. The glass is the model's own.
 * - **Candles** light where the file put each one. Their flames are the pack's emissive geometry,
 *   so here they are only light, each at 1850 K rather than the file's pure orange.
 *
 * **Brightness is in the palette's units, not candela.** The night is the moon brought up and
 * graded, so these numbers are set against it. At the night's exposure a brazier lights the paving
 * at its foot to about what shade is by day and leaves the bay between two fires dark; a first
 * setting three times this lit the courtyard like a warm noon. A candle lights half a metre.
 * The falloff is inverse-square, windowed at each light's radius. What would make these wrong is a
 * night exposure that changes, which moves every one of them with it.
 *
 * **Every candle lights, near or far: DriftLight.** The candles the frame shades one by one are the
 * 64 nearest; the rest are summed once into a field, occluded by the courtyard's own distance field,
 * which stands in for them past the radius the choice is complete to. Without it an arcade down the
 * courtyard was dark until the camera walked up to it and its candles lit one by one.
 */
import {
  LightField,
  MAX_CLUSTERED_LIGHTS,
  createFlame,
  createPointLightBuffer,
  selectPointLights,
  updateFlame,
} from '../../packages/core/src/index';
import type {
  Camera,
  Environment,
  Flame,
  GlobalFieldInstance,
  MeshHandle,
  PlumeHandle,
  PointLightSource,
  RendererApi,
  ShadowCasters,
  Vec3,
} from '../../packages/core/src/index';
import type { DrftLight } from '@driftengine/drft';
import { BRAZIERS, BRAZIER_TOP_M, buildBraziers } from './braziers';
import { join } from './lightJoin';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A wood fire, about 1,800 K. */
const FIRE_LIGHT: Vec3 = [0.45, 0.22, 0.08];
/** A lantern's flame behind glass, about 2,000 K, and the file's own colour for it. */
const LANTERN_LIGHT = 0.1;
/** A candle, about 1,850 K. */
const CANDLE_LIGHT: Vec3 = [0.016, 0.0085, 0.0026];

const NO_MOVERS: ShadowCasters = () => {};
/** How far a candle lights, which is about a metre: past that it is a point to look at, not a light. */
const CANDLE_RADIUS_M = 1.2;

/**
 * What the address bar may change, for measuring what the fires cost: `?lights=` the most shaded at
 * once, `?candleradius=` a candle's reach, `?pointshadows=0` no fire casting, `?driftlight=0` no
 * summed candlelight, only the nearest candles.
 */
export interface FireOptions {
  readonly lights?: number;
  readonly candleRadius?: number;
  readonly shadows?: boolean;
  readonly summed?: boolean;
}

/**
 * Bricks of the candles' field summed a frame behind the veil. About half a millisecond a brick with
 * a few dozen candles reaching it, so the field is whole in a second or two of the load.
 */
const SUM_BRICKS_PER_FRAME = 24;

/** Slots kept for braziers and lanterns, ahead of the candles. There are 26 of them. */
const FIXTURE_SLOTS = 32;
/**
 * The candles that light at once: the 64 nearest. A candle reaches a metre, so past the nearest few
 * dozen each one lights a hand's width of stone the camera is too far away to see. At the 288 slots
 * left after the fixtures a night's frame spent 18.8 ms at 1440p; at 64 it spends 17.4, and fewer
 * saves nothing more. What it gives up is the glow round the candles furthest down the arcades.
 */
const CANDLE_SLOTS = 64;

export class SponzaFires {
  private readonly renderer: RendererApi;
  private readonly braziers: MeshHandle;
  private readonly fire: PlumeHandle;
  private readonly smoke: PlumeHandle;
  private readonly brazierFlames: Flame[];
  private lanternFlames: Flame[] = [];
  /** Every light: braziers, lanterns, then candles. Built once both packs' lights have arrived. */
  private lights: PointLightSource[] = [];
  private candleFrom = 0;
  /** The braziers and lanterns, and the candles: the same lights as `lights`, split. */
  private fixtures: PointLightSource[] = [];
  private candles: PointLightSource[] = [];
  /**
   * Chosen separately and joined, fixtures first. **One nearest-first list gave every slot to
   * candles**: thousands stand nearer the camera than any brazier, so the fires that light a room
   * lit nothing. Fixtures first also puts the lights worth shadowing where the table gives slots.
   */
  private readonly fixtureBuffer = createPointLightBuffer(FIXTURE_SLOTS);
  private readonly candleBuffer: ReturnType<typeof createPointLightBuffer>;
  private readonly buffer: ReturnType<typeof createPointLightBuffer>;
  /** Instruments, from the address bar: see `FireOptions`. */
  private readonly candleRadius: number;
  private readonly shadows: boolean;
  private readonly summed: boolean;
  /** Every candle summed, standing in for those the frame does not shade. Null until built. */
  private field: LightField | null = null;
  private built = false;
  /** What the candles were last set to, so ten thousand of them are rewritten only when it moves. */
  private candlesLit = -1;

  constructor(renderer: RendererApi, options: FireOptions = {}) {
    this.renderer = renderer;
    const capacity = Math.max(FIXTURE_SLOTS + 1, options.lights ?? MAX_CLUSTERED_LIGHTS);
    this.buffer = createPointLightBuffer(capacity);
    this.candleBuffer = createPointLightBuffer(Math.min(capacity - FIXTURE_SLOTS, CANDLE_SLOTS));
    this.candleRadius = options.candleRadius ?? CANDLE_RADIUS_M;
    this.shadows = options.shadows ?? true;
    this.summed = options.summed ?? true;
    this.braziers = renderer.createMesh(buildBraziers());
    this.brazierFlames = BRAZIERS.map(([x, , z], seed) =>
      createFlame({
        x,
        y: BRAZIER_TOP_M,
        z,
        diameterM: 0.4,
        color: FIRE_LIGHT,
        radius: 14,
        flicker: 0.2,
        seed: seed + 1,
      }),
    );
    this.fire = renderer.createPlumes(
      this.brazierFlames.map((flame) => flame.plume),
      { material: 'fire', blend: 'additive', sizePulse: 0.2, windResponse: 0.05 },
    );
    this.smoke = renderer.createPlumes(
      this.brazierFlames.map((flame) => ({
        x: flame.plume.x,
        y: flame.plume.y + flame.plume.height,
        z: flame.plume.z,
        width: 0.45,
        height: 3,
      })),
      {
        material: 'smoke',
        blend: 'alpha',
        sizePulse: 0.35,
        windResponse: 0.35,
        tint: [0.3, 0.27, 0.24],
      },
    );
  }

  /**
   * The model's lanterns and candles, once. Until both packs' lights have arrived the braziers burn
   * alone. `lamps` is every light the base file carries; its sky and sun markers are left out.
   * `occluders` is the courtyard's distance field, which shadows the candles' summed light.
   */
  offer(
    lamps: readonly DrftLight[],
    candles: readonly DrftLight[],
    blocks: (x: number, y: number, z: number) => boolean,
    occluders: readonly GlobalFieldInstance[],
  ): void {
    if (this.built || lamps.length === 0 || candles.length === 0) return;
    this.built = true;
    this.lanternFlames = lamps
      .filter((light) => light.kind === 'point' && light.name.startsWith('lamp_light'))
      .map((light, seed) =>
        createFlame({
          x: light.position[0],
          y: light.position[1] - (2.5 * 0.03) / 3,
          z: light.position[2],
          diameterM: 0.03,
          color: [
            light.color[0] * LANTERN_LIGHT,
            light.color[1] * LANTERN_LIGHT,
            light.color[2] * LANTERN_LIGHT,
          ],
          radius: 9,
          flicker: 0.06,
          seed: seed + 11,
        }),
      );
    this.lights = [
      ...this.brazierFlames.map((flame) => flame.light),
      ...this.lanternFlames.map((flame) => flame.light),
    ];
    this.candleFrom = this.lights.length;
    this.fixtures = [...this.lights];
    for (const candle of candles) {
      /* The candles the packs cleared from the camera's path take their light with them. */
      if (blocks(candle.position[0], candle.position[1], candle.position[2])) continue;
      this.candles.push({
        x: candle.position[0],
        y: candle.position[1],
        z: candle.position[2],
        r: CANDLE_LIGHT[0],
        g: CANDLE_LIGHT[1],
        b: CANDLE_LIGHT[2],
        radius: this.candleRadius,
        flicker: 0.08,
        shadowNear: 0.05,
        sourceRadius: 0.005,
        castsShadow: false,
      });
    }
    this.lights.push(...this.candles);
    if (this.shadows) this.renderer.prepareStaticPointShadows(this.lights);
    /* Summed at full strength, as they stand now; the night dims the sum through its scale. */
    if (this.summed) {
      /* No fade: it is baked behind the veil, which a held capture steps by a stopped clock. */
      this.field = this.renderer.createLightField(this.candles, { fields: occluders, fadeSec: 0 });
    }
    this.candlesLit = -1;
  }

  /** Whether the lanterns and candles are still to be offered. */
  get waiting(): boolean {
    return !this.built;
  }

  /**
   * Whether the candles' summed light is wholly in, or there is none to wait for: the veil stays
   * until it is, so the probes warmed behind it see the candles too. Asked once every pack is in,
   * which is when the candles are offered, so no field by then means none is coming.
   */
  get summedIn(): boolean {
    return this.field === null || this.field.presence >= 1;
  }

  /** How far the sum has come, 0 to 1, for the loading bar. */
  get summedProgress(): number {
    return this.field?.progress ?? (this.built ? 1 : 0);
  }

  /**
   * This frame's flames, the nearest lights into `env`, and their shadows. `lit` is 0 by day and 1
   * at night; a light at 0 has no radius, so it takes no slot.
   */
  update(
    timeSec: number,
    dtSec: number,
    camera: Camera,
    env: Environment,
    lit: number,
    casters: ShadowCasters,
  ): void {
    const flames = this.brazierFlames;
    for (let i = 0; i < flames.length; i++) this.burn(flames[i] as Flame, timeSec, lit, 14);
    for (let i = 0; i < this.lanternFlames.length; i++) {
      this.burn(this.lanternFlames[i] as Flame, timeSec, lit, 9);
    }
    const lights = this.built ? this.lights : this.brazierLights();
    if (this.built && lit !== this.candlesLit) {
      this.candlesLit = lit;
      for (let i = 0; i < this.candles.length; i++) {
        const candle = this.candles[i] as PointLightSource;
        candle.radius = lit > 0 ? this.candleRadius : 0;
        candle.r = CANDLE_LIGHT[0] * lit;
        candle.g = CANDLE_LIGHT[1] * lit;
        candle.b = CANDLE_LIGHT[2] * lit;
      }
    }
    const eye = camera.position;
    const x = eye[0] ?? 0;
    const y = eye[1] ?? 0;
    const z = eye[2] ?? 0;
    const buffer = this.buffer;
    selectPointLights(
      this.built ? this.fixtures : lights,
      x,
      y,
      z,
      this.fixtureBuffer,
      timeSec,
      60,
    );
    selectPointLights(this.candles, x, y, z, this.candleBuffer, timeSec, 40);
    const field = this.field;
    if (field !== null) {
      if (!field.ready) field.bake(SUM_BRICKS_PER_FRAME);
      field.scale = lit;
      field.follow(this.candleBuffer.complete, x, y, z, dtSec);
    }
    join(buffer, this.fixtureBuffer, this.candleBuffer, this.candleFrom);
    env.lightCount = buffer.count;
    env.lightPositions = buffer.positions;
    env.lightColors = buffer.colors;
    env.lightRadii = buffer.radii;
    env.lightSourceRadii = buffer.sourceRadii;
    env.lightWeights = buffer.weights;
    env.lightDirections = buffer.directions;
    env.lightConeCos = buffer.coneCos;
    env.lightIesProfiles = buffer.iesProfiles;
    env.activeLightWorldIndices = buffer.sourceIndex;
    if (!this.built || !this.shadows) return;
    this.renderer.updatePointShadows(
      lights,
      buffer.sourceIndex,
      buffer.count,
      eye[0] ?? 0,
      eye[1] ?? 0,
      eye[2] ?? 0,
      dtSec,
      casters,
      NO_MOVERS,
      buffer.shadowIndex,
      buffer.shadowCount,
    );
  }

  /** The braziers into a shadow map, beside the packs. */
  cast(sink: Parameters<ShadowCasters>[0]): void {
    sink.mesh(this.braziers, IDENTITY);
  }

  /** The braziers themselves, and their fire and smoke while they burn. */
  draw(camera: Camera, env: Environment, timeSec: number, lit: number): number {
    const renderer = this.renderer;
    renderer.drawMesh(this.braziers, IDENTITY);
    if (lit <= 0) return 1;
    renderer.drawPlumes(this.fire, camera, timeSec, env, 0.2, 0.1);
    renderer.drawPlumes(this.smoke, camera, timeSec, env, 0.35, 0.15);
    return 3;
  }

  dispose(): void {
    this.renderer.disposePlumes(this.fire);
    this.renderer.disposePlumes(this.smoke);
    if (this.field !== null) this.renderer.disposeLightField();
  }

  private burn(flame: Flame, timeSec: number, lit: number, radius: number): void {
    updateFlame(flame, timeSec);
    const light = flame.light;
    light.r *= lit;
    light.g *= lit;
    light.b *= lit;
    light.radius = lit > 0 ? radius : 0;
  }

  private brazierLights(): PointLightSource[] {
    if (this.lights.length === 0) this.lights = this.brazierFlames.map((flame) => flame.light);
    return this.lights;
  }
}

/**
 * A voxel sandbox, ported from the demo of the same name in Babylon Lite.
 *
 * **Credit and licence are in `CREDITS.md`, and the short form is this.** The original is the
 * Voxel Sandbox demo from `BabylonJS/Babylon-Lite`, Apache 2.0. What is ported is the design; none
 * of their code is in this tree, bundled, or published, and the reference sources are fetched on
 * demand into a gitignored `.reference/`. The block tiles are Kenney's Voxel Pack, CC0.
 *
 * **The port's argument is in what is missing.** The reference spends 351 lines on two
 * hand-written GLSL materials; this draws the same world with none. The atlas is an albedo map,
 * ambient occlusion is vertex colour the standard material multiplies into the texel, the haze is
 * the environment's own linear fog on the reference's two radii, and the chunks are scene nodes a
 * frustum prunes.
 *
 * Terrain, streaming, breaking and placing, a day-night cycle, water, mobs, saving and sound are
 * all here. What is not is in `GAPS.md`, each entry naming the smallest engine change that would
 * close it.
 */
import {
  ActionMap,
  BrowserFileDialogs,
  BrowserStore,
  Camera,
  DEFAULT_TEXT_STYLE,
  DEFAULT_RENDER_QUALITY,
  GpuDrivenPass,
  atmosphereFog,
  createFogTarget,
  textHeightPx,
  createRenderer,
  InputSource,
  TouchControls,
  LoadTracker,
  type Environment,
  type FogTarget,
  type PassHandle,
  type RenderBackend,
  type RenderQualityOptions,
  type RendererApi,
} from '../packages/core/src/index';

import { DEMO_BACKEND } from './backend';
import type { DemoBudget, DemoHandle, DemoScene, DemoSceneOptions, DemoStats } from './types';
import { VOXEL_ACTIONS } from './voxelSandbox/actions';
import { TILE_PX, buildBlockAtlas } from './voxelSandbox/atlas';
import type { BlockAtlas } from './voxelSandbox/atlas';
import { atlasProgram } from './voxelSandbox/atlasProgram';
import { allReferencedTiles } from './voxelSandbox/blocks';
import { ChunkRenderer } from './voxelSandbox/chunkRenderer';
import { FOV_Y_DEG } from './voxelSandbox/constants';
import { GpuDrivenChunks, capacityFor } from './voxelSandbox/gpuDrivenChunks';
import { Highlight } from './voxelSandbox/highlight';
import { Lighting } from './voxelSandbox/lighting';
import { Mobs } from './voxelSandbox/mobs';
import { Particles } from './voxelSandbox/particles';
import { FallingBlocks } from './voxelSandbox/fallingBlocks';
import { HotbarIcons } from './voxelSandbox/hotbarIcons';
import { Hud } from './voxelSandbox/hud';
import { Player } from './voxelSandbox/player';
import { Splash } from './voxelSandbox/splash';
import { VoxelAudio } from './voxelSandbox/audio';
import {
  autosave,
  loadFromFile,
  restore,
  saveToFile,
  type SaveData,
} from './voxelSandbox/saveLoad';
import {
  PORT_SHADOW_RADIUS,
  sandboxEnvironment,
  sandboxOptions,
  type SandboxOptions,
} from './voxelSandbox/sandboxOptions';
import { Sky } from './voxelSandbox/sky';
import { WaterSim } from './voxelSandbox/waterSim';
import { WaterSurface } from './voxelSandbox/waterSurface';
import { PlayerInput } from './voxelSandbox/playerInput';
import { World } from './voxelSandbox/world';

/*
 * The reference's own constants, copied exactly. They are what makes the two demos comparable:
 * point both at seed 1337 from the same place and the haze should fall off identically.
 */
const SEED = 1337;
const RENDER_RADIUS = 6;
/** How long one frame may spend building the spawn region while the badge is up. */
const WARM_SLICE_MS = 24;
/** How far above the spawn's ground `?fly=` holds the eye: clear of the trees and most hills. */
const FLY_ABOVE = 32;

/**
 * The second pipeline's stages, for the capture line under `?gputiming=1`: a comparison that says
 * the port is slower has to say where, and the pass times each of these on the device.
 */
const PORT_STAGES: readonly Parameters<GpuDrivenPass['stageTime']>[0][] = [
  'shadow',
  'instanceCull',
  'cut',
  'phaseOneDraw',
  'pyramid',
  'phaseTwoCull',
  'phaseTwoDraw',
  'blendCull',
  'blendDraw',
  'blendResolve',
  'bin',
  'shade',
];

/** Relative, so a host serves the tiles from its own root. See `showroom.ts` for the pattern. */
const PACK_URL = 'voxelpack';

/** The reference's mouse sensitivity, in radians per pixel. */
const LOOK_RAD_PER_PX = 0.0022;

/** Seconds in a full day. The reference's number, so `?time=` means the same thing in both. */
const DAY_LENGTH_SEC = 150;

const PROFILES: Readonly<Record<DemoBudget, RenderQualityOptions>> = {
  full: { sceneSamples: 4, water: false, waterReflections: false },
  lean: { sceneSamples: 1, water: false, waterReflections: false },
};

/** A handheld meshes a smaller world, because the budget is bandwidth rather than shader cost. */
const RADIUS_FOR: Readonly<Record<DemoBudget, number>> = { full: RENDER_RADIUS, lean: 4 };

/**
 * The terrain on the second pipeline: its scene, the pass that draws it, and the pass's handle.
 *
 * **Null on the forward path**, which is the default and the published capture.
 * `?pipeline=gpu-driven` builds one; everything that is not terrain — mobs, particles, falling
 * blocks, the highlight, the sky, the HUD — draws on the forward path whichever pipeline has the
 * terrain, behind or in front of it through the depth the pass hands the frame.
 */
interface GpuDrivenTerrain {
  readonly chunks: GpuDrivenChunks;
  readonly pass: GpuDrivenPass;
  readonly handle: PassHandle;
  /** Refilled every frame rather than rebuilt: the frame loop may not allocate. */
  readonly view: TerrainView;
}

/** `GpuDrivenView` with the fields a day-night clock and a walking camera change made writable. */
interface TerrainView {
  readonly viewProj: Float32Array;
  readonly eye: [number, number, number];
  lightDir: readonly [number, number, number];
  lightColour: readonly [number, number, number];
  ambient: readonly [number, number, number];
  ambientGround: readonly [number, number, number];
  readonly lodThreshold: number;
  fovY: number;
  readonly shadowStrength: number;
  emissiveGain: number;
  nightFactor: number;
  readonly fog: FogTarget;
}

class VoxelSandboxHandle implements DemoHandle {
  readonly backend: RenderBackend;

  private readonly renderer: RendererApi;
  private readonly canvas: HTMLCanvasElement;
  private readonly world: World;
  private readonly chunks: ChunkRenderer;
  private readonly input: InputSource;
  private readonly actions: ActionMap;
  private readonly touch: TouchControls | null;
  private readonly player: Player;
  private readonly playerInput: PlayerInput;
  private readonly highlight: Highlight;
  private readonly hud: Hud;
  private readonly hotbarIcons: HotbarIcons;
  private readonly lighting: Lighting;
  private readonly sky = new Sky();
  private readonly water: WaterSim;
  private readonly falling: FallingBlocks;
  private readonly particles: Particles;
  private readonly mobs: Mobs;
  private readonly audio = new VoxelAudio();
  private readonly dialogs = new BrowserFileDialogs();
  private readonly store = new BrowserStore();
  private busy = false;
  private stepDistance = 0;
  private lastFootX = 0;
  private lastFootZ = 0;
  private smoothedFps = 60;
  private readonly waterSurface: WaterSurface;
  private readonly camera = new Camera();
  private readonly env: Environment;
  private readonly options: SandboxOptions;
  private readonly terrain: GpuDrivenTerrain | null;
  private readonly underwaterMedium: boolean;

  /* Reused rather than rebuilt: `frame` runs sixty times a second. */
  private readonly stats: DemoStats = { draws: 0, gpuMs: 0 };
  /** The spawn region's size, and the badge drawn while it is built. See `frame`. */
  private readonly warmTotal: number;
  private readonly splash: Splash;
  private warmed = false;
  /** Seconds since the first frame, for the badge's own text animation clock. */
  private warmElapsed = 0;
  private lastGpuMs = 0;
  /** `?fly=`: where the flight began and how far it has gone. See `flyOn`. */
  private flightStart: [number, number, number] | null = null;
  private flown = 0;
  private disposed = false;

  constructor(
    renderer: RendererApi,
    backend: RenderBackend,
    canvas: HTMLCanvasElement,
    world: World,
    chunks: ChunkRenderer,
    atlas: BlockAtlas,
    spawn: { x: number; y: number; z: number },
    options: SandboxOptions,
    terrain: GpuDrivenTerrain | null,
    underwaterMedium: boolean,
  ) {
    this.renderer = renderer;
    this.backend = backend;
    this.canvas = canvas;
    this.world = world;
    this.chunks = chunks;
    this.options = options;
    this.terrain = terrain;
    this.underwaterMedium = underwaterMedium;

    /*
     * The engine's own input, rather than a set of listeners this file would otherwise grow:
     * keys, mouse deltas, pointer lock, touches and gamepads all arrive through one object, and
     * stage 2 builds its `ActionMap` on this same instance.
     */
    /*
     * The engine's own input rather than a set of listeners this file would otherwise grow: keys,
     * mouse deltas, pointer lock, touches and gamepads all arrive through one object, and
     * `ActionMap` decides which of them means what — so every binding lives in `actions.ts` and
     * a player could rebind them.
     */
    /* `KeyS` and `KeyO` are here for the chord rather than the walk: without them the browser
       takes Ctrl+S for its own save dialog and Ctrl+O for its file picker. */
    this.input = new InputSource(canvas, [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'KeyO',
      'Space',
      'Tab',
      'ShiftLeft',
    ]);
    this.actions = new ActionMap(this.input, VOXEL_ACTIONS);
    /*
     * Twin-stick on a phone, which the reference has no equivalent of.
     *
     * `TouchControls` asks for two elements and only ever writes `.hidden` and `.style` to them —
     * it reads touches from `input.target`, which is this canvas. So detached nodes satisfy it
     * and nothing is added to the page, which is what a scene is forbidden. The stick is
     * therefore invisible; drawing it is the HUD's job if it ever needs to be seen.
     */
    this.touch = this.input.isCoarse
      ? new TouchControls(this.input, document.createElement('div'), document.createElement('div'))
      : null;
    canvas.addEventListener('click', this.onClick);

    this.player = new Player(world, spawn);
    /* `?look=`, which a comparison capture uses to face something the spawn's view does not hold. */
    if (options.look !== null) {
      this.player.yaw = (options.look.yaw * Math.PI) / 180;
      this.player.pitch = (options.look.pitch * Math.PI) / 180;
    }
    /* What the splash divides by. Captured before a single chunk is built, because it is the
       size of the job rather than what is left of it. */
    this.warmTotal = chunks.pendingCount;
    this.splash = new Splash(renderer);
    this.highlight = new Highlight(renderer);
    this.hud = new Hud(renderer);
    this.hotbarIcons = new HotbarIcons(renderer, atlas);
    this.water = new WaterSim(world, chunks);
    this.waterSurface = new WaterSurface();
    this.falling = new FallingBlocks(renderer, world, chunks, atlas);
    this.particles = new Particles(renderer);
    this.mobs = new Mobs(renderer, world);
    this.mobs.populate(spawn.x, spawn.z);
    /* `?time=` points both demos at the same moment, which is what a comparison shot needs. */
    const asked = new URLSearchParams(location.search).get('time');
    this.lighting = new Lighting({
      dayLengthSec: DAY_LENGTH_SEC,
      startTimeOfDay: asked === null ? undefined : Number(asked),
    });
    this.playerInput = new PlayerInput(
      canvas,
      this.input,
      this.actions,
      this.player,
      world,
      chunks,
      this.highlight,
      this.touch,
    );
    this.camera.fovYDeg = FOV_Y_DEG;
    /*
     * **Both planes, and the pair is the point.**
     *
     * The default near of 0.4 is chosen for depth precision and documented as safe "because a
     * third-person boom never brings the eye closer than 0.9 m". A first-person body is 0.6 m
     * wide, so standing against a wall puts the eye 0.3 m from the face — inside that plane, and
     * the block clips away.
     *
     * Dropping near alone to 0.08 fixed that and broke something worse: `camera.ts` says
     * precision scales *linearly* with the near plane, and at 0.08 against the default far of 500
     * the ground under the player failed the depth test on WebGPU while WebGL2 tolerated it.
     * Measured as two captures of one frame, same camera, same 131 draws, one correct.
     *
     * So near comes down only as far as the body needs — 0.15, half the 0.3 m half-width — and
     * far comes in to match the world, which is 169 chunks across and fogged out at 91 m. The
     * ratio ends up better than the engine's own default rather than worse.
     */
    this.camera.near = 0.15;
    /* 220 unless `?radius=` pushes the haze past it; `sandboxOptions` says why. */
    this.camera.far = options.far;

    /*
     * Flood connected sub-sea air as each chunk activates, so a cave opening into the seabed is
     * never a dry pocket the player swims into.
     */
    chunks.onChunkActivated = (cx, cz) => this.water.settleChunk(cx, cz);
    this.playerInput.onEdit = (wx, wy, wz, broke, blockId) => {
      if (broke) {
        this.particles.burst(wx, wy, wz, blockId);
        this.audio.broke(blockId);
        this.water.onBreak(wx, wy, wz);
        this.falling.onBreak(wx, wy, wz);
      } else {
        this.audio.placed(blockId);
        this.water.onPlace(wx, wy, wz);
        this.falling.onPlace(wx, wy, wz);
      }
    };

    /* The reference's ramp on the radii the page asked for, and block light at a gain of one. */
    this.env = sandboxEnvironment(options);
  }

  private readonly onClick = (): void => {
    this.input.requestPointerLock();
    /* The same gesture: a browser will not start an audio context without one. */
    void this.audio.unlock();
    /* The controls line has served its purpose the moment somebody plays. */
    this.hud.hideHelp();
  };

  frame(dtSec: number): DemoStats {
    /*
     * **The spawn region is built here, a slice a frame, behind the engine's own badge.**
     *
     * It used to be one blocking call inside `mount`: about 170 chunks at roughly 30 ms each, so
     * five seconds in which the main thread never returned and the canvas held whatever it held.
     * Slicing it against a clock is what lets a bar be a bar, and doing that *here* rather than
     * in `mount` is what keeps the frame loop the host's. See the note at the end of `mount` for
     * what running one of our own cost on WebGPU.
     *
     * The simulation does not run while this does. A world half built is not a world to walk in,
     * and stepping physics through it would drop the player through terrain that has not arrived.
     */
    if (!this.warmed) {
      this.chunks.processQueue(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, WARM_SLICE_MS);
      this.warmElapsed += dtSec;

      if (this.chunks.pendingCount > 0) {
        const built = this.warmTotal - this.chunks.pendingCount;
        this.splash.draw(this.renderer, built / Math.max(1, this.warmTotal), this.warmElapsed);
        this.stats.draws = 0;
        this.stats.extra = `building the world: ${built} of ${this.warmTotal} chunks`;
        return this.stats;
      }

      /*
       * Re-check the spawn now the region is real.
       *
       * `findSpawn` ran in `mount` against a world that generates on demand, and a tree stamped
       * from a neighbouring chunk's margin can land on the column it chose, so the answer is
       * right when it is given and can be inside a trunk by the time anything is drawn. One
       * lookup, and it is the difference between standing on the ground and standing in a tree.
       */
      const settled = this.world.findSpawn(
        Math.floor(this.player.position[0]),
        Math.floor(this.player.position[2]),
      );
      this.player.placeAt(settled);
      this.warmed = true;
    }

    this.input.poll();
    this.playerInput.update(dtSec, LOOK_RAD_PER_PX);
    if (this.options.fly !== null) this.flyOn(this.options.fly, dtSec);
    this.highlight.update(dtSec);

    /* The camera is the body's eye, not a thing that moves on its own. */
    const p = this.player;
    this.camera.position[0] = p.position[0];
    this.camera.position[1] = p.eyeY();
    this.camera.position[2] = p.position[2];
    this.camera.yaw = p.yaw;
    this.camera.pitch = p.pitch;

    const height = this.canvas.height;
    this.camera.updateMatrices(height > 0 ? this.canvas.width / height : 1);

    this.chunks.update(this.camera.position[0]!, this.camera.position[2]!);
    this.chunks.processQueue();
    this.water.update(dtSec);
    this.falling.update(dtSec);
    this.particles.update(dtSec);
    this.mobs.update(dtSec, p.position[0], p.position[1], p.position[2]);
    this.footsteps(dtSec);
    this.audio.update(dtSec, this.underwater);
    this.saveActions();

    /*
     * One clock drives everything: sun, ambient, fog and the clear colour, so the horizon and
     * the haze are the same colour and terrain fades into sky rather than into a band.
     */
    this.lighting.tick(dtSec);
    const sky = this.lighting.snapshot();
    this.sky.update(dtSec, sky);
    const env = this.env;
    env.directionalDir = sky.sunDir;
    env.directionalColor = sky.sunColor;
    env.ambient = sky.ambientColor;
    env.fogColor = sky.fogColor;
    /* Emissive is gated on this. Block light does not appear at all while it is zero. */
    env.nightFactor = sky.nightFactor;

    const renderer = this.renderer;
    /*
     * **The medium before anything is drawn.** This ran after the terrain, so every forward draw
     * but the sky read the medium of the frame before — a lag of one frame at the surface, which no
     * held capture can see. The second pipeline takes its haze before `beginFrame`, so it would
     * have lagged too; deciding it here puts both pipelines and every draw on the same frame.
     */
    this.waterSurface.update(this.camera, env, this.world);
    const terrain = this.terrain;
    if (terrain !== null) this.aimTerrain(terrain);
    renderer.gpuTimer.beginFrame();
    renderer.beginFrame(sky.fogColor);
    renderer.gpuTimer.begin('rest');
    renderer.bindMeshPass(this.camera, this.env);
    /*
     * **The terrain first, on whichever pipeline draws it**, so everything after depth-tests
     * against it. On the second pipeline that is what `presentDepth` is for: the blit hands the
     * frame the terrain's depth, and a mob behind a hill is behind it.
     */
    const visit = terrain === null ? this.chunks.draw(this.camera) : null;
    if (terrain !== null) renderer.drawPass(terrain.handle);
    this.highlight.draw(this.camera, this.env);
    this.falling.draw(this.camera, env);
    this.mobs.draw(this.camera, env);
    this.particles.draw(this.camera, env);
    /* After the terrain and the water, so the sky only fills what nothing else covered. */
    this.sky.draw(renderer, this.camera, env);

    /* Before `endFrame`, always: an overlay issued after it survives on WebGL2 and vanishes on
       WebGPU, which reads as a broken HUD on one backend only. */
    this.hud.selected = this.playerInput.selected;
    if (this.actions.consumePress('toggleDebug')) this.hud.toggleDebug();
    /* Smoothed rather than instantaneous, or the figure is unreadable. */
    this.smoothedFps = this.smoothedFps * 0.9 + (1 / Math.max(dtSec, 1e-4)) * 0.1;
    this.hud.setFps(this.smoothedFps);
    this.hud.update(dtSec);
    this.hud.setDebug(this.readoutPosition(), this.readoutAim());
    /*
     * **CSS pixels, not the drawing buffer.** `fillPanel` and `drawText` lay out in the viewport's
     * own coordinates, and `canvas.width` is device pixels — the two agree only when the device
     * ratio is 1 and no resolution scaling is on. Sized from the buffer, the hotbar walked off the
     * bottom of an ultrawide display and the crosshair sat away from the centre, while looking
     * correct on the square-ish canvas it was written against.
     */
    this.hud.draw(renderer.cssWidth, renderer.cssHeight);
    /*
     * **After the HUD, which is what puts a tile inside its slot rather than behind it.**
     *
     * Nothing on the public surface puts a texture into a screen rectangle, so the tiles are
     * world geometry parented to the camera, projected onto the rectangles `hotbarLayout` states.
     * The HUD fills the bar's backing panel and the ring around the selected slot, and both would
     * bury a tile drawn before them — so the tiles go last and the ring reads as a border.
     */
    this.hotbarIcons.draw(this.camera, this.playerInput.selected);
    /* And the slot keys over the tiles, the one piece of the bar that follows them. */
    this.hud.drawSlotNumbers(renderer.cssWidth, renderer.cssHeight);
    renderer.gpuTimer.end();
    renderer.endFrame();
    renderer.gpuTimer.endFrame();

    const sample = renderer.gpuTimer.poll();
    if (sample !== null) this.lastGpuMs = sample.shadows + sample.reflection + sample.rest;

    if (visit !== null) {
      /* `visited` is exactly the number of `drawMesh` calls the walk made: a node is only handed
         to the visitor when it has geometry. */
      this.stats.draws = visit.visited;
      this.stats.gpuMs = this.lastGpuMs;
      /*
       * The pruned count, because "169 chunks" is a number a reader has no scale for until it
       * sits next to how many of them the frustum threw away without touching.
       */
      this.stats.extra = `${this.chunks.activeCount} chunks, ${visit.pruned} pruned`;
    } else if (terrain !== null) {
      /* The pass's two draws, and its own stages beside the rest of the frame's. */
      this.stats.draws = 2;
      this.stats.gpuMs = this.lastGpuMs + (terrain.pass.totalMs ?? 0);
      /*
       * **The refused count is on the line a capture prints**, because a chunk that did not fit is
       * a hole in the world and this is the one number that says the capacity is right.
       */
      /* Every stage that costs a twentieth of a millisecond or more, when the device timed them. */
      let stages = '';
      for (const stage of PORT_STAGES) {
        const ms = terrain.pass.stageTime(stage);
        if (ms !== null && ms >= 0.05) stages += ` · ${stage} ${ms.toFixed(2)}`;
      }
      this.stats.extra =
        `${this.chunks.activeCount} chunks on the second pipeline, ` +
        `${terrain.chunks.refused} refused, ${terrain.chunks.scene.liveClusters} clusters${stages}`;
    }
    return this.stats;
  }

  /**
   * Point the second pipeline at this frame: the camera, the clock's light, and the haze.
   *
   * **The haze is the forward path's own medium**, filled by `atmosphereFog` from the same
   * environment every forward draw in this frame binds, so the terrain and the mobs on it fade
   * alike and go under water together.
   */
  private aimTerrain(terrain: GpuDrivenTerrain): void {
    const view = terrain.view;
    const env = this.env;
    view.viewProj.set(this.camera.viewProjection);
    view.eye[0] = this.camera.position[0] as number;
    view.eye[1] = this.camera.position[1] as number;
    view.eye[2] = this.camera.position[2] as number;
    view.fovY = (this.camera.fovYDeg * Math.PI) / 180;
    view.lightDir = env.directionalDir;
    view.lightColour = env.directionalColor;
    view.ambient = env.ambient;
    /* The forward path's own default when the environment names no ground colour. */
    view.ambientGround = env.ambientGround ?? env.ambient;
    view.emissiveGain = env.emissiveGain;
    view.nightFactor = env.nightFactor;
    atmosphereFog(env, view.eye[1], this.underwaterMedium, view.fog);
    terrain.pass.resize(this.renderer.sceneWidth, this.renderer.sceneHeight);
    terrain.pass.setView(view);
  }

  /**
   * `?fly=`: along the heading at a fixed speed, a fixed height above where the flight began.
   *
   * **Placed rather than steered**, after the player's own step, so neither gravity nor a hill
   * can move it off the path: a measurement wants the same chunks streamed in the same order on
   * both pipelines, and a body that met a tree on one run and not the other would not give that.
   */
  private flyOn(speed: number, dtSec: number): void {
    const p = this.player;
    if (this.flightStart === null) {
      this.flightStart = [p.position[0], p.position[1] + FLY_ABOVE, p.position[2]];
    }
    this.flown += speed * dtSec;
    const [x, y, z] = this.flightStart;
    p.position[0] = x + Math.sin(p.yaw) * this.flown;
    p.position[1] = y;
    p.position[2] = z - Math.cos(p.yaw) * this.flown;
    p.vy = 0;
  }

  /** Whether the eye is in water. Read by the audio muffle and the underwater medium alike. */
  private get underwater(): boolean {
    const p = this.player;
    return this.waterSurface.submerged(this.world, p.position[0], p.eyeY(), p.position[2]);
  }

  /**
   * A footstep per couple of metres actually walked, rather than per unit of time.
   *
   * Timing them would make a player who walks into a wall keep making footsteps, which is the
   * reference's reason for accumulating distance too.
   */
  private footsteps(_dtSec: number): void {
    const p = this.player;
    if (!p.onGround) {
      this.stepDistance = 0;
      return;
    }
    const dx = p.position[0] - this.lastFootX;
    const dz = p.position[2] - this.lastFootZ;
    this.lastFootX = p.position[0];
    this.lastFootZ = p.position[2];
    this.stepDistance += Math.hypot(dx, dz);
    if (this.stepDistance < 2.2) return;
    this.stepDistance = 0;
    this.audio.footstep(
      this.world.getBlock(
        Math.floor(p.position[0]),
        Math.floor(p.position[1]) - 1,
        Math.floor(p.position[2]),
      ),
    );
  }

  /** Ctrl-free bindings, because every binding lives in `actions.ts`. */
  private saveActions(): void {
    if (this.busy) return;
    /*
     * **The press is always consumed, and acted on only with Control down.**
     *
     * `save` is bound to `KeyS`, which is also how a player walks backwards, so most presses
     * here are not a save. Leaving one unconsumed would queue it: the next time Control went
     * down the world would save from a keystroke made seconds earlier, somewhere else.
     */
    const chord = this.input.isDown('ControlLeft') || this.input.isDown('ControlRight');
    if (this.actions.consumePress('save') && chord) {
      this.busy = true;
      void saveToFile(this.dialogs, this.capture()).then((ok) => {
        this.hud.toast(ok ? 'world saved' : 'save cancelled');
        this.busy = false;
      });
      return;
    }
    if (this.actions.consumePress('load') && chord) {
      this.busy = true;
      void loadFromFile(this.dialogs).then((data) => {
        if (data !== null) {
          this.apply(data);
          this.hud.toast('world loaded');
        } else {
          this.hud.toast('load cancelled');
        }
        this.busy = false;
      });
    }
  }

  private capture(): SaveData {
    return {
      v: 1,
      seed: this.world.seed,
      time: this.lighting.time,
      player: this.player.getState(),
      edits: this.world.exportEdits(),
    };
  }

  /**
   * Put a saved world back.
   *
   * Everything derived is thrown away and rebuilt: the chunk meshes, the flood, the falling
   * blocks and the mobs all re-derive from the seed and the edits, which is exactly why none of
   * them is in the file.
   */
  private apply(data: SaveData): void {
    this.world.reset(data.seed, data.edits);
    this.chunks.reset();
    this.water.reset();
    this.falling.reset();
    this.mobs.reset();
    this.lighting.time = data.time;
    this.player.setState(data.player);
    this.chunks.update(data.player.x, data.player.z);
    this.water.prefill(this.regionAround(data.player.x, data.player.z));
    this.chunks.processQueue(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    this.mobs.populate(data.player.x, data.player.z);
    autosave(this.store, data);
  }

  private regionAround(x: number, z: number): [number, number][] {
    const ccx = Math.floor(x / 16);
    const ccz = Math.floor(z / 16);
    const out: [number, number][] = [];
    const radius = this.options.radius;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) out.push([ccx + dx, ccz + dz]);
    }
    return out;
  }

  private readoutPosition(): string {
    const p = this.player;
    const state = this.playerInput.isFlying ? 'flying' : p.onGround ? 'grounded' : 'airborne';
    return `xyz ${p.position[0].toFixed(1)} ${p.position[1].toFixed(1)} ${p.position[2].toFixed(1)}  ${state}`;
  }

  private readoutAim(): string {
    const aimed = this.playerInput.aimed;
    const at = aimed === null ? 'none' : `${aimed.bx} ${aimed.by} ${aimed.bz}`;
    const refused = this.terrain === null ? '' : `  refused ${this.terrain.chunks.refused}`;
    return `aim ${at}  chunks ${this.chunks.activeCount}${refused}  mobs ${this.mobs.count}  ${this.lighting.clockText()}`;
  }

  /** The host asks when its element changes; the drawing buffer is the scene's to set. */
  resize(): void {
    if (this.disposed) return;
    this.renderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.splash.dispose();
    this.canvas.removeEventListener('click', this.onClick);
    this.playerInput.dispose();
    this.audio.dispose();
    this.falling.dispose();
    this.particles.dispose();
    this.mobs.dispose();
    this.touch?.dispose();
    this.hud.dispose();
    this.hotbarIcons.dispose();
    this.highlight.dispose();
    this.input.dispose();
    this.chunks.dispose();
    if (this.terrain !== null) this.renderer.unregisterPass(this.terrain.handle);
    this.renderer.dispose();
  }
}

/**
 * The terrain on the second pipeline: the atlas as a program, a scene sized to the radius, and the
 * pass registered with the frame.
 *
 * **`presentDepth` is on**, because this is the consumer the flag was built for: everything that
 * is not terrain stays on the forward path and has to stand behind a hill. **And the map follows
 * the eye**, because a world is larger than any one map should stretch over; it is drawn only when
 * the page asks, `?portshadow=1`.
 */
function gpuDrivenTerrain(
  renderer: RendererApi,
  atlas: BlockAtlas,
  radius: number,
  shadowed: boolean,
): GpuDrivenTerrain {
  const chunks = new GpuDrivenChunks(
    capacityFor(radius),
    atlasProgram(atlas.pixels, atlas.width, atlas.height, TILE_PX),
  );
  const pass = new GpuDrivenPass(chunks.scene, chunks.materials, {
    presentDepth: true,
    followRadius: PORT_SHADOW_RADIUS,
  });
  const handle = renderer.registerPass(pass);
  const view: TerrainView = {
    viewProj: new Float32Array(16),
    eye: [0, 0, 0],
    lightDir: [0, 1, 0],
    lightColour: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    /* A chunk is one level of detail, so the threshold chooses nothing; the rigs' own number. */
    lodThreshold: 1.5,
    fovY: (FOV_Y_DEG * Math.PI) / 180,
    /*
     * **No sun shadow, because the forward sandbox draws none.** Nothing in this demo calls
     * `beginShadowPass`; its shade is the sky light and occlusion baked into the vertex colours,
     * which the port carries unchanged. A shadow here would be the port drawing a map the forward
     * path does not — which is what the first measurement of the two did, and what made the port
     * look seven times slower on the device than the forward path at the same radius. The page
     * can still ask for it, which is how the shadow stage is measured on a world.
     */
    shadowStrength: shadowed ? 1 : 0,
    emissiveGain: 1,
    nightFactor: 0,
    fog: createFogTarget(),
  };
  return { chunks, pass, handle, view };
}

export const voxelSandbox: DemoScene = {
  id: 'voxel-sandbox',
  title: 'Voxel sandbox',
  note: 'A port of the voxel sandbox from Babylon Lite, module for module. Terrain generated from a seed, meshed with culled faces and baked ambient occlusion, textured from one atlas, and streamed as scene nodes the frustum prunes, with no shader written for any of it. On WebGPU the same world draws on the GPU-driven pipeline too, every chunk clusters in one streaming scene and the whole terrain two draws.',
  /*
   * **Both, the forward path first**, because the same world drawn both ways is what the port is
   * for (the demos spec's §3.6) — and a host building its page from `SCENES` can offer the choice
   * only if the list says there is one.
   */
  pipelines: ['forward', 'gpu-driven'],
  async mount(
    canvas: HTMLCanvasElement,
    budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
    sceneOptions: DemoSceneOptions = {},
  ): Promise<DemoHandle> {
    /*
     * Read once, at mount: the host's choice or `?pipeline=` decides what is constructed, and
     * `?radius=` how much.
     */
    const options = sandboxOptions(location.search, RADIUS_FOR[budget], sceneOptions.pipeline);
    const quality: RenderQualityOptions = { ...PROFILES[budget], ...overrides };
    /*
     * **Both halves of the request**, as the GPU-driven rigs make it: the option refuses at boot on
     * a backend that cannot run the second pipeline, which is the message a reader should get
     * rather than a world with no terrain in it; the pass is what draws.
     */
    const created = await createRenderer(
      canvas,
      quality,
      options.pipeline === 'gpu-driven'
        ? { ...DEMO_BACKEND, pipeline: 'gpu-driven' }
        : DEMO_BACKEND,
    );
    const { renderer } = created;
    /* Pipelines compiled before the first frame rather than inside it; on WebGPU
       `createRenderPipeline` defers the shader to the first draw. Engine 1.4.2. */
    await renderer.ready();
    /*
     * **The drawing buffer is the scene's, and this one was not claiming it.**
     *
     * `DemoScene.mount` says so in as many words: `resize()` reads the element's own size and
     * applies the density and area caps, and a host that writes `canvas.width` instead means two
     * policies for one number. Every other scene calls this and this one never did, so wherever
     * the host did not happen to size the element the world was drawn into the HTML default of
     * 300 by 150 and stretched over the canvas. On this engine's own site that is a 1054 by 574
     * frame showing a 300 by 150 picture, which reads as the renderer being soft.
     *
     * Before the splash rather than after it, so the badge is drawn at the size it is shown at.
     */
    renderer.resize();

    const atlas = await buildBlockAtlas(
      renderer,
      PACK_URL,
      allReferencedTiles(),
      new LoadTracker(),
    );

    const world = new World(SEED);
    const radius = options.radius;
    const terrain =
      options.pipeline === 'gpu-driven'
        ? gpuDrivenTerrain(renderer, atlas, radius, options.portShadow)
        : null;
    /*
     * A count *and* a clock. The count is the ceiling on a quiet frame; the clock is what keeps
     * a boundary crossing — which queues the whole new edge of the ring at once — from spending
     * ninety milliseconds in one frame. See `ChunkRendererOptions.msPerFrame`.
     */
    const chunks = new ChunkRenderer(renderer, world, atlas, {
      radius,
      budgetPerFrame: 3,
      msPerFrame: 6,
      /* On the second pipeline a built chunk goes to its streaming scene, not to `createMesh`. */
      ...(terrain === null ? {} : { sink: terrain.chunks }),
    });
    const spawn = world.findSpawn(options.at?.x ?? 0, options.at?.z ?? 0);

    /*
     * Warm the spawn region before the first frame, as the reference's `warmAround` does, so the
     * world is solid on frame one instead of assembling itself in front of the camera.
     */
    chunks.update(spawn.x, spawn.z);
    /*
     * **The warm-up belongs to `frame`, and putting it here cost a session to learn.**
     *
     * Building the spawn region is seconds of work, so it was sliced against a clock and drawn
     * behind a splash from inside `mount`, with its own `requestAnimationFrame` loop. That is a
     * scene running a frame loop the host has not handed it, and the host is entitled to give up
     * on a mount that has not returned: this engine's own site remounts, so a second renderer
     * arrived on the same canvas while the first was still looping, and WebGPU refused the frame
     * in as many words — a texture "associated with [Device] and cannot be used with [Device]",
     * two devices for one canvas.
     *
     * So nothing is drawn before the handle exists. The queue is filled here and `frame` empties
     * it a slice at a time behind the splash, inside the loop the host owns.
     */
    return new VoxelSandboxHandle(
      renderer,
      created.backend,
      canvas,
      world,
      chunks,
      atlas,
      spawn,
      options,
      terrain,
      quality.underwaterAtmosphere ?? DEFAULT_RENDER_QUALITY.underwaterAtmosphere,
    );
  },
};
